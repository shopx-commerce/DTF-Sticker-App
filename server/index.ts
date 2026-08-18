// Must run before any other import — auth/storage/db read process.env at module load.
import "dotenv/config";

import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { configurePassport } from "./auth";
import { ensureCsrfCookie } from "./lib/csrf";
import { pool } from "./db";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}
if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set.");
}

const app = express();
const isProd = app.get("env") === "production";

// TLS terminates upstream (Replit) — trust proxy so req.secure/the cookie's secure flag reflect the real connection.
app.set("trust proxy", 1);

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: false, limit: '500mb' }));

const PgSession = connectPgSimple(session);
app.use(
  session({
    // Shares Drizzle's pool (server/db.ts) instead of opening a second one.
    store: new PgSession({
      pool,
      tableName: "sessions",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // Rolling: every request pushes expiry back out to 30 days — stays active = never expires.
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isProd,
      // "none" so the session survives inside the /embed iframe; requires secure, hence prod-only.
      sameSite: isProd ? "none" : "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days of inactivity before expiry
    },
  })
);

configurePassport();
app.use(passport.initialize());
app.use(passport.session());

// Global so the cookie exists before login; requireCsrf itself is scoped to /api/auth.
app.use(ensureCsrfCookie);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Server error:", err);
    res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = 5000;
  server.listen({
    port,
    host: "0.0.0.0",
  }, () => {
    log(`serving on port ${port}`);
  });
})();

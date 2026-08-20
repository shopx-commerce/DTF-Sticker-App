import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";

// Double-submit cookie CSRF check — needed because sameSite:"none" (for /embed) exposes state-changing routes.
export const CSRF_COOKIE = "csrf_token";
export const CSRF_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// No cookie-parser dependency for one lookup — this is the entire spec that matters here.
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

// Issues the cookie if missing — safe unconditionally, it's not a secret.
export function ensureCsrfCookie(req: Request, res: Response, next: NextFunction): void {
  if (!readCookie(req, CSRF_COOKIE)) {
    const token = randomBytes(32).toString("hex");
    const isProd = req.app.get("env") === "production";
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }
  next();
}

// Rejects any non-GET/HEAD/OPTIONS request whose header doesn't match its cookie.
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();

  const cookieToken = readCookie(req, CSRF_COOKIE);
  const headerToken = req.get(CSRF_HEADER);
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    res.status(403).json({ message: "Invalid or missing CSRF token" });
    return;
  }
  next();
}

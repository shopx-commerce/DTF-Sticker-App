import type { Express, Request } from "express";
import passport from "passport";
import { randomBytes, createHash } from "crypto";
import { storage } from "../storage";
import { hashPassword, isEmailVerificationRequired } from "../auth";
import { sendMail, isMailerConfigured } from "../lib/mailer";
import { checkRateLimit } from "../lib/rate-limit";
import { requireCsrf } from "../lib/csrf";
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  resendVerificationSchema,
  verifyEmailSchema,
  toPublicUser,
  type User,
  type AuthTokenKind,
} from "@shared/schema";

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function getClientIp(req: Request): string {
  return req.ip || "unknown";
}

// APP_URL optionally overrides the host (trust proxy already fixes up req.protocol/host).
function baseUrl(req: Request): string {
  return process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
}

interface AuthTokenEmailConfig {
  kind: AuthTokenKind;
  ttlMs: number;
  path: string;
  subject: string;
  logLabel: string;
  buildText: (link: string) => string;
  buildHtml: (link: string) => string;
}

// Shared shape behind sendVerificationEmail/sendResetEmail: delete any stale
// token of this kind, issue a fresh one, and email the link (or log it if
// the mailer isn't configured — the token is always created either way).
async function sendAuthTokenEmail(req: Request, user: User, config: AuthTokenEmailConfig): Promise<void> {
  await storage.deleteAuthTokensForUser(user.id, config.kind);
  const token = generateToken();
  await storage.createAuthToken({
    userId: user.id,
    tokenHash: hashToken(token),
    kind: config.kind,
    expiresAt: new Date(Date.now() + config.ttlMs),
  });
  const link = `${baseUrl(req)}${config.path}?token=${token}`;

  if (!isMailerConfigured()) {
    console.warn(`[auth] SENDGRID_API_KEY not set — ${config.logLabel} for ${user.email}:\n  ${link}`);
    return;
  }

  await sendMail({
    to: user.email,
    subject: config.subject,
    text: config.buildText(link),
    html: config.buildHtml(link),
  });
}

function sendVerificationEmail(req: Request, user: User): Promise<void> {
  return sendAuthTokenEmail(req, user, {
    kind: "verify_email",
    ttlMs: VERIFY_TOKEN_TTL_MS,
    path: "/verify-email",
    subject: "Verify your email",
    logLabel: "verification link",
    buildText: (link) => `Welcome! Verify your email by visiting: ${link}\n\nThis link expires in 24 hours.`,
    buildHtml: (link) => `<p>Welcome! Please verify your email address.</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
  });
}

function sendResetEmail(req: Request, user: User): Promise<void> {
  return sendAuthTokenEmail(req, user, {
    kind: "reset_password",
    ttlMs: RESET_TOKEN_TTL_MS,
    path: "/reset-password",
    subject: "Reset your password",
    logLabel: "reset link",
    buildText: (link) => `Reset your password by visiting: ${link}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email.`,
    buildHtml: (link) => `<p>Reset your password.</p><p><a href="${link}">Reset password</a></p><p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>`,
  });
}

export function registerAuthRoutes(app: Express): void {
  // Scoped here, not global — other endpoints use raw uploads without a CSRF header.
  app.use("/api/auth", requireCsrf);

  app.post("/api/auth/register", async (req, res) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      }

      if (!checkRateLimit(`register:${getClientIp(req)}`, 10, 15 * 60 * 1000)) {
        return res.status(429).json({ message: "Too many attempts. Please try again later." });
      }

      const { email, password, name } = parsed.data;

      // Same status + message on every branch — an existing vs. new account must be indistinguishable.
      const responseMessage = isEmailVerificationRequired()
        ? "If that email isn't already registered, check your inbox for a verification link."
        : "If that email isn't already registered, your account is ready — you can log in now.";

      const existing = await storage.getUserByEmail(email);
      if (existing) {
        return res.status(200).json({ message: responseMessage });
      }

      const passwordHash = await hashPassword(password);
      const user = await storage.createUser({ email, passwordHash, name });

      if (isEmailVerificationRequired()) {
        await sendVerificationEmail(req, user);
      } else {
        // REQUIRE_EMAIL_VERIFICATION=false — mark verified immediately rather than stuck forever.
        await storage.updateUser(user.id, { emailVerified: true });
      }
      res.status(200).json({ message: responseMessage });
    } catch (error) {
      console.error("[auth] register error:", error);
      res.status(500).json({ message: "Failed to create account" });
    }
  });

  // POST, not GET — keeps the token out of the query string, access logs, and Referer headers.
  app.post("/api/auth/verify", async (req, res) => {
    try {
      const parsed = verifyEmailSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Missing token" });
      const { token } = parsed.data;

      if (!checkRateLimit(`verify:${getClientIp(req)}`, 20, 15 * 60 * 1000)) {
        return res.status(429).json({ message: "Too many attempts. Please try again later." });
      }

      const tokenHash = hashToken(token);
      const record = await storage.getValidAuthToken(tokenHash, "verify_email");
      if (!record) {
        return res.status(400).json({ message: "This verification link is invalid or has expired." });
      }

      await storage.updateUser(record.userId, { emailVerified: true });
      await storage.consumeAuthToken(tokenHash);

      res.json({ message: "Email verified. You can now log in." });
    } catch (error) {
      console.error("[auth] verify error:", error);
      res.status(500).json({ message: "Failed to verify email" });
    }
  });

  app.post("/api/auth/resend-verification", async (req, res) => {
    try {
      const parsed = resendVerificationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid email" });
      }

      if (!checkRateLimit(`resend:${getClientIp(req)}:${parsed.data.email}`, 3, 15 * 60 * 1000)) {
        return res.status(429).json({ message: "Too many attempts. Please try again later." });
      }

      const user = await storage.getUserByEmail(parsed.data.email);
      if (user && !user.emailVerified) {
        await sendVerificationEmail(req, user);
      }
      // Same response regardless of whether the account exists or is already
      // verified — avoids leaking account state to an unauthenticated caller.
      res.json({ message: "If an unverified account exists for that email, a verification link has been sent." });
    } catch (error) {
      console.error("[auth] resend-verification error:", error);
      res.status(500).json({ message: "Failed to resend verification email" });
    }
  });

  app.post("/api/auth/login", (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
    }

    if (!checkRateLimit(`login:${getClientIp(req)}:${parsed.data.email}`, 10, 15 * 60 * 1000)) {
      return res.status(429).json({ message: "Too many attempts. Please try again later." });
    }

    passport.authenticate("local", (err: Error | null, user: User | false, info: { message?: string } | undefined) => {
      if (err) {
        console.error("[auth] login error:", err);
        return res.status(500).json({ message: "Failed to log in" });
      }
      if (!user) {
        return res.status(401).json({ message: info?.message || "Invalid email or password" });
      }
      req.login(user, (loginErr) => {
        if (loginErr) {
          console.error("[auth] session error:", loginErr);
          return res.status(500).json({ message: "Failed to log in" });
        }
        res.json({ user: toPublicUser(user) });
      });
    })(req, res, next);
  });

  app.post("/api/auth/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        console.error("[auth] logout error:", err);
        return res.status(500).json({ message: "Failed to log out" });
      }
      req.session.destroy(() => {
        res.clearCookie("connect.sid");
        res.json({ message: "Logged out" });
      });
    });
  });

  app.get("/api/auth/me", (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    res.json({ user: toPublicUser(req.user) });
  });

  app.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const parsed = forgotPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid email" });
      }

      if (!checkRateLimit(`forgot:${getClientIp(req)}:${parsed.data.email}`, 5, 15 * 60 * 1000)) {
        return res.status(429).json({ message: "Too many attempts. Please try again later." });
      }

      const user = await storage.getUserByEmail(parsed.data.email);
      if (user) {
        await sendResetEmail(req, user);
      }
      // Same response whether or not the account exists.
      res.json({ message: "If an account exists for that email, a reset link has been sent." });
    } catch (error) {
      console.error("[auth] forgot-password error:", error);
      res.status(500).json({ message: "Failed to process request" });
    }
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      }

      if (!checkRateLimit(`reset:${getClientIp(req)}`, 10, 15 * 60 * 1000)) {
        return res.status(429).json({ message: "Too many attempts. Please try again later." });
      }

      const tokenHash = hashToken(parsed.data.token);
      const record = await storage.getValidAuthToken(tokenHash, "reset_password");
      if (!record) {
        return res.status(400).json({ message: "This reset link is invalid or has expired." });
      }

      const passwordHash = await hashPassword(parsed.data.password);
      await storage.updateUser(record.userId, { passwordHash });
      await storage.consumeAuthToken(tokenHash);
      // Kills any session that predates this reset — otherwise a stolen/stale
      // session would survive the very recovery action meant to lock it out.
      await storage.deleteSessionsForUser(record.userId);

      res.json({ message: "Password updated. You can now log in." });
    } catch (error) {
      console.error("[auth] reset-password error:", error);
      res.status(500).json({ message: "Failed to reset password" });
    }
  });
}

import bcrypt from "bcryptjs";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import type { Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { ADMIN_ROLE, type User as AppUser } from "@shared/schema";

// Augment Express's User type with our own so `req.user` is typed as the
// real user record everywhere (routes, middleware) without manual casts.
declare global {
  namespace Express {
    interface User extends AppUser {}
  }
}

const SALT_ROUNDS = 12;

// Defaults to required; set REQUIRE_EMAIL_VERIFICATION=false while SendGrid isn't configured yet.
export function isEmailVerificationRequired(): boolean {
  return process.env.REQUIRE_EMAIL_VERIFICATION !== "false";
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  return bcrypt.compare(password, stored);
}

export function configurePassport(): void {
  passport.use(
    new LocalStrategy(
      { usernameField: "email", passwordField: "password" },
      async (email, password, done) => {
        try {
          const user = await storage.getUserByEmail(email.toLowerCase().trim());
          if (!user) return done(null, false, { message: "Invalid email or password" });

          const valid = await verifyPassword(password, user.passwordHash);
          if (!valid) return done(null, false, { message: "Invalid email or password" });

          if (isEmailVerificationRequired() && !user.emailVerified) {
            return done(null, false, { message: "Please verify your email before logging in" });
          }

          return done(null, user);
        } catch (err) {
          return done(err as Error);
        }
      }
    )
  );

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user ?? false);
    } catch (err) {
      done(err as Error);
    }
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: "Not authenticated" });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated() && req.user.role === ADMIN_ROLE) return next();
  res.status(403).json({ message: "Admin access required" });
}

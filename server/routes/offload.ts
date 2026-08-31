import { createHmac, timingSafeEqual } from "crypto";
import type { Express } from "express";
import { requireAuth } from "../auth";

// Short-lived HMAC job token for the VPS offload service — session-gated here, verified there against the same shared secret. Not a cookie: the VPS is a different origin, so cookie auth wouldn't survive third-party-cookie restrictions.
const TOKEN_TTL_MS = 5 * 60 * 1000;

function sign(expiresAtMs: number, secret: string): string {
  return createHmac("sha256", secret).update(String(expiresAtMs)).digest("hex");
}

export function registerOffloadRoutes(app: Express): void {
  app.get("/api/offload/token", requireAuth, (req, res) => {
    const secret = process.env.OFFLOAD_SECRET;
    if (!secret) {
      console.error("[offload] OFFLOAD_SECRET not configured");
      return res.status(503).json({ message: "Offload service not configured" });
    }
    const expiresAtMs = Date.now() + TOKEN_TTL_MS;
    const token = `${expiresAtMs}.${sign(expiresAtMs, secret)}`;
    res.json({ token, expiresAtMs });
  });
}

// Exported for tests / any future in-process check — not used by the VPS itself, which verifies independently.
export function verifyOffloadToken(token: string, secret: string): boolean {
  const [expiresAtStr, signature] = token.split(".");
  const expiresAtMs = Number(expiresAtStr);
  if (!expiresAtStr || !signature || !Number.isFinite(expiresAtMs)) return false;
  if (Date.now() > expiresAtMs) return false;
  const expected = sign(expiresAtMs, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

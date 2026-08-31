// Verifies the HMAC job token (`${expiresAtMs}.${hmacHex}`) issued by the main server — not the issuing side, that lives there.
import { createHmac, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const secret = process.env.OFFLOAD_SECRET;
if (!secret) {
  // Fail closed: never run with auth silently disabled.
  throw new Error('OFFLOAD_SECRET env var is required — refusing to start without it');
}

function sign(expiresAtMs: string): string {
  return createHmac('sha256', secret!).update(expiresAtMs).digest('hex');
}

export function verifyJobToken(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'missing bearer token' });

  const token = header.slice('Bearer '.length);
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) return res.status(401).json({ error: 'malformed token' });

  const expiresAtMs = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expected = sign(expiresAtMs);

  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const signatureOk = sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  if (!signatureOk) return res.status(401).json({ error: 'invalid signature' });

  if (Date.now() > Number(expiresAtMs)) return res.status(401).json({ error: 'token expired' });

  next();
}

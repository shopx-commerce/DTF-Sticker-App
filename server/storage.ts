import { db } from "./db";
import {
  users,
  authTokens,
  sessions,
  type User,
  type InsertUser,
  type AuthToken,
  type AuthTokenKind,
} from "@shared/schema";
import { eq, and, isNull, gt, sql } from "drizzle-orm";

export interface CreateAuthTokenParams {
  userId: number;
  tokenHash: string;
  kind: AuthTokenKind;
  expiresAt: Date;
}

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(
    id: number,
    updates: Partial<Pick<User, "name" | "passwordHash" | "emailVerified">>
  ): Promise<User | undefined>;

  createAuthToken(params: CreateAuthTokenParams): Promise<AuthToken>;
  getValidAuthToken(tokenHash: string, kind: AuthTokenKind): Promise<AuthToken | undefined>;
  consumeAuthToken(tokenHash: string): Promise<void>;
  deleteAuthTokensForUser(userId: number, kind: AuthTokenKind): Promise<void>;
  // Kills every other logged-in session for this user — used on password reset so a
  // stolen/stale session can't survive the very recovery action meant to lock it out.
  deleteSessionsForUser(userId: number): Promise<void>;
}

export class DbStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUser(
    id: number,
    updates: Partial<Pick<User, "name" | "passwordHash" | "emailVerified">>
  ): Promise<User | undefined> {
    const [user] = await db.update(users).set(updates).where(eq(users.id, id)).returning();
    return user;
  }

  async createAuthToken(params: CreateAuthTokenParams): Promise<AuthToken> {
    const [token] = await db.insert(authTokens).values(params).returning();
    return token;
  }

  async getValidAuthToken(tokenHash: string, kind: AuthTokenKind): Promise<AuthToken | undefined> {
    const [token] = await db
      .select()
      .from(authTokens)
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          eq(authTokens.kind, kind),
          isNull(authTokens.consumedAt),
          gt(authTokens.expiresAt, new Date())
        )
      );
    return token;
  }

  async consumeAuthToken(tokenHash: string): Promise<void> {
    await db.update(authTokens).set({ consumedAt: new Date() }).where(eq(authTokens.tokenHash, tokenHash));
  }

  async deleteAuthTokensForUser(userId: number, kind: AuthTokenKind): Promise<void> {
    await db.delete(authTokens).where(and(eq(authTokens.userId, userId), eq(authTokens.kind, kind)));
  }

  // connect-pg-simple stores passport's serialized user id at sess.passport.user —
  // no dedicated userId column on `sessions`, so this matches on that JSON path.
  async deleteSessionsForUser(userId: number): Promise<void> {
    await db.delete(sessions).where(sql`(${sessions.sess}->'passport'->>'user')::int = ${userId}`);
  }
}

export const storage = new DbStorage();

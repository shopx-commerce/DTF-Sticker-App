import { db } from "./db";
import {
  users,
  authTokens,
  sessions,
  assets,
  designs,
  gangSheets,
  type User,
  type InsertUser,
  type AuthToken,
  type AuthTokenKind,
  type Asset,
  type InsertAsset,
  type Design,
  type DesignListItem,
  type GangSheet,
} from "@shared/schema";
import type { SerializedDesign } from "@shared/design-document";
import { eq, and, isNull, gt, desc, sql } from "drizzle-orm";

export interface CreateAuthTokenParams {
  userId: number;
  tokenHash: string;
  kind: AuthTokenKind;
  expiresAt: Date;
}

export interface CreateDesignParams {
  userId: number;
  name: string;
  state: SerializedDesign;
  sourceAssetId?: number | null;
  thumbnailAssetId?: number | null;
  forkedFromId?: number | null;
}

export interface UpdateDesignParams {
  name?: string;
  state?: SerializedDesign;
  thumbnailAssetId?: number | null;
}

export interface CreateGangSheetParams {
  userId: number;
  name: string;
  pdfAssetId: number;
  thumbnailAssetId?: number | null;
  sheetWidth: number;
  sheetHeight: number;
  itemCount: number;
  totalQuantity: number;
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

  createAsset(params: InsertAsset): Promise<Asset>;
  getAssetForUser(id: number, userId: number): Promise<Asset | undefined>;

  listDesignsForUser(userId: number): Promise<DesignListItem[]>;
  createDesign(params: CreateDesignParams): Promise<Design>;
  getDesignForUser(id: number, userId: number): Promise<Design | undefined>;
  updateDesign(id: number, updates: UpdateDesignParams): Promise<Design | undefined>;
  softDeleteDesign(id: number): Promise<void>;

  createGangSheet(params: CreateGangSheetParams): Promise<GangSheet>;
  listGangSheetsForUser(userId: number): Promise<GangSheet[]>;
  getGangSheetForUser(id: number, userId: number): Promise<GangSheet | undefined>;
  softDeleteGangSheet(id: number): Promise<void>;
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

  async createAsset(params: InsertAsset): Promise<Asset> {
    const [asset] = await db.insert(assets).values(params).returning();
    return asset;
  }

  async getAssetForUser(id: number, userId: number): Promise<Asset | undefined> {
    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.userId, userId)));
    return asset;
  }

  async listDesignsForUser(userId: number): Promise<DesignListItem[]> {
    // Sorted by creation order, matching listGangSheetsForUser — one consistent sequence across both sections.
    // Column-limited — the list view never needs the (large) state JSONB.
    return db
      .select({ id: designs.id, name: designs.name, thumbnailAssetId: designs.thumbnailAssetId, updatedAt: designs.updatedAt })
      .from(designs)
      .where(and(eq(designs.userId, userId), isNull(designs.deletedAt)))
      .orderBy(desc(designs.createdAt));
  }

  async createDesign(params: CreateDesignParams): Promise<Design> {
    const [design] = await db.insert(designs).values(params).returning();
    return design;
  }

  // Ownership check is baked into the query itself, not a separate step.
  async getDesignForUser(id: number, userId: number): Promise<Design | undefined> {
    const [design] = await db
      .select()
      .from(designs)
      .where(and(eq(designs.id, id), eq(designs.userId, userId), isNull(designs.deletedAt)));
    return design;
  }

  async updateDesign(id: number, updates: UpdateDesignParams): Promise<Design | undefined> {
    const [design] = await db
      .update(designs)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(designs.id, id))
      .returning();
    return design;
  }

  async softDeleteDesign(id: number): Promise<void> {
    await db.update(designs).set({ deletedAt: new Date() }).where(eq(designs.id, id));
  }

  async createGangSheet(params: CreateGangSheetParams): Promise<GangSheet> {
    const [gangSheet] = await db.insert(gangSheets).values(params).returning();
    return gangSheet;
  }

  async listGangSheetsForUser(userId: number): Promise<GangSheet[]> {
    return db
      .select()
      .from(gangSheets)
      .where(and(eq(gangSheets.userId, userId), isNull(gangSheets.deletedAt)))
      .orderBy(desc(gangSheets.createdAt));
  }

  async getGangSheetForUser(id: number, userId: number): Promise<GangSheet | undefined> {
    const [gangSheet] = await db
      .select()
      .from(gangSheets)
      .where(and(eq(gangSheets.id, id), eq(gangSheets.userId, userId), isNull(gangSheets.deletedAt)));
    return gangSheet;
  }

  async softDeleteGangSheet(id: number): Promise<void> {
    await db.update(gangSheets).set({ deletedAt: new Date() }).where(eq(gangSheets.id, id));
  }
}

export const storage = new DbStorage();

import { db } from "./db";
import {
  users,
  authTokens,
  sessions,
  assets,
  designs,
  downloads,
  gangSheets,
  type User,
  type InsertUser,
  type AuthToken,
  type AuthTokenKind,
  type Asset,
  type InsertAsset,
  type Design,
  type DesignListItem,
  type InsertDownload,
  type GangSheet,
  type UserWithStats,
  type DesignWithOwner,
  type GangSheetWithOwner,
  type AdminStats,
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
  getAssetAny(id: number): Promise<Asset | undefined>;

  listDesignsForUser(userId: number): Promise<DesignListItem[]>;
  createDesign(params: CreateDesignParams): Promise<Design>;
  getDesignForUser(id: number, userId: number): Promise<Design | undefined>;
  updateDesign(id: number, updates: UpdateDesignParams): Promise<Design | undefined>;
  softDeleteDesign(id: number): Promise<void>;

  recordDownload(params: InsertDownload): Promise<void>;

  createGangSheet(params: CreateGangSheetParams): Promise<GangSheet>;
  listGangSheetsForUser(userId: number): Promise<GangSheet[]>;
  getGangSheetForUser(id: number, userId: number): Promise<GangSheet | undefined>;
  softDeleteGangSheet(id: number): Promise<void>;

  // Admin-only: unscoped by owner — gated by requireAdmin at the route layer, not here.
  listUsersWithStats(): Promise<UserWithStats[]>;
  listAllDesignsForAdmin(): Promise<DesignWithOwner[]>;
  getDesignAny(id: number): Promise<Design | undefined>;
  getDesignWithOwner(id: number): Promise<(Design & { ownerEmail: string }) | undefined>;
  getForkForUser(originalDesignId: number, userId: number): Promise<Design | undefined>;
  getAdminStats(): Promise<AdminStats>;
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

  // No ownership filter — admin-only, used to copy a design's files during fork.
  async getAssetAny(id: number): Promise<Asset | undefined> {
    const [asset] = await db.select().from(assets).where(eq(assets.id, id));
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

  async recordDownload(params: InsertDownload): Promise<void> {
    await db.insert(downloads).values(params);
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

  async listUsersWithStats(): Promise<UserWithStats[]> {
    return db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
        // DISTINCT avoids the two left joins multiplying against each other.
        designCount: sql<number>`count(distinct ${designs.id})`.mapWith(Number),
        downloadCount: sql<number>`count(distinct ${downloads.id})`.mapWith(Number),
      })
      .from(users)
      .leftJoin(designs, and(eq(designs.userId, users.id), isNull(designs.deletedAt)))
      .leftJoin(downloads, eq(downloads.userId, users.id))
      .groupBy(users.id)
      .orderBy(desc(users.createdAt));
  }

  async listAllDesignsForAdmin(): Promise<DesignWithOwner[]> {
    return db
      .select({
        id: designs.id,
        name: designs.name,
        userId: designs.userId,
        ownerEmail: users.email,
        thumbnailAssetId: designs.thumbnailAssetId,
        sourceAssetId: designs.sourceAssetId,
        forkedFromId: designs.forkedFromId,
        createdAt: designs.createdAt,
        updatedAt: designs.updatedAt,
      })
      .from(designs)
      .innerJoin(users, eq(designs.userId, users.id))
      .where(isNull(designs.deletedAt))
      .orderBy(desc(designs.updatedAt));
  }

  async listAllGangSheetsForAdmin(): Promise<GangSheetWithOwner[]> {
    return db
      .select({
        id: gangSheets.id,
        name: gangSheets.name,
        userId: gangSheets.userId,
        ownerEmail: users.email,
        pdfAssetId: gangSheets.pdfAssetId,
        thumbnailAssetId: gangSheets.thumbnailAssetId,
        sheetWidth: gangSheets.sheetWidth,
        sheetHeight: gangSheets.sheetHeight,
        itemCount: gangSheets.itemCount,
        totalQuantity: gangSheets.totalQuantity,
        createdAt: gangSheets.createdAt,
      })
      .from(gangSheets)
      .innerJoin(users, eq(gangSheets.userId, users.id))
      .where(isNull(gangSheets.deletedAt))
      .orderBy(desc(gangSheets.createdAt));
  }

  // No ownership filter — admin routes may inspect/fork any design; every call site is behind requireAdmin.
  async getDesignAny(id: number): Promise<Design | undefined> {
    const [design] = await db
      .select()
      .from(designs)
      .where(and(eq(designs.id, id), isNull(designs.deletedAt)));
    return design;
  }

  // Same as getDesignAny, plus the owner's email — for the admin's read-only design view.
  async getDesignWithOwner(id: number): Promise<(Design & { ownerEmail: string }) | undefined> {
    const [row] = await db
      .select({ design: designs, ownerEmail: users.email })
      .from(designs)
      .innerJoin(users, eq(designs.userId, users.id))
      .where(and(eq(designs.id, id), isNull(designs.deletedAt)));
    return row ? { ...row.design, ownerEmail: row.ownerEmail } : undefined;
  }

  // Makes "Edit as my own" idempotent — repeat forks reopen the same copy instead of duplicating.
  async getForkForUser(originalDesignId: number, userId: number): Promise<Design | undefined> {
    const [design] = await db
      .select()
      .from(designs)
      .where(and(eq(designs.forkedFromId, originalDesignId), eq(designs.userId, userId), isNull(designs.deletedAt)))
      .orderBy(desc(designs.createdAt))
      .limit(1);
    return design;
  }

  async getAdminStats(): Promise<AdminStats> {
    const [[userRow], [designRow], [gangSheetRow], [downloadRow]] = await Promise.all([
      db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(users),
      db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(designs).where(isNull(designs.deletedAt)),
      db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(gangSheets).where(isNull(gangSheets.deletedAt)),
      db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(downloads),
    ]);
    return {
      totalUsers: userRow.count,
      totalDesigns: designRow.count,
      totalGangSheets: gangSheetRow.count,
      totalDownloads: downloadRow.count,
    };
  }
}

export const storage = new DbStorage();

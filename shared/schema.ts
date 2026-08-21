import { pgTable, text, serial, integer, boolean, timestamp, jsonb, varchar, json, index, doublePrecision } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import type { SerializedDesign } from "./design-document";

// ─── Users ───────────────────────────────────────────────────────────────
// Not a DB enum, but $type<UserRole>() makes role comparisons compile-checked.
export const userRoles = ["customer", "admin"] as const;
export type UserRole = (typeof userRoles)[number];
export const CUSTOMER_ROLE: UserRole = "customer";
export const ADMIN_ROLE: UserRole = "admin";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  role: text("role").notNull().default(CUSTOMER_ROLE).$type<UserRole>(),
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  passwordHash: true,
  name: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Shape returned to the client — never leak passwordHash.
export type PublicUser = Omit<User, "passwordHash">;
export function toPublicUser(user: User): PublicUser {
  const { passwordHash, ...publicUser } = user;
  return publicUser;
}

// ─── Auth tokens ─────────────────────────────────────────────────────────
// Single-use tokens for email verification / password reset; only a SHA-256 hash is stored.
export const authTokenKinds = ["verify_email", "reset_password"] as const;
export type AuthTokenKind = (typeof authTokenKinds)[number];

export const authTokens = pgTable("auth_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // AuthTokenKind
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AuthToken = typeof authTokens.$inferSelect;

// Managed by connect-pg-simple, not the ORM — declared only so `db:push` doesn't treat it as drift and drop it.
export const sessions = pgTable("sessions", {
  sid: varchar("sid").primaryKey(),
  sess: json("sess").notNull(),
  expire: timestamp("expire", { precision: 6 }).notNull(),
}, (table) => [
  index("IDX_session_expire").on(table.expire),
]);

// ─── Assets — pointer + metadata row; bytes live in Cloudflare R2 (server/lib/object-storage.ts) ───
export const assetKinds = ["source_image", "source_pdf", "thumbnail", "gang_sheet_pdf"] as const;
export type AssetKind = (typeof assetKinds)[number];

export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  r2Key: text("r2_key").notNull(),
  kind: text("kind").notNull(), // AssetKind
  mime: text("mime").notNull(),
  bytes: integer("bytes").notNull(),
  width: integer("width"),
  height: integer("height"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Asset = typeof assets.$inferSelect;
export type InsertAsset = typeof assets.$inferInsert;

// ─── Designs — full editor state + asset pointers; forkedFromId tracks copies (Save as New / admin fork) ───
export const designs = pgTable("designs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  state: jsonb("state").$type<SerializedDesign>().notNull(),
  sourceAssetId: integer("source_asset_id").references(() => assets.id),
  thumbnailAssetId: integer("thumbnail_asset_id").references(() => assets.id),
  forkedFromId: integer("forked_from_id").references((): any => designs.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export type Design = typeof designs.$inferSelect;
export type InsertDesign = typeof designs.$inferInsert;

// Lean projection for list views — excludes the (potentially large) state JSONB.
export type DesignListItem = Pick<Design, "id" | "name" | "thumbnailAssetId" | "updatedAt">;

// ─── Gang Sheets — just a record of the finished PDF, not a re-editable layout ───
export const gangSheets = pgTable("gang_sheets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  pdfAssetId: integer("pdf_asset_id").notNull().references(() => assets.id),
  thumbnailAssetId: integer("thumbnail_asset_id").references(() => assets.id),
  sheetWidth: doublePrecision("sheet_width").notNull(),
  sheetHeight: doublePrecision("sheet_height").notNull(),
  itemCount: integer("item_count").notNull(), // distinct designs on the sheet
  totalQuantity: integer("total_quantity").notNull(), // total stickers across all items
  createdAt: timestamp("created_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export type GangSheet = typeof gangSheets.$inferSelect;
export type InsertGangSheet = typeof gangSheets.$inferInsert;

// ─── Downloads — one row per completed download; only recorded for signed-in users ───
export const downloadTypes = [
  "standard", "highres", "vector", "cutcontour", "design-only", "download-package", "gang-sheet",
] as const;
export type DownloadType = (typeof downloadTypes)[number];

export const downloads = pgTable("downloads", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Nullable: download doesn't require a saved design; survives as an orphaned row if deleted.
  designId: integer("design_id").references(() => designs.id, { onDelete: "set null" }),
  // Same idea for gang sheets — quick-download without saving is allowed.
  gangSheetId: integer("gang_sheet_id").references(() => gangSheets.id, { onDelete: "set null" }),
  downloadType: text("download_type").notNull(), // DownloadType
  format: text("format"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Download = typeof downloads.$inferSelect;
export type InsertDownload = typeof downloads.$inferInsert;

// ─── Request validation schemas ─────────────────────────────────────────

// Used by registration/reset only — login just checks against whatever hash is already stored.
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character");

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: passwordSchema,
  name: z.string().trim().min(1).max(200).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const resendVerificationSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;

export const recordDownloadSchema = z.object({
  designId: z.number().int().optional(),
  gangSheetId: z.number().int().optional(),
  downloadType: z.enum(downloadTypes),
  format: z.string().max(20).optional(),
});
export type RecordDownloadInput = z.infer<typeof recordDownloadSchema>;

export const createGangSheetSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  sheetWidth: z.number().positive(),
  sheetHeight: z.number().positive(),
  itemCount: z.number().int().nonnegative(),
  totalQuantity: z.number().int().nonnegative(),
});
export type CreateGangSheetInput = z.infer<typeof createGangSheetSchema>;

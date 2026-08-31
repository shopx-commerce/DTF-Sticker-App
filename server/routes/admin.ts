import type { Express } from "express";
import { nanoid } from "nanoid";
import { requireAdmin } from "../auth";
import { requireCsrf } from "../lib/csrf";
import { storage } from "../storage";
import { getObject, getObjectUrl, putObject } from "../lib/object-storage";
import { parseId } from "../lib/parse-id";
import type { Asset } from "@shared/schema";

// Re-uploads an asset under a new owner so a fork's assets pass the normal ownership check.
async function copyAssetToUser(assetId: number, newUserId: number): Promise<Asset> {
  const original = await storage.getAssetAny(assetId);
  if (!original) throw new Error(`Asset ${assetId} not found`);

  const { body, contentType } = await getObject(original.r2Key);
  const ext = original.r2Key.split(".").pop() || "bin";
  const key = `${newUserId}/${original.kind}/${nanoid()}.${ext}`;
  await putObject(key, body, contentType);

  return storage.createAsset({
    userId: newUserId,
    r2Key: key,
    kind: original.kind,
    mime: original.mime,
    bytes: original.bytes,
    width: original.width,
    height: original.height,
  });
}

export function registerAdminRoutes(app: Express): void {
  app.use("/api/admin", requireCsrf);

  app.get("/api/admin/stats", requireAdmin, async (req, res) => {
    try {
      const stats = await storage.getAdminStats();
      res.json({ stats });
    } catch (error) {
      console.error("[admin] stats error:", error);
      res.status(500).json({ message: "Failed to load stats" });
    }
  });

  app.get("/api/admin/users", requireAdmin, async (req, res) => {
    try {
      const users = await storage.listUsersWithStats();
      res.json({ users });
    } catch (error) {
      console.error("[admin] users error:", error);
      res.status(500).json({ message: "Failed to load users" });
    }
  });

  app.get("/api/admin/designs", requireAdmin, async (req, res) => {
    try {
      const designs = await storage.listAllDesignsForAdmin();
      res.json({ designs });
    } catch (error) {
      console.error("[admin] designs error:", error);
      res.status(500).json({ message: "Failed to load designs" });
    }
  });

  app.get("/api/admin/gang-sheets", requireAdmin, async (req, res) => {
    try {
      const gangSheets = await storage.listAllGangSheetsForAdmin();
      res.json({ gangSheets });
    } catch (error) {
      console.error("[admin] gang sheets error:", error);
      res.status(500).json({ message: "Failed to load gang sheets" });
    }
  });

  app.get("/api/admin/designs/:id", requireAdmin, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid design id" });

      const design = await storage.getDesignWithOwner(id);
      if (!design) return res.status(404).json({ message: "Design not found" });

      res.json({ design });
    } catch (error) {
      console.error("[admin] get design error:", error);
      res.status(500).json({ message: "Failed to load design" });
    }
  });

  // Unscoped equivalent of /api/assets/:id/url — the customer-facing route 404s on another user's
  // asset (ownership-scoped), which is what admin thumbnails/PDF views need to bypass. Safe since
  // GET-only + requireAdmin.
  app.get("/api/admin/assets/:id/url", requireAdmin, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid asset id" });

      const asset = await storage.getAssetAny(id);
      if (!asset) return res.status(404).json({ message: "Asset not found" });

      const url = await getObjectUrl(asset.r2Key);
      res.json({ url });
    } catch (error) {
      console.error("[admin] get asset url error:", error);
      res.status(500).json({ message: "Failed to get asset URL" });
    }
  });

  // Unscoped equivalent of /api/assets/:id/file for admin's read-only "View" — safe since GET-only + requireAdmin.
  app.get("/api/admin/assets/:id/file", requireAdmin, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid asset id" });

      const asset = await storage.getAssetAny(id);
      if (!asset) return res.status(404).json({ message: "Asset not found" });

      const { body, contentType } = await getObject(asset.r2Key);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(body);
    } catch (error) {
      console.error("[admin] get asset file error:", error);
      res.status(500).json({ message: "Failed to fetch asset file" });
    }
  });

  // "Edit as his own" — forks a design into the admin's account (original untouched); idempotent, reuses an existing fork instead of duplicating.
  app.post("/api/admin/designs/:id/fork", requireAdmin, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid design id" });

      const adminId = req.user!.id;

      const existingFork = await storage.getForkForUser(id, adminId);
      if (existingFork) {
        return res.json({ design: existingFork, reused: true });
      }

      const original = await storage.getDesignAny(id);
      if (!original) return res.status(404).json({ message: "Design not found" });

      const [sourceAssetId, thumbnailAssetId] = await Promise.all([
        original.sourceAssetId ? copyAssetToUser(original.sourceAssetId, adminId).then(a => a.id) : Promise.resolve(null),
        original.thumbnailAssetId ? copyAssetToUser(original.thumbnailAssetId, adminId).then(a => a.id) : Promise.resolve(null),
      ]);

      const requestedName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const name = requestedName || `${original.name} (admin copy)`;

      // Reopen reads state.source.assetId, not the sourceAssetId column — must rewrite it too.
      const state = sourceAssetId
        ? { ...original.state, source: { ...original.state.source, assetId: sourceAssetId } }
        : original.state;

      const forked = await storage.createDesign({
        userId: adminId,
        name,
        state,
        sourceAssetId,
        thumbnailAssetId,
        forkedFromId: original.id,
      });

      res.status(201).json({ design: forked });
    } catch (error) {
      console.error("[admin] fork error:", error);
      res.status(500).json({ message: "Failed to fork design" });
    }
  });
}

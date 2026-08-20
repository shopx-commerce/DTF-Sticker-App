import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { requireCsrf } from "../lib/csrf";
import { storage } from "../storage";
import { serializedDesignSchema } from "@shared/design-document";

const createDesignSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  state: serializedDesignSchema,
  sourceAssetId: z.number().int().optional(),
  thumbnailAssetId: z.number().int().optional(),
});

const updateDesignSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200).optional(),
  state: serializedDesignSchema.optional(),
  thumbnailAssetId: z.number().int().optional(),
});

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) ? id : null;
}

export function registerDesignRoutes(app: Express): void {
  app.use("/api/designs", requireCsrf);

  app.get("/api/designs", requireAuth, async (req, res) => {
    try {
      const designs = await storage.listDesignsForUser(req.user!.id);
      res.json({ designs });
    } catch (error) {
      console.error("[designs] list error:", error);
      res.status(500).json({ message: "Failed to load designs" });
    }
  });

  app.post("/api/designs", requireAuth, async (req, res) => {
    try {
      const parsed = createDesignSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const userId = req.user!.id;

      // An asset id in the body doesn't prove ownership — verify before linking it to this design.
      for (const assetId of [parsed.data.sourceAssetId, parsed.data.thumbnailAssetId]) {
        if (assetId !== undefined) {
          const asset = await storage.getAssetForUser(assetId, userId);
          if (!asset) return res.status(400).json({ message: "Referenced asset not found" });
        }
      }

      const design = await storage.createDesign({ userId, ...parsed.data });
      res.status(201).json({ design });
    } catch (error) {
      console.error("[designs] create error:", error);
      res.status(500).json({ message: "Failed to save design" });
    }
  });

  app.get("/api/designs/:id", requireAuth, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid design id" });

      const design = await storage.getDesignForUser(id, req.user!.id);
      if (!design) return res.status(404).json({ message: "Design not found" });

      res.json({ design });
    } catch (error) {
      console.error("[designs] get error:", error);
      res.status(500).json({ message: "Failed to load design" });
    }
  });

  app.patch("/api/designs/:id", requireAuth, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid design id" });

      const parsed = updateDesignSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const userId = req.user!.id;
      const existing = await storage.getDesignForUser(id, userId);
      if (!existing) return res.status(404).json({ message: "Design not found" });

      if (parsed.data.thumbnailAssetId !== undefined) {
        const asset = await storage.getAssetForUser(parsed.data.thumbnailAssetId, userId);
        if (!asset) return res.status(400).json({ message: "Referenced asset not found" });
      }

      const design = await storage.updateDesign(id, parsed.data);
      res.json({ design });
    } catch (error) {
      console.error("[designs] update error:", error);
      res.status(500).json({ message: "Failed to update design" });
    }
  });

  // "Save as New" — copies state into a fresh row; original is never mutated.
  app.post("/api/designs/:id/duplicate", requireAuth, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid design id" });

      const userId = req.user!.id;
      const existing = await storage.getDesignForUser(id, userId);
      if (!existing) return res.status(404).json({ message: "Design not found" });

      const requestedName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const name = requestedName || `${existing.name} (copy)`;

      const design = await storage.createDesign({
        userId,
        name,
        state: existing.state,
        sourceAssetId: existing.sourceAssetId,
        thumbnailAssetId: existing.thumbnailAssetId,
        forkedFromId: existing.id,
      });

      res.status(201).json({ design });
    } catch (error) {
      console.error("[designs] duplicate error:", error);
      res.status(500).json({ message: "Failed to duplicate design" });
    }
  });

  app.delete("/api/designs/:id", requireAuth, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid design id" });

      const existing = await storage.getDesignForUser(id, req.user!.id);
      if (!existing) return res.status(404).json({ message: "Design not found" });

      await storage.softDeleteDesign(id);
      res.json({ message: "Design deleted" });
    } catch (error) {
      console.error("[designs] delete error:", error);
      res.status(500).json({ message: "Failed to delete design" });
    }
  });
}

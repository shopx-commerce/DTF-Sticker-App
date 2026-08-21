import type { Express } from "express";
import { requireAuth } from "../auth";
import { requireCsrf } from "../lib/csrf";
import { storage } from "../storage";
import { recordDownloadSchema } from "@shared/schema";

export function registerDownloadRoutes(app: Express): void {
  app.use("/api/downloads", requireCsrf);

  // Fire-and-forget from the client, called only after a download succeeds; anonymous downloads aren't tracked.
  app.post("/api/downloads", requireAuth, async (req, res) => {
    try {
      const parsed = recordDownloadSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const userId = req.user!.id;

      // designId/gangSheetId don't prove ownership — verify, and drop rather than fail if they don't check out.
      let designId: number | undefined;
      if (parsed.data.designId !== undefined) {
        const design = await storage.getDesignForUser(parsed.data.designId, userId);
        designId = design?.id;
      }
      let gangSheetId: number | undefined;
      if (parsed.data.gangSheetId !== undefined) {
        const gangSheet = await storage.getGangSheetForUser(parsed.data.gangSheetId, userId);
        gangSheetId = gangSheet?.id;
      }

      await storage.recordDownload({
        userId,
        designId: designId ?? null,
        gangSheetId: gangSheetId ?? null,
        downloadType: parsed.data.downloadType,
        format: parsed.data.format ?? null,
      });

      res.status(201).json({ message: "Recorded" });
    } catch (error) {
      console.error("[downloads] record error:", error);
      res.status(500).json({ message: "Failed to record download" });
    }
  });
}

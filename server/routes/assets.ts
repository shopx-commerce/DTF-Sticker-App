import type { Express } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { requireAuth } from "../auth";
import { requireCsrf } from "../lib/csrf";
import { storage } from "../storage";
import { putObject, getObjectUrl, getObject, MAX_UPLOAD_BYTES } from "../lib/object-storage";
import type { AssetKind } from "@shared/schema";

// Separate multer instance from server/routes.ts's PNG-only one — saved designs also need JPEG/PDF.
const ALLOWED_MIME: Record<string, AssetKind> = {
  "image/png": "source_image",
  "image/jpeg": "source_image",
  "application/pdf": "source_pdf",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.mimetype in ALLOWED_MIME) cb(null, true);
    else cb(new Error("Only PNG, JPEG, or PDF files are allowed"));
  },
});

function extForMime(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/jpeg") return "jpg";
  return "png";
}

export function registerAssetRoutes(app: Express): void {
  app.use("/api/assets", requireCsrf);

  app.post("/api/assets", requireAuth, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file provided" });
      const userId = req.user!.id;

      // `kind` lets the caller mark a PNG upload as a thumbnail (mime alone can't distinguish them).
      const requestedKind = typeof req.body.kind === "string" ? req.body.kind : undefined;
      const kind: AssetKind =
        requestedKind === "thumbnail" ? "thumbnail" : ALLOWED_MIME[req.file.mimetype];

      const key = `${userId}/${kind}/${nanoid()}.${extForMime(req.file.mimetype)}`;
      await putObject(key, req.file.buffer, req.file.mimetype);

      const width = req.body.width ? parseInt(req.body.width, 10) : undefined;
      const height = req.body.height ? parseInt(req.body.height, 10) : undefined;

      const asset = await storage.createAsset({
        userId,
        r2Key: key,
        kind,
        mime: req.file.mimetype,
        bytes: req.file.size,
        width: Number.isFinite(width) ? (width as number) : null,
        height: Number.isFinite(height) ? (height as number) : null,
      });

      res.status(201).json({ asset });
    } catch (error) {
      console.error("[assets] upload error:", error);
      res.status(500).json({ message: "Failed to upload asset" });
    }
  });

  // Fresh signed URL for an owned asset — expires, so the client re-requests each time.
  app.get("/api/assets/:id/url", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid asset id" });

      const asset = await storage.getAssetForUser(id, req.user!.id);
      if (!asset) return res.status(404).json({ message: "Asset not found" });

      const url = await getObjectUrl(asset.r2Key);
      res.json({ url });
    } catch (error) {
      console.error("[assets] get url error:", error);
      res.status(500).json({ message: "Failed to get asset URL" });
    }
  });

  // Same-origin proxy for the real file bytes — sidesteps R2's missing CORS headers.
  app.get("/api/assets/:id/file", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid asset id" });

      const asset = await storage.getAssetForUser(id, req.user!.id);
      if (!asset) return res.status(404).json({ message: "Asset not found" });

      const { body, contentType } = await getObject(asset.r2Key);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(body);
    } catch (error) {
      console.error("[assets] get file error:", error);
      res.status(500).json({ message: "Failed to fetch asset file" });
    }
  });
}

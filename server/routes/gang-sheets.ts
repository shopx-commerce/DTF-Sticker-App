import type { Express } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { requireAuth } from "../auth";
import { requireCsrf } from "../lib/csrf";
import { storage } from "../storage";
import { putObject, MAX_UPLOAD_BYTES } from "../lib/object-storage";
import { createGangSheetSchema } from "@shared/schema";
import { parseId } from "../lib/parse-id";

// Accepts the already-generated PDF (+ optional thumbnail); no regeneration logic lives here.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "pdf" && file.mimetype === "application/pdf") return cb(null, true);
    if (file.fieldname === "thumbnail" && file.mimetype === "image/png") return cb(null, true);
    cb(new Error("Unexpected file"));
  },
});

export function registerGangSheetRoutes(app: Express): void {
  app.use("/api/gang-sheets", requireCsrf);

  app.post(
    "/api/gang-sheets",
    requireAuth,
    upload.fields([{ name: "pdf", maxCount: 1 }, { name: "thumbnail", maxCount: 1 }]),
    async (req, res) => {
      try {
        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        const pdfFile = files?.pdf?.[0];
        if (!pdfFile) return res.status(400).json({ message: "No PDF file provided" });

        const parsed = createGangSheetSchema.safeParse({
          name: req.body.name,
          sheetWidth: req.body.sheetWidth ? Number(req.body.sheetWidth) : undefined,
          sheetHeight: req.body.sheetHeight ? Number(req.body.sheetHeight) : undefined,
          itemCount: req.body.itemCount ? Number(req.body.itemCount) : undefined,
          totalQuantity: req.body.totalQuantity ? Number(req.body.totalQuantity) : undefined,
        });
        if (!parsed.success) {
          return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
        }

        const userId = req.user!.id;

        const pdfKey = `${userId}/gang_sheet_pdf/${nanoid()}.pdf`;
        await putObject(pdfKey, pdfFile.buffer, pdfFile.mimetype);
        const pdfAsset = await storage.createAsset({
          userId,
          r2Key: pdfKey,
          kind: "gang_sheet_pdf",
          mime: pdfFile.mimetype,
          bytes: pdfFile.size,
          width: null,
          height: null,
        });

        let thumbnailAssetId: number | null = null;
        const thumbnailFile = files?.thumbnail?.[0];
        if (thumbnailFile) {
          const thumbKey = `${userId}/thumbnail/${nanoid()}.png`;
          await putObject(thumbKey, thumbnailFile.buffer, thumbnailFile.mimetype);
          const thumbAsset = await storage.createAsset({
            userId,
            r2Key: thumbKey,
            kind: "thumbnail",
            mime: thumbnailFile.mimetype,
            bytes: thumbnailFile.size,
            width: null,
            height: null,
          });
          thumbnailAssetId = thumbAsset.id;
        }

        const gangSheet = await storage.createGangSheet({
          userId,
          name: parsed.data.name,
          pdfAssetId: pdfAsset.id,
          thumbnailAssetId,
          sheetWidth: parsed.data.sheetWidth,
          sheetHeight: parsed.data.sheetHeight,
          itemCount: parsed.data.itemCount,
          totalQuantity: parsed.data.totalQuantity,
        });

        res.status(201).json({ gangSheet });
      } catch (error) {
        console.error("[gang-sheets] create error:", error);
        res.status(500).json({ message: "Failed to save gang sheet" });
      }
    }
  );

  app.get("/api/gang-sheets", requireAuth, async (req, res) => {
    try {
      const gangSheets = await storage.listGangSheetsForUser(req.user!.id);
      res.json({ gangSheets });
    } catch (error) {
      console.error("[gang-sheets] list error:", error);
      res.status(500).json({ message: "Failed to load gang sheets" });
    }
  });

  app.delete("/api/gang-sheets/:id", requireAuth, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid gang sheet id" });

      const existing = await storage.getGangSheetForUser(id, req.user!.id);
      if (!existing) return res.status(404).json({ message: "Gang sheet not found" });

      await storage.softDeleteGangSheet(id);
      res.json({ message: "Gang sheet deleted" });
    } catch (error) {
      console.error("[gang-sheets] delete error:", error);
      res.status(500).json({ message: "Failed to delete gang sheet" });
    }
  });

  // Re-download reuses GET /api/assets/:id/file with the gang sheet's pdfAssetId — no new endpoint.
}

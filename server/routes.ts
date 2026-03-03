import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import Replicate from "replicate";

import sgMail from "@sendgrid/mail";

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('Only PNG files are allowed'));
    }
  },
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Process image with high-quality stroke and resize
  app.post("/api/process-image", upload.single('image'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const {
        strokeWidth = 5,
        strokeColor = "#ffffff",
        enableStroke = true,
        widthInches = 5,
        heightInches = 4,
        outputDPI = 300,
      } = req.body;

      // Calculate output dimensions in pixels
      const outputWidth = Math.round(parseFloat(widthInches) * parseInt(outputDPI));
      const outputHeight = Math.round(parseFloat(heightInches) * parseInt(outputDPI));

      let imageBuffer = req.file.buffer;

      // Resize image
      const resizedImage = await sharp(imageBuffer)
        .resize(outputWidth, outputHeight, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }, // Transparent background
        })
        .png()
        .toBuffer();

      // Add stroke if enabled
      if (enableStroke && parseInt(strokeWidth) > 0) {
        const strokeWidthPx = Math.round(parseInt(strokeWidth) * (parseInt(outputDPI) / 72)); // Convert to high-res pixels
        
        // Create stroke effect using Sharp's extend and composite operations
        const strokeBuffer = await sharp(resizedImage)
          .extend({
            top: strokeWidthPx,
            bottom: strokeWidthPx,
            left: strokeWidthPx,
            right: strokeWidthPx,
            background: strokeColor
          })
          .composite([
            {
              input: resizedImage,
              top: strokeWidthPx,
              left: strokeWidthPx,
            }
          ])
          .png()
          .toBuffer();

        imageBuffer = strokeBuffer;
      } else {
        imageBuffer = resizedImage;
      }

      // Set appropriate headers
      res.set({
        'Content-Type': 'image/png',
        'Content-Disposition': 'attachment; filename="processed-sticker.png"',
        'Content-Length': imageBuffer.length.toString(),
      });

      res.send(imageBuffer);
    } catch (error) {
      console.error("Image processing error:", error);
      res.status(500).json({ 
        error: "Failed to process image", 
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });

  // Get image metadata
  app.post("/api/image-info", upload.single('image'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const metadata = await sharp(req.file.buffer).metadata();
      
      res.json({
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        channels: metadata.channels,
        density: metadata.density || 72,
        size: req.file.size,
      });
    } catch (error) {
      console.error("Metadata extraction error:", error);
      res.status(500).json({ 
        error: "Failed to extract image metadata", 
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });

  // Send design submission to sales email
  app.post("/api/send-design", upload.none(), async (req, res) => {
    try {
      const { customerName, customerEmail, customerNotes, pdfData, fileName } = req.body;

      if (!customerName || !customerEmail) {
        return res.status(400).json({ error: "Name and email are required" });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(customerEmail)) {
        return res.status(400).json({ error: "Invalid email format" });
      }

      const sendGridApiKey = process.env.SENDGRID_API_KEY;
      
      if (!sendGridApiKey) {
        console.error("SendGrid API key not configured");
        return res.status(500).json({ error: "Email service not configured" });
      }

      sgMail.setApiKey(sendGridApiKey);

      // Prepare email content
      const notesSection = customerNotes ? `\nCustomer Notes:\n${customerNotes}\n` : "";
      const emailContent = `
New Design Submission

Customer Details:
- Full Name: ${customerName}
- Email: ${customerEmail}
- File Name: ${fileName || "Not provided"}
- Submission Time: ${new Date().toLocaleString()}
${notesSection}
The customer has confirmed that the cutline looks good and is ready to proceed with this design.
`;

      const htmlNotesSection = customerNotes 
        ? `<h3>Customer Notes:</h3><p style="background-color: #f3f4f6; padding: 12px; border-radius: 6px; white-space: pre-wrap;">${customerNotes}</p>` 
        : "";
      const htmlContent = `
<h2>New Design Submission</h2>

<h3>Customer Details:</h3>
<ul>
  <li><strong>Full Name:</strong> ${customerName}</li>
  <li><strong>Email:</strong> <a href="mailto:${customerEmail}">${customerEmail}</a></li>
  <li><strong>File Name:</strong> ${fileName || "Not provided"}</li>
  <li><strong>Submission Time:</strong> ${new Date().toLocaleString()}</li>
</ul>

${htmlNotesSection}

<p>The customer has confirmed that the cutline looks good and is ready to proceed with this design.</p>

${pdfData ? '<p><strong>PDF design with CutContour is attached.</strong></p>' : '<p><em>No design file was attached.</em></p>'}
`;

      // Build email message
      const msg: sgMail.MailDataRequired = {
        to: "sales@dtfmasters.com",
        from: "sales@dtfmasters.com",
        subject: `New Sticker Design Submission from ${customerName}`,
        text: emailContent,
        html: htmlContent,
      };

      // If there's PDF data, attach it
      if (pdfData) {
        msg.attachments = [
          {
            content: pdfData,
            filename: fileName || "design.pdf",
            type: "application/pdf",
            disposition: "attachment",
          },
        ];
      }

      await sgMail.send(msg);

      res.json({ success: true, message: "Design sent successfully" });
    } catch (error) {
      console.error("Email sending error:", error);
      res.status(500).json({
        error: "Failed to send design",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/api/download-pipeline", (req, res) => {
    const filePath = "client/src/components/preview-section.tsx";
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "File not found: preview-section.tsx" });
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=preview-section.tsx");
    res.sendFile(fullPath);
  });

  app.get("/download", (_req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Download Preview Section</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #16213e; border-radius: 12px; padding: 40px; max-width: 500px; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
    h1 { color: #e94560; margin-bottom: 8px; }
    p { color: #a0a0b0; line-height: 1.6; }
    .files { text-align: left; background: #0f3460; border-radius: 8px; padding: 16px; margin: 20px 0; font-family: monospace; font-size: 14px; }
    .files div { padding: 4px 0; color: #e0e0e0; }
    .btn { display: inline-block; background: #e94560; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-size: 16px; font-weight: 600; transition: background 0.2s; cursor: pointer; border: none; }
    .btn:hover { background: #c73a52; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Preview Section</h1>
    <p>Download the preview-section.tsx component source file.</p>
    <div class="files">
      <div>preview-section.tsx (1406 lines)</div>
    </div>
    <a href="/api/download-pipeline" class="btn">Download File</a>
  </div>
</body>
</html>`);
  });

  // AI image segmentation using Florence-2 for detection + bounding-box masks
  app.post("/api/segment-image", upload.single('image'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const apiToken = process.env.REPLICATE_API_TOKEN;
      if (!apiToken) {
        console.error("Replicate API token not configured");
        return res.status(500).json({ error: "AI segmentation service not configured. Set REPLICATE_API_TOKEN environment variable." });
      }

      const replicate = new Replicate({ auth: apiToken });

      const base64 = req.file.buffer.toString('base64');
      const dataUri = `data:image/png;base64,${base64}`;

      const metadata = await sharp(req.file.buffer).metadata();
      const imgWidth = metadata.width || 1;
      const imgHeight = metadata.height || 1;
      const totalPixels = imgWidth * imgHeight;

      // Florence-2: run Object Detection + OCR with Region in parallel
      console.log("[Segment] Running Florence-2 detection...");
      const florence2 = "lucataco/florence-2-large:da53547e17d45b9cfb48174b2f18af8b83ca020fa76db62136bf9c6616762595";
      const [odRaw, ocrRaw] = await Promise.all([
        replicate.run(florence2, { input: { image: dataUri, task_input: "Object Detection" } }),
        replicate.run(florence2, { input: { image: dataUri, task_input: "OCR with Region" } }),
      ]);

      // Florence-2 returns {img, text} where text is a Python-dict string
      function extractText(raw: any): string {
        if (typeof raw === 'string') return raw;
        if (raw && typeof raw === 'object' && typeof raw.text === 'string') return raw.text;
        return JSON.stringify(raw);
      }

      function parsePyDict(s: string): any {
        try { return JSON.parse(s.replace(/'/g, '"')); }
        catch { return null; }
      }

      console.log("[Segment] OD raw:", extractText(odRaw).slice(0, 300));
      console.log("[Segment] OCR raw:", extractText(ocrRaw).slice(0, 300));

      // --- Parse Object Detection: extract labels + bounding boxes ---
      interface DetectedItem {
        label: string;
        bbox: { x1: number; y1: number; x2: number; y2: number };
      }
      const detectedItems: DetectedItem[] = [];

      try {
        const odStr = extractText(odRaw);
        const odDict = parsePyDict(odStr);
        const odData = odDict?.['<OD>'] || odDict;
        if (odData?.labels && odData?.bboxes) {
          const labels: string[] = odData.labels;
          const bboxes: number[][] = odData.bboxes;
          for (let i = 0; i < labels.length; i++) {
            const bb = bboxes[i];
            if (bb && bb.length >= 4) {
              detectedItems.push({
                label: String(labels[i]).trim(),
                bbox: { x1: Math.round(bb[0]), y1: Math.round(bb[1]), x2: Math.round(bb[2]), y2: Math.round(bb[3]) },
              });
            }
          }
        }
        // Fallback: regex
        if (detectedItems.length === 0) {
          const labelsMatch = odStr.match(/'labels':\s*\[([^\]]+)\]/);
          const bboxesMatch = odStr.match(/'bboxes':\s*(\[\[[\d.,\s\[\]e+-]+\]\])/);
          if (labelsMatch && bboxesMatch) {
            const labels = (labelsMatch[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));
            try {
              const bboxes = JSON.parse(bboxesMatch[1]);
              for (let i = 0; i < labels.length; i++) {
                const bb = bboxes[i];
                if (bb && bb.length >= 4) {
                  detectedItems.push({
                    label: labels[i].trim(),
                    bbox: { x1: Math.round(bb[0]), y1: Math.round(bb[1]), x2: Math.round(bb[2]), y2: Math.round(bb[3]) },
                  });
                }
              }
            } catch {}
          }
        }
      } catch (e) {
        console.warn("[Segment] Failed to parse OD:", e);
      }
      console.log("[Segment] Detected objects:", detectedItems.map(d => d.label));

      // --- Parse OCR: extract text labels + quad boxes ---
      interface TextItem {
        label: string;
        quad: number[];
      }
      const textItems: TextItem[] = [];

      try {
        const ocrStr = extractText(ocrRaw);
        const ocrDict = parsePyDict(ocrStr);
        const ocrData = ocrDict?.['<OCR_WITH_REGION>'] || ocrDict;
        if (ocrData?.labels && ocrData?.quad_boxes) {
          for (let i = 0; i < ocrData.labels.length; i++) {
            const lbl = String(ocrData.labels[i]).trim();
            const quad = ocrData.quad_boxes[i];
            if (lbl && quad && quad.length >= 8) {
              textItems.push({ label: lbl, quad });
            }
          }
        }
        // Fallback: regex
        if (textItems.length === 0) {
          const labelsMatch = ocrStr.match(/'labels':\s*\[([^\]]+)\]/);
          const quadMatch = ocrStr.match(/'quad_boxes':\s*(\[\[[\d.,\s\[\]e+-]+\]\])/);
          if (labelsMatch && quadMatch) {
            const labels = (labelsMatch[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));
            try {
              const quads = JSON.parse(quadMatch[1]);
              for (let i = 0; i < labels.length; i++) {
                if (quads[i] && quads[i].length >= 8) {
                  textItems.push({ label: labels[i].trim(), quad: quads[i] });
                }
              }
            } catch {}
          }
        }
      } catch (e) {
        console.warn("[Segment] Failed to parse OCR:", e);
      }
      console.log("[Segment] Detected text items:", textItems.map(t => t.label));

      if (detectedItems.length === 0 && textItems.length === 0) {
        console.log("[Segment] Nothing detected");
        return res.json({ layers: [] });
      }

      // --- Build pixel-accurate masks using Otsu adaptive thresholding ---
      const LAYER_COLORS = [
        '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
        '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
        '#BB8FCE', '#85C1E9', '#F0B27A', '#82E0AA',
      ];

      const { data: imgPixels, info: imgInfo } = await sharp(req.file!.buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const ch = imgInfo.channels;

      // Otsu's method: finds the optimal threshold that maximizes between-class variance
      function otsuThreshold(histogram: number[], total: number): number {
        let sum = 0;
        for (let i = 0; i < 256; i++) sum += i * histogram[i];

        let sumB = 0, wB = 0, wF = 0;
        let maxVariance = 0, bestThresh = 128;

        for (let t = 0; t < 256; t++) {
          wB += histogram[t];
          if (wB === 0) continue;
          wF = total - wB;
          if (wF === 0) break;

          sumB += t * histogram[t];
          const mB = sumB / wB;
          const mF = (sum - sumB) / wF;
          const variance = wB * wF * (mB - mF) * (mB - mF);
          if (variance > maxVariance) {
            maxVariance = variance;
            bestThresh = t;
          }
        }
        return bestThresh;
      }

      // Extracts foreground pixels using per-region Otsu thresholding on the
      // color distance from the sampled background.
      function extractForegroundMask(
        x1: number, y1: number, x2: number, y2: number
      ): { maskRGBA: Buffer; opaqueCount: number } {
        const cx1 = Math.max(0, Math.round(x1));
        const cy1 = Math.max(0, Math.round(y1));
        const cx2 = Math.min(imgWidth, Math.round(x2));
        const cy2 = Math.min(imgHeight, Math.round(y2));

        const mask = Buffer.alloc(imgWidth * imgHeight * 4, 0);

        // Sample border pixels (with 2px inset to avoid edge artifacts)
        let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
        const pad = 2;
        const sx1 = cx1 + pad, sy1 = cy1 + pad;
        const sx2 = cx2 - pad, sy2 = cy2 - pad;

        const sampleBorder = (sx: number, sy: number) => {
          if (sx >= 0 && sx < imgWidth && sy >= 0 && sy < imgHeight) {
            const idx = (sy * imgWidth + sx) * ch;
            if (imgPixels[idx + 3] > 128) {
              bgR += imgPixels[idx];
              bgG += imgPixels[idx + 1];
              bgB += imgPixels[idx + 2];
              bgCount++;
            }
          }
        };
        for (let x = sx1; x < sx2; x++) { sampleBorder(x, sy1); sampleBorder(x, sy2); }
        for (let y = sy1; y < sy2; y++) { sampleBorder(sx1, y); sampleBorder(sx2, y); }

        if (bgCount > 0) {
          bgR = Math.round(bgR / bgCount);
          bgG = Math.round(bgG / bgCount);
          bgB = Math.round(bgB / bgCount);
        } else {
          bgR = bgG = bgB = 255;
        }

        // Compute distance-from-background for every pixel, build histogram
        const regionW = cx2 - cx1;
        const regionH = cy2 - cy1;
        const distMap = new Uint8Array(regionW * regionH);
        const histogram = new Array(256).fill(0);
        let pixelCount = 0;

        for (let y = cy1; y < cy2; y++) {
          for (let x = cx1; x < cx2; x++) {
            const srcIdx = (y * imgWidth + x) * ch;
            if (imgPixels[srcIdx + 3] < 30) continue;

            const dr = imgPixels[srcIdx] - bgR;
            const dg = imgPixels[srcIdx + 1] - bgG;
            const db = imgPixels[srcIdx + 2] - bgB;
            // Euclidean distance, clamped to 0-255
            const dist = Math.min(255, Math.round(Math.sqrt(dr * dr + dg * dg + db * db)));

            const localIdx = (y - cy1) * regionW + (x - cx1);
            distMap[localIdx] = dist;
            histogram[dist]++;
            pixelCount++;
          }
        }

        // Find optimal threshold via Otsu on the distance histogram
        let thresh = otsuThreshold(histogram, pixelCount);
        // Ensure a minimum threshold so noise doesn't get picked up
        thresh = Math.max(thresh, 30);

        let opaqueCount = 0;
        for (let y = cy1; y < cy2; y++) {
          for (let x = cx1; x < cx2; x++) {
            const localIdx = (y - cy1) * regionW + (x - cx1);
            if (distMap[localIdx] > thresh) {
              const dstIdx = (y * imgWidth + x) * 4;
              mask[dstIdx] = 255;
              mask[dstIdx + 1] = 255;
              mask[dstIdx + 2] = 255;
              mask[dstIdx + 3] = 255;
              opaqueCount++;
            }
          }
        }

        return { maskRGBA: mask, opaqueCount };
      }

      const layers: any[] = [];
      let layerIdx = 0;

      // Skip object detections that cover >70% of the image (too generic)
      const meaningfulObjects = detectedItems.filter(item => {
        const { x1, y1, x2, y2 } = item.bbox;
        const bboxArea = Math.max(x2 - x1, 1) * Math.max(y2 - y1, 1);
        const coverage = bboxArea / totalPixels;
        if (coverage > 0.7) {
          console.log(`[Segment] Skipping "${item.label}" (${(coverage * 100).toFixed(0)}% coverage -- too generic)`);
          return false;
        }
        return true;
      });

      // Create layers for detected objects
      for (const item of meaningfulObjects) {
        const { x1, y1, x2, y2 } = item.bbox;
        const { maskRGBA, opaqueCount } = extractForegroundMask(x1, y1, x2, y2);

        const maskBuf = await sharp(maskRGBA, { raw: { width: imgWidth, height: imgHeight, channels: 4 } })
          .png()
          .toBuffer();

        const maskDataUrl = `data:image/png;base64,${maskBuf.toString('base64')}`;
        const area = (opaqueCount / totalPixels) * 100;
        const w = Math.max(x2 - x1, 1);
        const h = Math.max(y2 - y1, 1);

        layers.push({
          id: `segment-${layerIdx}`,
          label: item.label.charAt(0).toUpperCase() + item.label.slice(1),
          maskDataUrl,
          color: LAYER_COLORS[layerIdx % LAYER_COLORS.length],
          visible: true,
          area: parseFloat(area.toFixed(1)),
          boundingBox: { x: Math.round(x1), y: Math.round(y1), width: Math.round(w), height: Math.round(h) },
        });
        layerIdx++;
      }

      // Create layers for each detected text region
      for (const item of textItems) {
        if (item.label === '</s>' || item.label.length < 2) continue;
        const xs = [item.quad[0], item.quad[2], item.quad[4], item.quad[6]];
        const ys = [item.quad[1], item.quad[3], item.quad[5], item.quad[7]];
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);

        const { maskRGBA, opaqueCount } = extractForegroundMask(minX, minY, maxX, maxY);

        const maskBuf = await sharp(maskRGBA, { raw: { width: imgWidth, height: imgHeight, channels: 4 } })
          .png()
          .toBuffer();

        const maskDataUrl = `data:image/png;base64,${maskBuf.toString('base64')}`;
        const area = (opaqueCount / totalPixels) * 100;
        const w = Math.max(maxX - minX, 1);
        const h = Math.max(maxY - minY, 1);

        layers.push({
          id: `segment-${layerIdx}`,
          label: `Text: ${item.label}`,
          maskDataUrl,
          color: LAYER_COLORS[layerIdx % LAYER_COLORS.length],
          visible: true,
          area: parseFloat(area.toFixed(1)),
          boundingBox: { x: Math.round(minX), y: Math.round(minY), width: Math.round(w), height: Math.round(h) },
        });
        layerIdx++;
      }

      const filteredLayers = layers
        .filter(l => l.area > 0.1)
        .sort((a, b) => b.area - a.area);

      console.log("[Segment] Done!", filteredLayers.length, "layers:", filteredLayers.map(l => `${l.label} (${l.area}%)`));
      res.json({ layers: filteredLayers });
    } catch (error) {
      console.error("Segmentation error:", error);
      res.status(500).json({
        error: "Failed to segment image",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Image Enhancement using Sharp Lanczos3 upscaling
  app.post("/api/enhance-image", upload.single('image'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const start = Date.now();
      const metadata = await sharp(req.file.buffer).metadata();
      const imgWidth = metadata.width || 1;
      const imgHeight = metadata.height || 1;

      const scale = 2;
      const longestSide = Math.max(imgWidth, imgHeight);
      const effectiveScale = longestSide * scale > 8000 ? Math.max(1, Math.floor(8000 / longestSide)) : scale;
      if (effectiveScale < 2) {
        return res.status(400).json({ error: "Image is already very large. Enhancement would exceed size limits." });
      }

      const outWidth = Math.round(imgWidth * effectiveScale);
      const outHeight = Math.round(imgHeight * effectiveScale);

      console.log(`[Enhance] Starting Sharp upscale: ${imgWidth}x${imgHeight} → ${outWidth}x${outHeight} (${effectiveScale}x)`);

      const pngBuffer = await sharp(req.file.buffer)
        .resize(outWidth, outHeight, {
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: false,
        })
        .sharpen({ sigma: 0.8, m1: 1.0, m2: 0.5 })
        .png()
        .toBuffer();

      const elapsed = Date.now() - start;
      console.log(`[Enhance] Done in ${elapsed}ms! ${imgWidth}x${imgHeight} → ${outWidth}x${outHeight}`);

      res.set('Content-Type', 'image/png');
      res.set('X-Enhanced-Width', String(outWidth));
      res.set('X-Enhanced-Height', String(outHeight));
      res.set('X-Original-Width', String(imgWidth));
      res.set('X-Original-Height', String(imgHeight));
      res.send(pngBuffer);
    } catch (error) {
      console.error("[Enhance] Error:", error);
      res.status(500).json({
        error: "Failed to enhance image",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

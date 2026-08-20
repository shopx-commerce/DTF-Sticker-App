import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import sharp from "sharp";
import Replicate from "replicate";
import jsQR from "jsqr";
import { scanImageData as zbarScanImageData, ZBarSymbolType } from "@undecaf/zbar-wasm";
import { readBarcodes } from "zxing-wasm";

import sgMail from "@sendgrid/mail";
import { registerAuthRoutes } from "./routes/auth";

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

  registerAuthRoutes(app);

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

  // Server-side QR detection — comprehensive multi-engine, multi-variant
  // pipeline. Engines: ZBar (C library, strongest on stylized/occluded QRs)
  // + jsQR (pure JS, catches crisp synthetic codes ZBar misses).
  // Preprocessing variants cover: raw, Otsu, per-channel (R/G/B isolation
  // for coloured modules), multiple fixed thresholds, local adaptive
  // thresholding, contrast stretch, multiple logo-erase radii, rotations,
  // and a 2× upscale pass for small QRs.
  app.post("/api/detect-qr", upload.single('image'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No image provided" });

      const metadata = await sharp(req.file.buffer).metadata();
      const srcW = metadata.width ?? 1;
      const srcH = metadata.height ?? 1;

      // ── Helpers ─────────────────────────────────────────────────────────

      interface QRResult {
        payload: string;
        bbox: { x: number; y: number; width: number; height: number };
        corners: { topLeft: {x:number;y:number}; topRight: {x:number;y:number}; bottomLeft: {x:number;y:number}; bottomRight: {x:number;y:number} };
        source: string;
      }
      const results: QRResult[] = [];
      const seen = new Set<string>();

      function addResult(payload: string, loc: { topLeftCorner:{x:number;y:number}; topRightCorner:{x:number;y:number}; bottomLeftCorner:{x:number;y:number}; bottomRightCorner:{x:number;y:number} }, upscale: number, src: string) {
        if (seen.has(payload)) return;
        seen.add(payload);
        const xs = [loc.topLeftCorner.x, loc.topRightCorner.x, loc.bottomLeftCorner.x, loc.bottomRightCorner.x];
        const ys = [loc.topLeftCorner.y, loc.topRightCorner.y, loc.bottomLeftCorner.y, loc.bottomRightCorner.y];
        results.push({
          payload,
          bbox: { x: Math.min(...xs)*upscale, y: Math.min(...ys)*upscale, width: (Math.max(...xs)-Math.min(...xs))*upscale, height: (Math.max(...ys)-Math.min(...ys))*upscale },
          corners: {
            topLeft:     { x: loc.topLeftCorner.x*upscale,     y: loc.topLeftCorner.y*upscale },
            topRight:    { x: loc.topRightCorner.x*upscale,    y: loc.topRightCorner.y*upscale },
            bottomLeft:  { x: loc.bottomLeftCorner.x*upscale,  y: loc.bottomLeftCorner.y*upscale },
            bottomRight: { x: loc.bottomRightCorner.x*upscale, y: loc.bottomRightCorner.y*upscale },
          },
          source: src,
        });
      }

      // jsQR scan — tries up to 6 times masking found QRs each pass
      function scanWithJsQR(rgba: Uint8ClampedArray, w: number, h: number, upscale: number, label: string) {
        const working = new Uint8ClampedArray(rgba);
        for (let i = 0; i < 6; i++) {
          const r = jsQR(working, w, h, { inversionAttempts: 'attemptBoth' });
          if (!r) break;
          addResult(r.data, r.location, upscale, `server-jsqr:${label}`);
          // Mask found region to white so next pass finds a different QR
          const loc = r.location;
          const x0 = Math.max(0, Math.floor(Math.min(loc.topLeftCorner.x, loc.bottomLeftCorner.x)));
          const y0 = Math.max(0, Math.floor(Math.min(loc.topLeftCorner.y, loc.topRightCorner.y)));
          const x1 = Math.min(w, Math.ceil(Math.max(loc.topRightCorner.x, loc.bottomRightCorner.x)));
          const y1 = Math.min(h, Math.ceil(Math.max(loc.bottomLeftCorner.y, loc.bottomRightCorner.y)));
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const idx = (y * w + x) * 4;
            working[idx]=255; working[idx+1]=255; working[idx+2]=255; working[idx+3]=255;
          }
        }
      }

      // ZBar scan — single pass, returns all symbols found
      async function scanWithZBar(rgba: Uint8ClampedArray, w: number, h: number, upscale: number, label: string) {
        try {
          const imageDataLike = { data: rgba, width: w, height: h };
          const symbols = await zbarScanImageData(imageDataLike as ImageData);
          for (const sym of symbols) {
            if (sym.type !== ZBarSymbolType.ZBAR_QRCODE) continue;
            const payload = sym.decode();
            const pts = sym.points;
            if (pts.length < 4) continue;
            const sorted = [...pts].sort((a,b) => a.y - b.y);
            const top = sorted.slice(0,2).sort((a,b) => a.x-b.x);
            const bot = sorted.slice(2,4).sort((a,b) => a.x-b.x);
            addResult(payload, {
              topLeftCorner: top[0], topRightCorner: top[1],
              bottomLeftCorner: bot[0], bottomRightCorner: bot[1],
            }, upscale, `server-zbar:${label}`);
            console.log(`[QR server] ZBar HIT on variant "${label}" — payload: ${payload.slice(0,60)}`);
          }
        } catch(e) {
          console.warn(`[QR server] ZBar threw on "${label}":`, String(e).slice(0,120));
        }
      }

      // ZXing — the same C++ engine phone cameras use; strongest on stylised/
      // logo-embedded QRs with heavy occlusion or non-standard module shapes.
      async function scanWithZXing(rgba: Uint8ClampedArray, w: number, h: number, upscale: number, label: string) {
        try {
          const results = await readBarcodes(
            { data: rgba, width: w, height: h },
            { formats: ['QRCode'], tryHarder: true, tryInvert: true, maxNumberOfSymbols: 8 }
          );
          for (const r of results) {
            if (!r.text) continue;
            const p = r.position;
            if (!p) continue;
            addResult(r.text, {
              topLeftCorner:     { x: p.topLeft.x,     y: p.topLeft.y },
              topRightCorner:    { x: p.topRight.x,    y: p.topRight.y },
              bottomLeftCorner:  { x: p.bottomLeft.x,  y: p.bottomLeft.y },
              bottomRightCorner: { x: p.bottomRight.x, y: p.bottomRight.y },
            }, upscale, `server-zxing:${label}`);
            console.log(`[QR server] ZXing HIT on variant "${label}" — payload: ${r.text.slice(0,60)}`);
          }
        } catch(e) {
          console.warn(`[QR server] ZXing threw on "${label}":`, String(e).slice(0,120));
        }
      }

      // Run all three engines on one buffer and log the attempt
      async function runEngines(rgba: Uint8ClampedArray, w: number, h: number, upscale: number, label: string) {
        console.log(`[QR server] Trying variant "${label}" (${w}×${h})`);
        scanWithJsQR(rgba, w, h, upscale, label);
        await scanWithZBar(rgba, w, h, upscale, label);
        await scanWithZXing(rgba, w, h, upscale, label);
      }

      // ── Preprocessing helpers ────────────────────────────────────────────

      function compositeWhite(raw: Buffer): Uint8ClampedArray {
        const out = new Uint8ClampedArray(raw.length);
        for (let i = 0; i < raw.length; i += 4) {
          const a = raw[i+3] / 255;
          out[i]   = (raw[i]   * a + 255 * (1-a)) | 0;
          out[i+1] = (raw[i+1] * a + 255 * (1-a)) | 0;
          out[i+2] = (raw[i+2] * a + 255 * (1-a)) | 0;
          out[i+3] = 255;
        }
        return out;
      }

      // Black background composite — essential when the design has a dark/black
      // background (like this sticker: bg=rgb(4,5,4)). Compositing against white
      // turns transparent dark pixels bright and can destroy dark-module contrast.
      function compositeBlack(raw: Buffer): Uint8ClampedArray {
        const out = new Uint8ClampedArray(raw.length);
        for (let i = 0; i < raw.length; i += 4) {
          const a = raw[i+3] / 255;
          out[i]   = (raw[i]   * a) | 0;
          out[i+1] = (raw[i+1] * a) | 0;
          out[i+2] = (raw[i+2] * a) | 0;
          out[i+3] = 255;
        }
        return out;
      }

      // Gamma boost — raises dark midtones so low-contrast QR modules
      // (e.g. dark maroon on near-black background) become clearly visible.
      function gammaBoost(rgba: Uint8ClampedArray, gamma: number): Uint8ClampedArray {
        const lut = new Uint8Array(256);
        for (let i = 0; i < 256; i++) lut[i] = (Math.pow(i/255, gamma) * 255 + 0.5) | 0;
        const out = new Uint8ClampedArray(rgba.length);
        for (let i = 0; i < rgba.length; i += 4) {
          out[i]   = lut[rgba[i]];
          out[i+1] = lut[rgba[i+1]];
          out[i+2] = lut[rgba[i+2]];
          out[i+3] = 255;
        }
        return out;
      }

      function toLuma(rgba: Uint8ClampedArray): Uint8Array {
        const luma = new Uint8Array(rgba.length / 4);
        for (let i = 0, j = 0; i < rgba.length; i += 4, j++)
          luma[j] = (0.299*rgba[i] + 0.587*rgba[i+1] + 0.114*rgba[i+2]) | 0;
        return luma;
      }

      function otsuThreshold(luma: Uint8Array): number {
        const hist = new Int32Array(256);
        for (const v of luma) hist[v]++;
        const n = luma.length;
        let sumAll = 0; for (let i=0;i<256;i++) sumAll += i*hist[i];
        let sumB=0,wB=0,maxVar=0,t=128;
        for (let i=0;i<256;i++) {
          wB+=hist[i]; if(!wB) continue;
          const wF=n-wB; if(!wF) break;
          sumB+=i*hist[i];
          const mB=sumB/wB, mF=(sumAll-sumB)/wF;
          const v=wB*wF*(mB-mF)**2;
          if(v>maxVar){maxVar=v;t=i;}
        }
        return t;
      }

      function applyFixed(luma: Uint8Array, thresh: number, invert=false): Uint8ClampedArray {
        const out = new Uint8ClampedArray(luma.length*4);
        for (let i=0,j=0;i<luma.length;i++,j+=4) {
          const v = (luma[i]<thresh) !== invert ? 0 : 255;
          out[j]=v; out[j+1]=v; out[j+2]=v; out[j+3]=255;
        }
        return out;
      }

      // Extract single channel as grayscale RGBA
      function extractChannel(rgba: Uint8ClampedArray, ch: 0|1|2): Uint8ClampedArray {
        const out = new Uint8ClampedArray(rgba.length);
        for (let i=0;i<rgba.length;i+=4) {
          const v = rgba[i+ch];
          out[i]=v; out[i+1]=v; out[i+2]=v; out[i+3]=255;
        }
        return out;
      }

      // Local adaptive threshold — divides image into cells and Otsu per cell.
      // Strongly handles QRs embedded in uneven/busy backgrounds.
      function localAdaptive(rgba: Uint8ClampedArray, w: number, h: number, cellSize=48): Uint8ClampedArray {
        const luma = toLuma(rgba);
        const out = new Uint8ClampedArray(rgba.length);
        const cols = Math.ceil(w/cellSize), rows = Math.ceil(h/cellSize);
        for (let row=0;row<rows;row++) {
          for (let col=0;col<cols;col++) {
            const x0=col*cellSize, y0=row*cellSize;
            const x1=Math.min(x0+cellSize,w), y1=Math.min(y0+cellSize,h);
            // Collect cell luma
            const cell = new Uint8Array((x1-x0)*(y1-y0));
            let k=0;
            for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++) cell[k++]=luma[y*w+x];
            const thresh = otsuThreshold(cell);
            // Apply to output
            for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++) {
              const v = luma[y*w+x] < thresh ? 0 : 255;
              const idx=(y*w+x)*4;
              out[idx]=v; out[idx+1]=v; out[idx+2]=v; out[idx+3]=255;
            }
          }
        }
        return out;
      }

      // Erase a centred rectangle to white (handles logo overlap)
      function eraseCentre(rgba: Uint8ClampedArray, w: number, h: number, frac: number): Uint8ClampedArray {
        const out = new Uint8ClampedArray(rgba);
        const rw=Math.round(w*frac), rh=Math.round(h*frac);
        const x0=Math.round((w-rw)/2), y0=Math.round((h-rh)/2);
        for (let y=y0;y<y0+rh;y++) for (let x=x0;x<x0+rw;x++) {
          const i=(y*w+x)*4; out[i]=255;out[i+1]=255;out[i+2]=255;out[i+3]=255;
        }
        return out;
      }

      // Rotate RGBA buffer 90° CW
      function rotate90(rgba: Uint8ClampedArray, w: number, h: number): { data:Uint8ClampedArray; w:number; h:number } {
        const out = new Uint8ClampedArray(w*h*4);
        for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
          const si=(y*w+x)*4, di=((x)*h+(h-1-y))*4;
          out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=rgba[si+3];
        }
        return { data:out, w:h, h:w };
      }

      // ── Main pipeline ────────────────────────────────────────────────────

      // Run at two work scales: native (up to 1500px longest) and 2× upscale
      // (helps small QRs where modules < 5px at native resolution).
      const scales: Array<{ label: string; maxPx: number }> = [
        { label: 'native', maxPx: 1500 },
        { label: '2x',     maxPx: 2400 },
      ];

      for (const { label: scaleLabel, maxPx } of scales) {
        if (results.length >= 4) break;

        const sc = Math.min(maxPx / Math.max(srcW, srcH), scaleLabel === '2x' ? 2.0 : 1.0);
        const wW = Math.round(srcW * sc), wH = Math.round(srcH * sc);
        const upscale = 1 / sc; // factor to map work-coords → source-coords

        const rawBuf = await sharp(req.file.buffer)
          .resize(wW, wH, { kernel: sharp.kernel.lanczos3 })
          .ensureAlpha().raw().toBuffer();

        const base     = compositeWhite(rawBuf);  // transparent → white
        const baseBlk  = compositeBlack(rawBuf);  // transparent → black (dark-bg designs)
        const luma     = toLuma(base);
        const lumaBlk  = toLuma(baseBlk);
        const otsuT    = otsuThreshold(luma);
        const otsuTBlk = otsuThreshold(lumaBlk);

        // 1. Raw (white bg)
        await runEngines(base, wW, wH, upscale, `${scaleLabel}:raw`);
        if (results.length >= 4) break;

        // 2. Raw (black bg) — for designs with dark/transparent background
        await runEngines(baseBlk, wW, wH, upscale, `${scaleLabel}:raw-blk`);
        if (results.length >= 4) break;

        // 3. Otsu (white bg)
        await runEngines(applyFixed(luma, otsuT), wW, wH, upscale, `${scaleLabel}:otsu`);
        if (results.length >= 4) break;

        // 4. Otsu (black bg) — often better for stickers with dark backgrounds
        await runEngines(applyFixed(lumaBlk, otsuTBlk), wW, wH, upscale, `${scaleLabel}:otsu-blk`);
        if (results.length >= 4) break;

        // 5. Inverted Otsu (white-on-dark QRs)
        await runEngines(applyFixed(luma, otsuT, true), wW, wH, upscale, `${scaleLabel}:otsu-inv`);
        if (results.length >= 4) break;

        // 6. Gamma boost (γ=0.35) on black-bg image — brightens dark modules
        // against near-black background so any decoder can see the QR pattern.
        const gamma35 = gammaBoost(baseBlk, 0.35);
        await runEngines(gamma35, wW, wH, upscale, `${scaleLabel}:gamma35`);
        if (results.length >= 4) break;

        // 7. Gamma + Otsu after boosting
        await runEngines(applyFixed(toLuma(gamma35), otsuThreshold(toLuma(gamma35))), wW, wH, upscale, `${scaleLabel}:gamma35-otsu`);
        if (results.length >= 4) break;

        // 8. Gamma boost (γ=0.5)
        const gamma50 = gammaBoost(baseBlk, 0.5);
        await runEngines(applyFixed(toLuma(gamma50), otsuThreshold(toLuma(gamma50))), wW, wH, upscale, `${scaleLabel}:gamma50-otsu`);
        if (results.length >= 4) break;

        // 9-11. Per-channel isolation (coloured QR modules)
        for (const [ch, name] of [[0,'R'],[1,'G'],[2,'B']] as [0|1|2,string][]) {
          if (results.length >= 4) break;
          const chBuf = extractChannel(baseBlk, ch);
          const chLuma = toLuma(chBuf);
          await runEngines(applyFixed(chLuma, otsuThreshold(chLuma)), wW, wH, upscale, `${scaleLabel}:ch${name}`);
        }
        if (results.length >= 4) break;

        // 12. Local adaptive threshold (uneven lighting / busy backgrounds)
        await runEngines(localAdaptive(baseBlk, wW, wH, 48), wW, wH, upscale, `${scaleLabel}:local-adapt`);
        if (results.length >= 4) break;

        // 13-15. Multiple fixed thresholds on black-bg luma
        for (const t of [40, 80, 128]) {
          if (results.length >= 4) break;
          await runEngines(applyFixed(lumaBlk, t), wW, wH, upscale, `${scaleLabel}:t${t}-blk`);
          await runEngines(applyFixed(lumaBlk, t, true), wW, wH, upscale, `${scaleLabel}:t${t}-blk-inv`);
        }
        if (results.length >= 4) break;

        // 16-18. Logo-erase variants — try centre wipes of multiple sizes.
        // Run on BOTH raw-blk and otsu-blk so logos of any colour are defeated.
        for (const frac of [0.22, 0.30, 0.40, 0.50]) {
          if (results.length >= 4) break;
          await runEngines(eraseCentre(applyFixed(lumaBlk, otsuTBlk), wW, wH, frac), wW, wH, upscale, `${scaleLabel}:erase${Math.round(frac*100)}`);
          await runEngines(eraseCentre(baseBlk, wW, wH, frac), wW, wH, upscale, `${scaleLabel}:erase${Math.round(frac*100)}-raw`);
          // Also try on gamma-boosted for very dark logos
          await runEngines(eraseCentre(gamma35, wW, wH, frac), wW, wH, upscale, `${scaleLabel}:erase${Math.round(frac*100)}-g35`);
        }
        if (results.length >= 4) break;

        // 19-21. Rotations — jsQR doesn't auto-rotate
        let rotData = { data: applyFixed(lumaBlk, otsuTBlk), w: wW, h: wH };
        for (let r=1;r<=3;r++) {
          if (results.length >= 4) break;
          const rot = rotate90(rotData.data, rotData.w, rotData.h);
          rotData = rot;
          await runEngines(rot.data, rot.w, rot.h, upscale, `${scaleLabel}:rot${r*90}`);
        }

        // Only run 2x scale if native found nothing
        if (scaleLabel === 'native' && results.length > 0) break;
      }

      console.log(`[QR server] Detected ${results.length} QR(s) — variants exhausted`);
      res.json({ qrCodes: results });
    } catch (err) {
      console.error("[QR server] Detection error:", err);
      res.status(500).json({ error: "QR detection failed", details: String(err) });
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

  // AI Image Enhancement using Replicate Real-ESRGAN (4x)
  app.post("/api/enhance-image-ai", upload.single('image'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const apiToken = process.env.REPLICATE_API_TOKEN;
      if (!apiToken) {
        console.error("Replicate API token not configured");
        return res.status(500).json({ error: "AI enhancement service not configured. Set REPLICATE_API_TOKEN environment variable." });
      }

      const start = Date.now();
      const metadata = await sharp(req.file.buffer).metadata();
      const imgWidth = metadata.width || 1;
      const imgHeight = metadata.height || 1;

      const longestSide = Math.max(imgWidth, imgHeight);
      if (longestSide * 4 > 16384) {
        return res.status(400).json({ error: `Image too large for 4x AI enhancement (${imgWidth}x${imgHeight}). Max input longest side: 4096px.` });
      }

      const faceEnhance = req.body?.face_enhance === 'true';
      console.log(`[Enhance-AI] Starting Replicate Real-ESRGAN 4x: ${imgWidth}x${imgHeight} → ${imgWidth * 4}x${imgHeight * 4} (face_enhance: ${faceEnhance})`);

      const replicate = new Replicate({ auth: apiToken, useFileOutput: false });

      const base64 = req.file.buffer.toString('base64');
      const mimeType = req.file.mimetype || 'image/png';
      const dataUri = `data:${mimeType};base64,${base64}`;

      const output = await replicate.run(
        "nightmareai/real-esrgan:f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa",
        {
          input: {
            image: dataUri,
            scale: 4,
            face_enhance: faceEnhance,
          }
        }
      );

      let resultUrl: string | null = null;
      if (typeof output === 'string') {
        resultUrl = output;
      } else if (output && typeof (output as any).url === 'function') {
        resultUrl = (output as any).url();
      } else if (output && typeof output === 'object') {
        resultUrl = String(output);
      }

      console.log(`[Enhance-AI] Replicate output type: ${typeof output}, resultUrl: ${resultUrl ? resultUrl.substring(0, 80) + '...' : 'null'}`);

      if (!resultUrl || resultUrl === '[object Object]' || resultUrl === '[object ReadableStream]') {
        throw new Error("Unexpected output format from Replicate AI model");
      }

      console.log(`[Enhance-AI] Replicate done, downloading result...`);

      const imgResponse = await fetch(resultUrl);
      if (!imgResponse.ok) throw new Error(`Failed to download enhanced image: ${imgResponse.status}`);

      const arrayBuf = await imgResponse.arrayBuffer();
      const pngBuffer = await sharp(Buffer.from(arrayBuf))
        .png()
        .toBuffer();

      const enhancedMeta = await sharp(pngBuffer).metadata();
      const outWidth = enhancedMeta.width || imgWidth * 4;
      const outHeight = enhancedMeta.height || imgHeight * 4;

      const elapsed = Date.now() - start;
      console.log(`[Enhance-AI] Done in ${elapsed}ms! ${imgWidth}x${imgHeight} → ${outWidth}x${outHeight}`);

      res.set('Content-Type', 'image/png');
      res.set('X-Enhanced-Width', String(outWidth));
      res.set('X-Enhanced-Height', String(outHeight));
      res.set('X-Original-Width', String(imgWidth));
      res.set('X-Original-Height', String(imgHeight));
      res.send(pngBuffer);
    } catch (error) {
      console.error("[Enhance-AI] Error:", error);
      res.status(500).json({
        error: "AI enhancement failed",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // AI Background Removal using Replicate BiRefNet (men1scus/birefnet).
  // Returns a transparent PNG suitable for downstream contour tracing.
  // Includes a cheap fast-path: if the input already has meaningful
  // transparency (>1% of pixels with alpha < 250), we skip the ML call and
  // re-encode the input as-is.
  app.post("/api/remove-background-ai", upload.single('image'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const start = Date.now();
      const inputMeta = await sharp(req.file.buffer).metadata();
      const imgWidth = inputMeta.width || 1;
      const imgHeight = inputMeta.height || 1;

      // Sanity cap: BiRefNet on A100 handles ~2k cleanly; above ~4k we risk
      // timeouts and excess cost without quality gain (the contour pipeline
      // re-rasterises at most 300 DPI anyway).
      const longestSide = Math.max(imgWidth, imgHeight);
      if (longestSide > 4096) {
        return res.status(400).json({
          error: `Image too large for AI background removal (${imgWidth}x${imgHeight}). Max longest side: 4096px.`,
        });
      }

      // ── Fast-path: already transparent ──
      // Sample at 256px on the longest side; counting every pixel of a 4k PNG
      // here would dominate the route latency.
      const sampleLong = 256;
      const sampleScale = Math.min(1, sampleLong / longestSide);
      const sampleW = Math.max(1, Math.round(imgWidth * sampleScale));
      const sampleH = Math.max(1, Math.round(imgHeight * sampleScale));
      const { data: sampleData, info: sampleInfo } = await sharp(req.file.buffer)
        .resize(sampleW, sampleH, { fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const sampleCh = sampleInfo.channels;
      let transparentish = 0;
      const totalSampled = sampleW * sampleH;
      for (let i = 0; i < totalSampled; i++) {
        if (sampleData[i * sampleCh + 3] < 250) transparentish++;
      }
      const transparencyRatio = transparentish / totalSampled;

      if (transparencyRatio > 0.01) {
        // Image already has alpha; re-encode untouched so the client can
        // treat the response uniformly.
        const passthrough = await sharp(req.file.buffer).png().toBuffer();
        const elapsed = Date.now() - start;
        console.log(
          `[BG-AI] Skipped ML (${(transparencyRatio * 100).toFixed(1)}% already transparent), ${elapsed}ms`
        );
        res.set('Content-Type', 'image/png');
        res.set('X-Bg-Removal-Mode', 'passthrough');
        res.set('X-Original-Width', String(imgWidth));
        res.set('X-Original-Height', String(imgHeight));
        return res.send(passthrough);
      }

      const apiToken = process.env.REPLICATE_API_TOKEN;
      if (!apiToken) {
        console.error("Replicate API token not configured");
        return res.status(500).json({
          error: "AI background removal service not configured. Set REPLICATE_API_TOKEN environment variable.",
        });
      }

      console.log(`[BG-AI] Starting BiRefNet on ${imgWidth}x${imgHeight}`);

      const replicate = new Replicate({ auth: apiToken, useFileOutput: false });

      const base64 = req.file.buffer.toString('base64');
      const mimeType = req.file.mimetype || 'image/png';
      const dataUri = `data:${mimeType};base64,${base64}`;

      const output = await replicate.run(
        "men1scus/birefnet:f74986db0355b58403ed20963af156525e2891ea3c2d499bfbfb2a28cd87c5d7",
        { input: { image: dataUri } }
      );

      let resultUrl: string | null = null;
      if (typeof output === 'string') {
        resultUrl = output;
      } else if (Array.isArray(output) && output.length > 0 && typeof output[0] === 'string') {
        resultUrl = output[0] as string;
      } else if (output && typeof (output as any).url === 'function') {
        resultUrl = (output as any).url();
      } else if (output && typeof output === 'object') {
        resultUrl = String(output);
      }

      console.log(
        `[BG-AI] Replicate output type: ${typeof output}, resultUrl: ${resultUrl ? resultUrl.substring(0, 80) + '...' : 'null'}`
      );

      if (!resultUrl || resultUrl === '[object Object]' || resultUrl === '[object ReadableStream]') {
        throw new Error("Unexpected output format from Replicate AI model");
      }

      const imgResponse = await fetch(resultUrl);
      if (!imgResponse.ok) throw new Error(`Failed to download AI result: ${imgResponse.status}`);

      const arrayBuf = await imgResponse.arrayBuffer();
      // Re-encode through Sharp to guarantee a clean RGBA PNG (the model
      // sometimes emits images Chrome decodes oddly without a re-encode).
      const pngBuffer = await sharp(Buffer.from(arrayBuf)).ensureAlpha().png().toBuffer();
      const outMeta = await sharp(pngBuffer).metadata();
      const outWidth = outMeta.width || imgWidth;
      const outHeight = outMeta.height || imgHeight;

      const elapsed = Date.now() - start;
      console.log(`[BG-AI] Done in ${elapsed}ms! ${imgWidth}x${imgHeight} → ${outWidth}x${outHeight}`);

      res.set('Content-Type', 'image/png');
      res.set('X-Bg-Removal-Mode', 'birefnet');
      res.set('X-Original-Width', String(imgWidth));
      res.set('X-Original-Height', String(imgHeight));
      res.set('X-Result-Width', String(outWidth));
      res.set('X-Result-Height', String(outHeight));
      res.send(pngBuffer);
    } catch (error) {
      console.error("[BG-AI] Error:", error);
      res.status(500).json({
        error: "AI background removal failed",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

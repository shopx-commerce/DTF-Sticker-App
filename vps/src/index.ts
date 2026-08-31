// Import order matters: the shim must install its globals before import-trace-core is ever loaded.
import './canvas-shim';

import express from 'express';
import cors from 'cors';
import { processContour, processSpotColors } from './import-trace-core';
import { base64ToUint8Array, pixelsToPngBase64, pngBase64ToImageData } from './image-io';
import { verifyJobToken } from './auth';

const app = express();

app.use(cors({ origin: process.env.ALLOWED_ORIGIN }));
// Base64-encoded PNG design files can be sizable; 50mb covers realistic sticker designs.
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(verifyJobToken);

app.post('/trace-contour', async (req, res) => {
  try {
    const { imagePng, strokeSettings, effectiveDPI, previewMode, detectedShapeType, detectedShapeBBox } = req.body ?? {};
    if (!imagePng || !strokeSettings || !effectiveDPI) {
      return res.status(400).json({ error: 'imagePng, strokeSettings, effectiveDPI are required' });
    }

    const imageData = await pngBase64ToImageData(imagePng);
    const result = processContour(imageData, strokeSettings, effectiveDPI, previewMode, detectedShapeType, detectedShapeBBox);

    // The rendered raster is only needed by the browser's own canvas — skip shipping it by default; opt in with ?includeRaster=1.
    const { imageData: rasterImageData, ...geometry } = result;
    const includeRaster = req.query.includeRaster === '1';

    res.status(200).json({
      ...geometry,
      ...(includeRaster
        ? { imagePng: pixelsToPngBase64(rasterImageData.data, rasterImageData.width, rasterImageData.height) }
        : {}),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/trace-spot-colors', async (req, res) => {
  try {
    const {
      imagePng,
      spotColors,
      dpi,
      whiteInclusionMask,
      glossInclusionMask,
      fullAlphaMask,
      allTaggedWhite,
      allTaggedGloss,
      exactSelection,
    } = req.body ?? {};
    if (!imagePng || !spotColors || !dpi) {
      return res.status(400).json({ error: 'imagePng, spotColors, dpi are required' });
    }

    const imageData = await pngBase64ToImageData(imagePng);
    const regions = processSpotColors(
      imageData.data,
      imageData.width,
      imageData.height,
      spotColors,
      dpi,
      base64ToUint8Array(whiteInclusionMask),
      base64ToUint8Array(glossInclusionMask),
      base64ToUint8Array(fullAlphaMask),
      allTaggedWhite,
      allTaggedGloss,
      exactSelection
    );

    res.status(200).json({ regions });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`[vps] listening on :${port}`);
});

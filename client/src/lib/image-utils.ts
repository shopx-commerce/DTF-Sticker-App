import { StrokeSettings, ShapeSettings } from "@/components/image-editor";
import { applyCadCutClipping } from "@/lib/cadcut-bounds";
import { cropImageToContent } from "@/lib/image-crop";
import { createCadCutContour } from "@/lib/cadcut-contour";

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 255, g: 255, b: 255 };
}

export function calculateImageDimensions(width: number, height: number, dpi: number) {
  const widthInches = parseFloat((width / dpi).toFixed(1));
  const heightInches = parseFloat((height / dpi).toFixed(1));
  
  return { widthInches, heightInches };
}

export function pixelsToInches(pixels: number, dpi: number): number {
  return pixels / dpi;
}

export function inchesToPixels(inches: number, dpi: number): number {
  return Math.round(inches * dpi);
}

export async function downloadCanvas(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  widthInches: number,
  heightInches: number,
  dpi: number,
  filename: string,
  shapeSettings?: ShapeSettings
) {
  // Create a high-resolution canvas for export
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  // Calculate output dimensions based on shape settings
  let outputWidth, outputHeight;
  
  // Use provided width/height inches - these come from resize settings
  outputWidth = widthInches * dpi;
  outputHeight = heightInches * dpi;

  canvas.width = outputWidth;
  canvas.height = outputHeight;

  // Draw background shape if enabled
  if (shapeSettings?.enabled) {
    drawShapeBackground(ctx, shapeSettings, outputWidth, outputHeight, dpi);
  }

  // Draw the image with stroke at high resolution
  if (shapeSettings?.enabled) {
    // Crop image to remove empty space before processing
    const croppedCanvas = cropImageToContent(image);
    const sourceImage = croppedCanvas ? (() => {
      const img = new Image();
      img.src = croppedCanvas.toDataURL();
      return img;
    })() : image;

    // Wait for cropped image to load if created
    if (croppedCanvas) {
      await new Promise((resolve) => {
        sourceImage.onload = resolve;
      });
    }

    // Calculate image placement with manual offset
    const imageAspect = sourceImage.width / sourceImage.height;
    const shapeAspect = outputWidth / outputHeight;
    
    let drawWidth, drawHeight;
    if (imageAspect > shapeAspect) {
      drawWidth = outputWidth * 0.8;
      drawHeight = drawWidth / imageAspect;
    } else {
      drawHeight = outputHeight * 0.8;
      drawWidth = drawHeight * imageAspect;
    }
    
    // Center the image in the shape
    const baseX = (outputWidth - drawWidth) / 2;
    const baseY = (outputHeight - drawHeight) / 2;
    const finalX = baseX;
    const finalY = baseY;
    
    // Apply clipping to prevent image from extending beyond shape bounds
    // Pass dpi as pixelsPerInch for correct corner radius calculation
    applyCadCutClipping(ctx, shapeSettings, outputWidth, outputHeight, dpi);
    
    ctx.drawImage(sourceImage, finalX, finalY, drawWidth, drawHeight);
    
    // Restore context after clipping
    ctx.restore();
  } else {
    await drawHighResImage(ctx, image, strokeSettings, outputWidth, outputHeight);
  }

  // Download the canvas as PNG
  return new Promise<void>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to create blob from canvas'));
          return;
        }
        
        try {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = filename;
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 'image/png');
    } catch (error) {
      reject(error);
    }
  });
}

function drawShapeBackground(
  ctx: CanvasRenderingContext2D,
  shapeSettings: ShapeSettings,
  width: number,
  height: number,
  dpi: number = 300
) {
  const centerX = width / 2;
  const centerY = height / 2;
  const cornerRadius = (shapeSettings.cornerRadius || 0.25) * dpi;
  
  // Fill the shape
  ctx.fillStyle = shapeSettings.fillColor;
  ctx.beginPath();
  
  if (shapeSettings.type === 'circle') {
    const radius = Math.min(width, height) / 2;
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  } else if (shapeSettings.type === 'oval') {
    const radiusX = width / 2;
    const radiusY = height / 2;
    ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
  } else if (shapeSettings.type === 'square') {
    const size = Math.min(width, height);
    const startX = centerX - size / 2;
    const startY = centerY - size / 2;
    ctx.rect(startX, startY, size, size);
  } else if (shapeSettings.type === 'rounded-square') {
    const size = Math.min(width, height);
    const startX = centerX - size / 2;
    const startY = centerY - size / 2;
    ctx.roundRect(startX, startY, size, size, cornerRadius);
  } else if (shapeSettings.type === 'rounded-rectangle') {
    ctx.roundRect(0, 0, width, height, cornerRadius);
  } else { // rectangle
    ctx.rect(0, 0, width, height);
  }
  
  ctx.fill();
  
  // Draw stroke if enabled
  if (shapeSettings.strokeEnabled) {
    ctx.strokeStyle = shapeSettings.strokeColor;
    ctx.lineWidth = shapeSettings.strokeWidth;
    ctx.stroke();
  }
}

async function drawImageCenteredInShape(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  canvasWidth: number,
  canvasHeight: number
) {
  try {
    // First, crop the image to remove empty space for accurate centering
    const croppedCanvas = cropImageToContent(image);
    const sourceImage = croppedCanvas || image;
    
    // Calculate image dimensions maintaining aspect ratio
    const imageAspect = sourceImage.width / sourceImage.height;
    const canvasAspect = canvasWidth / canvasHeight;
    
    let drawWidth, drawHeight;
    if (imageAspect > canvasAspect) {
      // Image is wider - fit to width
      drawWidth = canvasWidth * 0.8; // Leave some margin
      drawHeight = drawWidth / imageAspect;
    } else {
      // Image is taller - fit to height
      drawHeight = canvasHeight * 0.8; // Leave some margin
      drawWidth = drawHeight * imageAspect;
    }
    
    // Center the cropped image perfectly within the shape
    const x = (canvasWidth - drawWidth) / 2;
    const y = (canvasHeight - drawHeight) / 2;
    ctx.drawImage(sourceImage, x, y, drawWidth, drawHeight);
  } catch (error) {
    console.error('Error in drawImageCenteredInShape:', error);
    // Fallback to drawing original image
    ctx.drawImage(image, 0, 0, canvasWidth, canvasHeight);
  }
}

async function drawHighResImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  canvasWidth: number,
  canvasHeight: number
) {
  // Clear canvas with transparent background
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Calculate scaling to fit the image within canvas while maintaining aspect ratio
  const imageAspectRatio = image.width / image.height;
  const canvasAspectRatio = canvasWidth / canvasHeight;

  let drawWidth, drawHeight, offsetX, offsetY;

  if (imageAspectRatio > canvasAspectRatio) {
    // Image is wider than canvas
    drawWidth = canvasWidth;
    drawHeight = canvasWidth / imageAspectRatio;
    offsetX = 0;
    offsetY = (canvasHeight - drawHeight) / 2;
  } else {
    // Image is taller than canvas
    drawHeight = canvasHeight;
    drawWidth = canvasHeight * imageAspectRatio;
    offsetX = (canvasWidth - drawWidth) / 2;
    offsetY = 0;
  }

  // Draw stroke/outline if enabled
  if (strokeSettings.enabled && strokeSettings.width > 0) {
    // Calculate stroke width in pixels using effective DPI
    const effectiveDPI = drawWidth / (canvasWidth / 300); // Approximate DPI based on canvas
    const strokeWidthPx = Math.round(strokeSettings.width * effectiveDPI);
    
    // Create temporary canvas for high-quality stroke processing
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return;
    
    // Set size with padding for stroke
    const padding = strokeWidthPx * 2;
    tempCanvas.width = drawWidth + padding;
    tempCanvas.height = drawHeight + padding;
    
    // Draw image centered in temp canvas
    tempCtx.drawImage(image, strokeWidthPx, strokeWidthPx, drawWidth, drawHeight);
    
    // Get image data for processing
    const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const data = imageData.data;
    
    // Create stroke mask using morphological dilation
    const strokeMask = new Uint8ClampedArray(data.length);
    
    // Identify all opaque pixels
    const opaquePixels = [];
    for (let y = 0; y < tempCanvas.height; y++) {
      for (let x = 0; x < tempCanvas.width; x++) {
        const idx = (y * tempCanvas.width + x) * 4;
        if (data[idx + 3] > 128) {
          opaquePixels.push({ x, y });
        }
      }
    }
    
    // For each opaque pixel, mark stroke area efficiently
    for (const pixel of opaquePixels) {
      const minX = Math.max(0, pixel.x - strokeWidthPx);
      const maxX = Math.min(tempCanvas.width - 1, pixel.x + strokeWidthPx);
      const minY = Math.max(0, pixel.y - strokeWidthPx);
      const maxY = Math.min(tempCanvas.height - 1, pixel.y + strokeWidthPx);
      
      for (let sy = minY; sy <= maxY; sy++) {
        for (let sx = minX; sx <= maxX; sx++) {
          const dx = sx - pixel.x;
          const dy = sy - pixel.y;
          
          // Use circular brush
          if (dx * dx + dy * dy <= strokeWidthPx * strokeWidthPx) {
            const strokeIdx = (sy * tempCanvas.width + sx) * 4;
            strokeMask[strokeIdx + 3] = 255;
          }
        }
      }
    }
    
    // Create stroke image data
    const strokeData = tempCtx.createImageData(tempCanvas.width, tempCanvas.height);
    const strokeColor = hexToRgb(strokeSettings.color);
    
    // Apply stroke color where mask is set and original image is transparent
    for (let i = 0; i < strokeMask.length; i += 4) {
      if (strokeMask[i + 3] > 0 && data[i + 3] < 128) {
        strokeData.data[i] = strokeColor.r;
        strokeData.data[i + 1] = strokeColor.g;
        strokeData.data[i + 2] = strokeColor.b;
        strokeData.data[i + 3] = 255;
      }
    }
    
    // Clear temp canvas and draw stroke
    tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
    tempCtx.putImageData(strokeData, 0, 0);
    
    // Draw original image on top
    tempCtx.drawImage(image, strokeSettings.width, strokeSettings.width, drawWidth, drawHeight);
    
    // Draw final result to main canvas
    ctx.drawImage(tempCanvas, offsetX - strokeSettings.width, offsetY - strokeSettings.width);
  } else {
    // Draw image without stroke
    ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
  }

  // Draw the main image
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

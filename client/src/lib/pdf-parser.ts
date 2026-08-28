import * as pdfjsLib from 'pdfjs-dist';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
import { vectorPrintDpi, vectorExportMaxEdge } from './vector-raster-limits';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export interface PDFCutContourInfo {
  hasCutContour: boolean;
  cutContourPath: Path2D | null;
  cutContourPoints: { x: number; y: number }[][];
  pageWidth: number;
  pageHeight: number;
  detectedLabel: string | null;
}

// Existing spot-color separations a customer's PDF might already carry — matched loosely (spacing/casing/separators vary by RIP software).
const CUT_SPOT_PATTERNS: { label: string; match: RegExp }[] = [
  { label: 'PerfCutContour', match: /perf[\s_-]?cut/i },
  { label: 'KissCut', match: /kiss[\s_-]?cut/i },
  { label: 'CutContour', match: /cut[\s_-]?contour/i },
];

// Order matters: PerfCut/KissCut checked first since "PerfCutContour" would otherwise also match the generic CutContour pattern.
function matchCutSpotLabel(name: string): string | null {
  return CUT_SPOT_PATTERNS.find(p => p.match.test(name))?.label ?? null;
}

export interface ParsedPDFData {
  image: HTMLImageElement;
  width: number;
  height: number;
  cutContourInfo: PDFCutContourInfo;
  originalPdfData: ArrayBuffer;
  dpi: number;
  // Page 1's true physical size, from PDF geometry — not derived from the (possibly clamped) preview raster.
  widthInches: number;
  heightInches: number;
}

export async function parsePDF(file: File): Promise<ParsedPDFData> {
  const arrayBuffer = await file.arrayBuffer();
  
  // First, use pdf-lib to check for CutContour spot color in resources
  const cutContourInfo = await extractCutContourFromRawPDF(arrayBuffer);
  console.log('[PDF Parser] CutContour detected:', cutContourInfo.hasCutContour);
  
  // PDF.js detaches whatever buffer it's given — hand it a throwaway copy so `originalPdfData` (the same `arrayBuffer`, saved below) doesn't come back zero-length.
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)) }).promise;
  const page = await pdf.getPage(1);

  // Base viewport at 1:1 scale — page's true physical size (72 points/inch), independent of any preview clamp.
  const baseViewport = page.getViewport({ scale: 1 });
  const widthInches = Math.max(0.01, baseViewport.width / 72);
  const heightInches = Math.max(0.01, baseViewport.height / 72);

  // Clamped to the platform's safe canvas ceiling — iOS Safari silently no-ops drawImage past that instead of failing loudly.
  let pdfScale = 300 / 72;
  const maxEdge = vectorExportMaxEdge();
  const dimensionalScale = Math.min(1, maxEdge / Math.max(baseViewport.width * pdfScale, 1), maxEdge / Math.max(baseViewport.height * pdfScale, 1));
  pdfScale *= dimensionalScale;
  const viewport = page.getViewport({ scale: pdfScale });

  // Update cutContourInfo with page dimensions (at render DPI)
  cutContourInfo.pageWidth = viewport.width;
  cutContourInfo.pageHeight = viewport.height;

  // If CutContour was detected but no paths extracted, try using PDF.js operator list
  if (cutContourInfo.hasCutContour && cutContourInfo.cutContourPoints.length === 0) {
    try {
      const paths = await extractPathsFromOperatorList(page, baseViewport.height, pdfScale);
      if (paths.length > 0) {
        cutContourInfo.cutContourPoints = paths;
        console.log('[PDF Parser] Extracted', paths.length, 'paths from operator list');
      }
    } catch (e) {
      console.warn('[PDF Parser] Operator list extraction failed:', e);
    }
  }
  
  console.log('[PDF Parser] Final result: hasCutContour:', cutContourInfo.hasCutContour, 'paths:', cutContourInfo.cutContourPoints.length);
  
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d', { alpha: true })!;
  
  // Clear canvas to transparent (not white)
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  await page.render({
    canvasContext: ctx,
    viewport: viewport,
    background: 'rgba(0,0,0,0)' // Transparent background
  } as any).promise;
  
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = canvas.toDataURL('image/png');
  });
  
  return {
    image,
    width: viewport.width,
    height: viewport.height,
    cutContourInfo,
    originalPdfData: arrayBuffer,
    // Print DPI, not the possibly-clamped preview's — the export path re-renders this page at placement size.
    dpi: vectorPrintDpi(widthInches, heightInches),
    widthInches,
    heightInches
  };
}

// Re-renders page 1 of a retained PDF at (at least) the requested pixel size, so export draws from the PDF's own geometry at true DPI instead of upscaling the clamped import preview; the caller resizes the result down if it overshoots.
export async function rasterisePdfPageToPngBlob(
  pdfData: ArrayBuffer,
  targetWidth: number,
  targetHeight: number,
  clampToMaxEdge: number
): Promise<Blob> {
  let pdf: pdfjsLib.PDFDocumentProxy | null = null;
  try {
    // pdf.js detaches whatever buffer it's given — hand it a throwaway copy so the original survives for the next export.
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfData.slice(0)) }).promise;
    const page = await pdf.getPage(1);

    const base = page.getViewport({ scale: 1 });
    let scale = Math.max(
      targetWidth / Math.max(base.width, 1),
      targetHeight / Math.max(base.height, 1)
    );
    const longestEdge = Math.max(base.width, base.height) * scale;
    if (longestEdge > clampToMaxEdge) scale *= clampToMaxEdge / longestEdge;

    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    if (!ctx) throw new Error('Could not create canvas context for PDF rendering');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport,
      background: 'rgba(0,0,0,0)',
      intent: 'print'
    } as any).promise;

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error('Failed to encode PDF page as PNG');
    return blob;
  } finally {
    pdf?.destroy();
  }
}

// Extract paths from PDF.js operator list (handles decompressed content)
async function extractPathsFromOperatorList(
  page: pdfjsLib.PDFPageProxy,
  pageHeight: number,
  scale: number
): Promise<{ x: number; y: number }[][]> {
  const operatorList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  
  const paths: { x: number; y: number }[][] = [];
  let currentPath: { x: number; y: number }[] = [];
  let inCutContourMode = false;
  
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const fn = operatorList.fnArray[i];
    const args = operatorList.argsArray[i];
    
    // Check for setFillColorSpace or setStrokeColorSpace - these might indicate CutContour
    // In PDF.js, color space changes are tracked but spot colors are hard to detect
    // We'll capture all paths and filter later based on stroke color (magenta-ish)
    
    if (fn === OPS.moveTo && args) {
      if (currentPath.length > 0) {
        paths.push([...currentPath]);
        currentPath = [];
      }
      const x = args[0] * scale;
      const y = (pageHeight - args[1]) * scale; // Flip Y
      currentPath.push({ x, y });
    } else if (fn === OPS.lineTo && args) {
      const x = args[0] * scale;
      const y = (pageHeight - args[1]) * scale;
      currentPath.push({ x, y });
    } else if (fn === OPS.curveTo && args) {
      // Bezier curve - use endpoint
      const x = args[4] * scale;
      const y = (pageHeight - args[5]) * scale;
      currentPath.push({ x, y });
    } else if (fn === OPS.curveTo2 && args) {
      const x = args[2] * scale;
      const y = (pageHeight - args[3]) * scale;
      currentPath.push({ x, y });
    } else if (fn === OPS.curveTo3 && args) {
      const x = args[2] * scale;
      const y = (pageHeight - args[3]) * scale;
      currentPath.push({ x, y });
    } else if (fn === OPS.closePath) {
      if (currentPath.length > 0) {
        currentPath.push({ ...currentPath[0] });
      }
    } else if (fn === OPS.rectangle && args) {
      // Rectangle: x, y, width, height
      const x = args[0] * scale;
      const y = (pageHeight - args[1]) * scale;
      const w = args[2] * scale;
      const h = args[3] * scale;
      if (currentPath.length > 0) {
        paths.push([...currentPath]);
        currentPath = [];
      }
      currentPath = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y - h },
        { x, y: y - h },
        { x, y }
      ];
    } else if (fn === OPS.stroke || fn === OPS.fill || fn === OPS.eoFill ||
               fn === OPS.fillStroke || fn === OPS.eoFillStroke ||
               fn === OPS.closeStroke || fn === OPS.closeFillStroke) {
      if (currentPath.length > 0) {
        paths.push([...currentPath]);
        currentPath = [];
      }
    } else if (fn === OPS.endPath) {
      currentPath = [];
    }
  }
  
  if (currentPath.length > 0) {
    paths.push(currentPath);
  }
  
  // Filter to find the likely CutContour path (usually the outermost/largest path)
  // For now, return the path with most points or largest bounding box
  if (paths.length > 1) {
    // Find the largest path by bounding box area
    let largestPath = paths[0];
    let largestArea = 0;
    
    for (const path of paths) {
      if (path.length < 3) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of path) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
      const area = (maxX - minX) * (maxY - minY);
      if (area > largestArea) {
        largestArea = area;
        largestPath = path;
      }
    }
    
    return [largestPath];
  }
  
  return paths;
}

// Extract CutContour from raw PDF using pdf-lib to read resources and content streams
async function extractCutContourFromRawPDF(arrayBuffer: ArrayBuffer): Promise<PDFCutContourInfo> {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFStream } = await import('pdf-lib');
  
  const result: PDFCutContourInfo = {
    hasCutContour: false,
    cutContourPath: null,
    cutContourPoints: [],
    pageWidth: 0,
    pageHeight: 0,
    detectedLabel: null
  };

  try {
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const pages = pdfDoc.getPages();
    if (pages.length === 0) return result;
    
    const page = pages[0];
    const { width, height } = page.getSize();
    result.pageWidth = width;
    result.pageHeight = height;
    
    // Check ColorSpace resources for Separation/CutContour
    const resources = page.node.Resources();
    const context = pdfDoc.context;
    
    if (resources) {
      const colorSpaces = resources.get(PDFName.of('ColorSpace'));
      if (colorSpaces instanceof PDFDict) {
        const entries = colorSpaces.entries();
        for (const [name, value] of entries) {
          const nameStr = name.toString();
          console.log('[PDF Parser] ColorSpace found:', nameStr);
          
          // Resolve indirect references
          let resolvedValue = value;
          if (value && 'toString' in value && value.toString().startsWith('/')) {
            // It's a name reference, try to look it up
          } else {
            // Try to dereference if it's a ref
            try {
              resolvedValue = context.lookup(value as any) || value;
            } catch (e) {
              // Keep original value
            }
          }
          
          // Check if this is a Separation color space with CutContour
          if (resolvedValue instanceof PDFArray) {
            const firstElement = resolvedValue.get(0);
            const firstStr = firstElement?.toString() || '';
            console.log('[PDF Parser] ColorSpace type:', firstStr);
            
            if (firstStr === '/Separation') {
              const spotName = resolvedValue.get(1);
              if (spotName) {
                const spotNameStr = spotName.toString();
                console.log('[PDF Parser] Separation spot color:', spotNameStr);
                const label = matchCutSpotLabel(spotNameStr);
                if (label) {
                  result.hasCutContour = true;
                  result.detectedLabel = label;
                  console.log('[PDF Parser] Spot-color contour detected:', label);
                }
              }
            }
          } else {
            // Log the type for debugging
            console.log('[PDF Parser] ColorSpace value type:', resolvedValue?.constructor?.name);
          }
        }
      }
    }
    
    // Also search raw PDF bytes for a known contour spot name as fallback
    if (!result.hasCutContour) {
      const pdfBytes = new Uint8Array(arrayBuffer);
      const pdfText = new TextDecoder('latin1').decode(pdfBytes);
      const label = matchCutSpotLabel(pdfText);
      if (label) {
        console.log('[PDF Parser] Spot-color contour found in raw PDF bytes:', label);
        result.hasCutContour = true;
        result.detectedLabel = label;
      }
    }

    // If a contour spot color was found, try to extract its path from the content stream
    if (result.hasCutContour) {
      // First find which color space name maps to the detected label
      let cutContourCSName = result.detectedLabel ?? 'CutContour';
      if (resources) {
        const colorSpaces = resources.get(PDFName.of('ColorSpace'));
        if (colorSpaces instanceof PDFDict) {
          const entries = colorSpaces.entries();
          for (const [name, value] of entries) {
            let resolvedValue = value;
            try {
              resolvedValue = context.lookup(value as any) || value;
            } catch (e) {}

            if (resolvedValue instanceof PDFArray) {
              const firstStr = resolvedValue.get(0)?.toString() || '';
              if (firstStr === '/Separation') {
                const spotName = resolvedValue.get(1)?.toString() || '';
                if (matchCutSpotLabel(spotName)) {
                  cutContourCSName = name.toString().replace('/', '');
                  console.log('[PDF Parser] Contour color space reference name:', cutContourCSName);
                  break;
                }
              }
            }
          }
        }
      }
      
      const contents = page.node.Contents();
      if (contents) {
        let contentStr = '';
        if (contents instanceof PDFStream) {
          const decoded = contents.getContents();
          contentStr = new TextDecoder().decode(decoded);
        } else if (contents instanceof PDFArray) {
          for (let i = 0; i < contents.size(); i++) {
            let stream: any = contents.get(i);
            if (stream && !(stream instanceof PDFStream)) {
              try {
                stream = context.lookup(stream as any);
              } catch (e) {
                console.warn('[PDF Parser] Could not resolve content stream ref at index', i);
              }
            }
            if (stream instanceof PDFStream) {
              const decoded = stream.getContents();
              contentStr += new TextDecoder().decode(decoded) + '\n';
            }
          }
        }
        
        console.log('[PDF Parser] Content stream length:', contentStr.length);
        console.log('[PDF Parser] Looking for color space:', cutContourCSName);
        
        // Log a snippet of the content stream for debugging
        console.log('[PDF Parser] Content stream snippet:', contentStr.substring(0, 500));
        
        // Extract path points using the color space name
        const pathPoints = extractPathFromContentStream(contentStr, width, height, cutContourCSName);
        if (pathPoints.length > 0) {
          result.cutContourPoints = pathPoints;
          console.log('[PDF Parser] Extracted', pathPoints.length, 'paths with', pathPoints.reduce((a, p) => a + p.length, 0), 'total points');
        } else {
          console.log('[PDF Parser] No paths extracted from content stream');
        }
      }
    }
    
  } catch (error) {
    console.warn('[PDF Parser] Error parsing PDF with pdf-lib:', error);
  }
  
  return result;
}

// Extract path points from PDF content stream
function extractPathFromContentStream(content: string, pageWidth: number, pageHeight: number, colorSpaceName: string): { x: number; y: number }[][] {
  const paths: { x: number; y: number }[][] = [];
  let currentPath: { x: number; y: number }[] = [];
  let inCutContour = false;
  
  // Parse content stream - tokenize properly handling numbers (including negatives, decimals)
  const tokens = content.match(/-?\d+\.?\d*(?:[eE][+-]?\d+)?|\/[\w]+|[a-zA-Z\*]+/g) || [];
  const stack: string[] = [];
  
  // Known operators that consume operands and should clear stack
  const operators = new Set([
    'q', 'Q', 'cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs',
    'm', 'l', 'c', 'v', 'y', 'h', 're',
    'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n',
    'W', 'W*',
    'BT', 'ET', 'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts', 'Td', 'TD', 'Tm', 'T*', 'Tj', 'TJ', "'", '"',
    'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k',
    'Do', 'BI', 'ID', 'EI',
    'BMC', 'BDC', 'EMC', 'MP', 'DP'
  ]);
  
  console.log('[PDF Parser] Tokenizing content stream, got', tokens.length, 'tokens');
  
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    
    // Check if it's an operator
    if (operators.has(token)) {
      // Handle specific operators
      if (token === 'CS' || token === 'cs') {
        const csName = stack.length > 0 ? stack[stack.length - 1] : '';
        if (csName === '/' + colorSpaceName || matchCutSpotLabel(csName)) {
          inCutContour = true;
          console.log('[PDF Parser] Entering CutContour mode with', csName);
        } else if (inCutContour && csName.startsWith('/')) {
          console.log('[PDF Parser] Exiting CutContour mode, switching to', csName);
          if (currentPath.length > 0) {
            paths.push([...currentPath]);
            currentPath = [];
          }
          inCutContour = false;
        }
      } else if (token === 'm') {
        // moveto - requires 2 numbers
        if (stack.length >= 2) {
          if (currentPath.length > 0 && inCutContour) {
            paths.push([...currentPath]);
            currentPath = [];
          }
          const y = parseFloat(stack[stack.length - 1]);
          const x = parseFloat(stack[stack.length - 2]);
          if (inCutContour && !isNaN(x) && !isNaN(y)) {
            // Flip Y coordinate (PDF origin is bottom-left, canvas is top-left)
            currentPath.push({ x, y: pageHeight - y });
          }
        }
      } else if (token === 'l') {
        // lineto - requires 2 numbers
        if (stack.length >= 2 && inCutContour) {
          const y = parseFloat(stack[stack.length - 1]);
          const x = parseFloat(stack[stack.length - 2]);
          if (!isNaN(x) && !isNaN(y)) {
            currentPath.push({ x, y: pageHeight - y });
          }
        }
      } else if (token === 'c') {
        // curveto - requires 6 numbers, use endpoint
        if (stack.length >= 6 && inCutContour) {
          const y3 = parseFloat(stack[stack.length - 1]);
          const x3 = parseFloat(stack[stack.length - 2]);
          if (!isNaN(x3) && !isNaN(y3)) {
            currentPath.push({ x: x3, y: pageHeight - y3 });
          }
        }
      } else if (token === 'v' || token === 'y') {
        // curveto variants - requires 4 numbers
        if (stack.length >= 4 && inCutContour) {
          const y3 = parseFloat(stack[stack.length - 1]);
          const x3 = parseFloat(stack[stack.length - 2]);
          if (!isNaN(x3) && !isNaN(y3)) {
            currentPath.push({ x: x3, y: pageHeight - y3 });
          }
        }
      } else if (token === 're') {
        // rectangle - 4 numbers: x, y, width, height
        if (stack.length >= 4 && inCutContour) {
          const h = parseFloat(stack[stack.length - 1]);
          const w = parseFloat(stack[stack.length - 2]);
          const y = parseFloat(stack[stack.length - 3]);
          const x = parseFloat(stack[stack.length - 4]);
          if (!isNaN(x) && !isNaN(y) && !isNaN(w) && !isNaN(h)) {
            // Rectangle as 4 corners
            currentPath.push({ x, y: pageHeight - y });
            currentPath.push({ x: x + w, y: pageHeight - y });
            currentPath.push({ x: x + w, y: pageHeight - (y + h) });
            currentPath.push({ x, y: pageHeight - (y + h) });
            currentPath.push({ x, y: pageHeight - y }); // Close
          }
        }
      } else if (token === 'h') {
        // closepath
        if (currentPath.length > 0 && inCutContour) {
          currentPath.push({ ...currentPath[0] });
        }
      } else if (token === 'S' || token === 's' || token === 'f' || token === 'F' || 
                 token === 'B' || token === 'B*' || token === 'b' || token === 'b*' || 
                 token === 'f*' || token === 'n') {
        // stroke, fill, or end path
        if (currentPath.length > 0 && inCutContour) {
          paths.push([...currentPath]);
          currentPath = [];
        }
      }
      
      // Clear stack after any operator
      stack.length = 0;
    } else {
      // It's an operand (number or name) - push to stack
      stack.push(token);
    }
  }
  
  if (currentPath.length > 0) {
    paths.push(currentPath);
  }
  
  console.log('[PDF Parser] Extraction complete, found', paths.length, 'paths');
  return paths;
}

export function isPDFFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

// Generate a PDF with the image, a proper vector CutContour spot color path, and (if provided) White/Gloss spot layers.
export async function generatePDFWithVectorCutContour(
  image: HTMLImageElement,
  cutContourPoints: { x: number; y: number }[][],
  pageWidth: number,
  pageHeight: number,
  dpi: number,
  filename: string,
  cutContourLabel: string = 'CutContour',
  spotColors?: import('./contour-outline').SpotColorInput[],
  singleArtboard: boolean = false
): Promise<void> {
  const { PDFDocument, PDFName, PDFArray, PDFDict } = await import('pdf-lib');
  
  // Convert from pixels to points (72 points per inch)
  const widthPts = (pageWidth / dpi) * 72;
  const heightPts = (pageHeight / dpi) * 72;
  
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPts, heightPts]);
  const context = pdfDoc.context;
  
  // Embed the image
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  const imageDataUrl = canvas.toDataURL('image/png');
  const imageBytes = await fetch(imageDataUrl).then(res => res.arrayBuffer());
  const pngImage = await pdfDoc.embedPng(imageBytes);
  
  // Draw the image to fill the page
  page.drawImage(pngImage, {
    x: 0,
    y: 0,
    width: widthPts,
    height: heightPts,
  });
  
  // Create CutContour spot color using Separation color space
  if (cutContourPoints.length > 0 && cutContourPoints.some(path => path.length > 2)) {
    const tintFunction = context.obj({
      FunctionType: 2,
      Domain: [0, 1],
      C0: [0, 0, 0, 0],
      C1: [0, 1, 0, 0], // Magenta in CMYK
      N: 1,
    });
    const tintFunctionRef = context.register(tintFunction);
    
    const separationColorSpace = context.obj([
      PDFName.of('Separation'),
      PDFName.of(cutContourLabel),
      PDFName.of('DeviceCMYK'),
      tintFunctionRef,
    ]);
    const separationRef = context.register(separationColorSpace);
    
    // Add color space to page resources
    const resources = page.node.Resources();
    if (resources) {
      let colorSpaceDict = resources.get(PDFName.of('ColorSpace'));
      if (!colorSpaceDict) {
        colorSpaceDict = context.obj({});
        resources.set(PDFName.of('ColorSpace'), colorSpaceDict);
      }
      (colorSpaceDict as any).set(PDFName.of(cutContourLabel), separationRef);
    }
    
    // Build path operators
    let pathOps = `/${cutContourLabel} CS 1 SCN\n0.5 w\n`;
    
    for (const path of cutContourPoints) {
      if (path.length < 2) continue;
      
      // Scale from pixels to points and flip Y coordinate
      const scaleX = widthPts / pageWidth;
      const scaleY = heightPts / pageHeight;
      
      const startX = path[0].x * scaleX;
      const startY = heightPts - (path[0].y * scaleY);
      pathOps += `${startX.toFixed(4)} ${startY.toFixed(4)} m\n`;
      
      for (let i = 1; i < path.length; i++) {
        const x = path[i].x * scaleX;
        const y = heightPts - (path[i].y * scaleY);
        pathOps += `${x.toFixed(4)} ${y.toFixed(4)} l\n`;
      }
      
      pathOps += 'S\n';
    }
    
    // Append to page content stream
    const existingContents = page.node.Contents();
    if (existingContents) {
      const contentStream = context.stream(pathOps);
      const contentStreamRef = context.register(contentStream);
      
      if (existingContents instanceof PDFArray) {
        existingContents.push(contentStreamRef);
      } else {
        const newContents = context.obj([existingContents, contentStreamRef]);
        page.node.set(PDFName.of('Contents'), newContents);
      }
    }
  }
  
  // Layer any tagged White/Gloss on top — otherwise a customer's spot-color tagging is silently lost on this path.
  if (spotColors && spotColors.length > 0) {
    const { addSpotColorVectorsToPDF } = await import('./spot-color-vectors');
    await addSpotColorVectorsToPDF(
      pdfDoc, page, image, spotColors,
      pageWidth / dpi, pageHeight / dpi,
      pageHeight / dpi, 0, 0,
      singleArtboard, widthPts, heightPts
    );
  }

  pdfDoc.setTitle('PDF with CutContour');
  pdfDoc.setSubject(`Contains ${cutContourLabel} spot color for cutting machines`);
  pdfDoc.setKeywords([cutContourLabel, 'spot color', 'cutting', 'vector']);

  const pdfBytes = await pdfDoc.save();
  const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(pdfBlob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

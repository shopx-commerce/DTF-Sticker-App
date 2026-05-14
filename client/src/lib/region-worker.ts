interface RegionWorkerInput {
  pixelMap: Int16Array;
  width: number;
  height: number;
  colorCount: number;
}

interface RegionResult {
  colorIndex: number;
  regions: Array<{
    id: number;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    pixelCount: number;
    percentage: number;
    pixelIndices: number[];
  }>;
  regionMap: Int32Array;
}

self.onmessage = (e: MessageEvent<RegionWorkerInput>) => {
  const { pixelMap, width, height, colorCount } = e.data;
  const totalPixels = width * height;
  const results: RegionResult[] = [];

  for (let ci = 0; ci < colorCount; ci++) {
    const mask = new Uint8Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
      if (pixelMap[i] === ci) mask[i] = 1;
    }

    const labels = new Int32Array(totalPixels).fill(-1);
    const components: { id: number; pixels: number[]; minX: number; minY: number; maxX: number; maxY: number }[] = [];
    const queue: number[] = [];
    let compId = 0;

    for (let i = 0; i < totalPixels; i++) {
      if (mask[i] === 0 || labels[i] !== -1) continue;

      let minX = width, minY = height, maxX = 0, maxY = 0;
      const compPixels: number[] = [];
      queue.length = 0;
      queue.push(i);
      labels[i] = compId;

      let head = 0;
      while (head < queue.length) {
        const idx = queue[head++];
        compPixels.push(idx);
        const x = idx % width;
        const y = (idx / width) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        // 4-connectivity: only up/down/left/right — keeps diagonally-touching blobs as separate regions
        if (x > 0 && mask[idx - 1] === 1 && labels[idx - 1] === -1) { labels[idx - 1] = compId; queue.push(idx - 1); }
        if (x < width - 1 && mask[idx + 1] === 1 && labels[idx + 1] === -1) { labels[idx + 1] = compId; queue.push(idx + 1); }
        if (y > 0 && mask[idx - width] === 1 && labels[idx - width] === -1) { labels[idx - width] = compId; queue.push(idx - width); }
        if (y < height - 1 && mask[idx + width] === 1 && labels[idx + width] === -1) { labels[idx + width] = compId; queue.push(idx + width); }
      }

      components.push({ id: compId, pixels: compPixels, minX, minY, maxX, maxY });
      compId++;
    }

    const minArea = Math.max(16, totalPixels * 0.00005);
    const significant = components
      .filter(c => c.pixels.length >= minArea)
      .sort((a, b) => b.pixels.length - a.pixels.length);

    if (significant.length < 2) continue;

    const regionMap = new Int32Array(totalPixels).fill(-1);
    const regions = significant.map((comp, idx) => {
      for (const pi of comp.pixels) {
        regionMap[pi] = idx;
      }
      return {
        id: idx,
        bbox: { minX: comp.minX, minY: comp.minY, maxX: comp.maxX, maxY: comp.maxY },
        pixelCount: comp.pixels.length,
        percentage: parseFloat(((comp.pixels.length / totalPixels) * 100).toFixed(2)),
        pixelIndices: [...comp.pixels],
      };
    });

    // Assign orphan pixels (small clusters below minArea) to nearest significant region,
    // but only if the orphan falls within that region's bounding box + a margin.
    // This prevents remote scattered dots from polluting other region's selection.
    const centroids = significant.map(comp => {
      let cx = 0, cy = 0;
      for (const pi of comp.pixels) {
        cx += pi % width;
        cy += (pi / width) | 0;
      }
      return { x: cx / comp.pixels.length, y: cy / comp.pixels.length };
    });
    const bboxMargin = Math.max(8, Math.sqrt(totalPixels) * 0.03); // ~3% of image dimension

    for (let i = 0; i < totalPixels; i++) {
      if (mask[i] === 1 && regionMap[i] === -1) {
        const px = i % width;
        const py = (i / width) | 0;
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let r = 0; r < significant.length; r++) {
          const comp = significant[r];
          // Only consider regions whose bounding box (+ margin) contains this orphan
          if (px < comp.minX - bboxMargin || px > comp.maxX + bboxMargin ||
              py < comp.minY - bboxMargin || py > comp.maxY + bboxMargin) continue;
          const dx = px - centroids[r].x;
          const dy = py - centroids[r].y;
          const dist = dx * dx + dy * dy;
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = r;
          }
        }
        if (bestIdx < 0) continue; // orphan is too far from all regions — leave as -1
        regionMap[i] = bestIdx;
        const reg = regions[bestIdx];
        reg.pixelCount++;
        reg.pixelIndices.push(i);
        if (px < reg.bbox.minX) reg.bbox.minX = px;
        if (px > reg.bbox.maxX) reg.bbox.maxX = px;
        if (py < reg.bbox.minY) reg.bbox.minY = py;
        if (py > reg.bbox.maxY) reg.bbox.maxY = py;
      }
    }

    results.push({ colorIndex: ci, regions, regionMap });
  }

  const transferables = results.map(r => r.regionMap.buffer);
  (self as unknown as Worker).postMessage(results, transferables);
};

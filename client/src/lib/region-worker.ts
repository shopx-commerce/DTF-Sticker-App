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

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const ni = ny * width + nx;
            if (mask[ni] === 1 && labels[ni] === -1) {
              labels[ni] = compId;
              queue.push(ni);
            }
          }
        }
      }

      components.push({ id: compId, pixels: compPixels, minX, minY, maxX, maxY });
      compId++;
    }

    const minArea = totalPixels * 0.0005;
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

    // Assign orphan pixels (small clusters below minArea) to nearest significant region
    const centroids = significant.map(comp => {
      let cx = 0, cy = 0;
      for (const pi of comp.pixels) {
        cx += pi % width;
        cy += (pi / width) | 0;
      }
      return { x: cx / comp.pixels.length, y: cy / comp.pixels.length };
    });

    for (let i = 0; i < totalPixels; i++) {
      if (mask[i] === 1 && regionMap[i] === -1) {
        const px = i % width;
        const py = (i / width) | 0;
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let r = 0; r < centroids.length; r++) {
          const dx = px - centroids[r].x;
          const dy = py - centroids[r].y;
          const dist = dx * dx + dy * dy;
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = r;
          }
        }
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

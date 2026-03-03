interface EnhanceRequest {
  type: 'enhance';
  imageBitmap: ImageBitmap;
  mode: 'design' | 'faces';
  width: number;
  height: number;
}

interface EnhanceProgress {
  type: 'progress';
  stage: string;
  percent: number;
}

interface EnhanceResult {
  type: 'result';
  blob: Blob;
  enhancedWidth: number;
  enhancedHeight: number;
}

interface EnhanceError {
  type: 'error';
  error: string;
}

type OutboundMessage = EnhanceProgress | EnhanceResult | EnhanceError;

const ctx = self as unknown as Worker;

function postProgress(stage: string, percent: number) {
  ctx.postMessage({ type: 'progress', stage, percent } satisfies EnhanceProgress);
}

ctx.onmessage = async (e: MessageEvent<EnhanceRequest>) => {
  const { imageBitmap, mode, width, height } = e.data;

  try {
    postProgress('Preparing image…', 5);

    const offscreen = new OffscreenCanvas(width, height);
    const oc = offscreen.getContext('2d');
    if (!oc) throw new Error('Could not create OffscreenCanvas 2d context');
    oc.drawImage(imageBitmap, 0, 0);
    imageBitmap.close();

    postProgress('Encoding PNG…', 15);
    const blob = await offscreen.convertToBlob({ type: 'image/png' });

    const longestSide = Math.max(width, height);
    const scale = longestSide >= 2000 ? 2 : 4;

    const formData = new FormData();
    formData.append('image', blob, 'image.png');
    formData.append('model', mode === 'faces' ? 'general_face' : 'anime');
    formData.append('scale', String(scale));

    postProgress('Uploading to AI…', 25);

    const response = await fetch('/api/enhance-image', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Server error ${response.status}`);
    }

    postProgress('Downloading enhanced image…', 75);

    const enhancedBlob = await response.blob();

    postProgress('Decoding…', 90);
    const enhanced = await createImageBitmap(enhancedBlob);
    const enhancedWidth = enhanced.width;
    const enhancedHeight = enhanced.height;
    enhanced.close();

    postProgress('Done', 100);

    ctx.postMessage({
      type: 'result',
      blob: enhancedBlob,
      enhancedWidth,
      enhancedHeight,
    } satisfies EnhanceResult);
  } catch (err: any) {
    ctx.postMessage({
      type: 'error',
      error: err?.message || 'Enhancement failed',
    } satisfies EnhanceError);
  }
};

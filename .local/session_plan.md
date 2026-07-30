# Objective
Replace the Replicate API call in the enhance-image endpoint with Sharp's built-in Lanczos upscaling for instant (< 2 second) image enhancement with no external API dependency.

# Tasks

### T001: Replace Replicate with Sharp upscaling in server route
- **Blocked By**: []
- **Details**:
  - Rewrite the `/api/enhance-image` route in `server/routes.ts` to use Sharp instead of Replicate
  - Use Sharp's `resize()` with `kernel: sharp.kernel.lanczos3` for high-quality upscaling
  - Keep 2x scale factor, cap output at 8000px max dimension
  - Apply sharpening after upscale (`sharpen()`) for crisper sticker output
  - Remove Replicate-specific code (API token check, data URI encoding, URL download)
  - Keep the same response format (PNG buffer with X-Enhanced-Width/Height headers)
  - Files: `server/routes.ts`
  - Acceptance: Enhancement completes in under 2 seconds with clean PNG output

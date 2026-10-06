import { BlockPipeline } from '../src/ui/block-pipeline.mjs';
import { blockState } from '../src/core/block-area.mjs';

// Harness entry for `tools/verify-block-gl.mjs`.
//
// It exists because the unit tests run against a stub GL context: they prove the pass order, the
// fixed-function state and the sampler wiring, but not that the vendored GLSL actually compiles and
// produces pixels on a real driver. This runs the pipeline in Electron's Chromium and reads the
// default framebuffer back, so "it compiles" becomes "it draws".

/**
 * Render `blocks` at each of `times` and report what landed in the framebuffer.
 *
 * `assetBase` must be a `file://` directory URL ending in a slash; the verifier runs Chromium with
 * web security off so the vendored PNGs can be read straight from disk.
 */
export async function run({ shaders, materials, assetBase, blocks, times, width, height, scene = null }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const pipeline = new BlockPipeline();
  if (!pipeline.ensure(canvas, shaders, materials)) return { ok: false, stage: 'ensure', error: pipeline.lastError || 'ensure failed' };
  try {
    await pipeline.loadImages(assetBase);
  } catch (error) {
    return { ok: false, stage: 'loadImages', error: String(error && error.message || error) };
  }

  const results = [];
  for (const now of times) {
    pipeline.render({ blocks, now, aspect: width / height, width, height, scene });
    const gl = pipeline.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0;
    let opaque = 0;
    let sum = 0;
    let maxAlpha = 0;
    const buckets = new Map();
    for (let index = 0; index < pixels.length; index += 4) {
      const [r, g, b, a] = [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]];
      if (a > 0) lit += 1;
      if (a > 200) opaque += 1;
      sum += r + g + b;
      if (a > maxAlpha) maxAlpha = a;
      // Coarse colour census, enough to tell the phases apart.
      const key = `${r >> 5},${g >> 5},${b >> 5}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const total = width * height;
    results.push({
      now,
      visible: blocks.filter((block) => blockState(block, now)).length,
      litRatio: lit / total,
      opaqueRatio: opaque / total,
      meanRgb: sum / (total * 3),
      maxAlpha,
      dominant: [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([key, count]) => ({ rgb5: key, ratio: count / total })),
    });
  }
  return { ok: true, results, programs: [...pipeline.programs.keys()] };
}

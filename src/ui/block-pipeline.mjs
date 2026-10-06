// BlockArea render pipeline — a browser port of Phigros 4.0.1's `BlockRender`.
//
// Source of truth for everything here is the reverse-engineering dump (`render.md` and the vendored
// Unity HLSLCC output in `public/assets/rpe/block/shaders.json`). Three things are worth knowing
// before reading further:
//
//  1. Blend state, ColorMask and cull mode are NOT in the GLSL. Unity keeps them in the Shader
//     asset, so they had to be recovered separately. `PASS_STATE` below is that table; without it
//     the composite is wrong (notably `ActiveBlock` is premultiplied `One, OneMinusSrcAlpha`, not
//     straight alpha).
//  2. The game's vertex stage exists only to feed varyings. Every one is a trivial function of the
//     quad's UV (`uv * _ST.xy + _ST.zw`) except `vs_TEXCOORD3` (Unity's ComputeScreenPos) and
//     `vs_TEXCOORD6` (the constant 16:9 band `(8/9)·H/W`). This port supplies its own vertex stage
//     emitting the same names and keeps the game's fragment stage verbatim.
//  3. Nothing here is per-judge-line: blocks are screen-percentage rectangles, and the whole
//     pipeline runs at reduced resolution (masks at Screen/8, effects at Screen/4), Point-filtered,
//     exactly as the game does.

import { blockState, blockTransform, blockScreen, blockShowCoverage } from '../core/block-area.mjs';

// Render targets, in the game's own names, sizes and filter modes (render.md §RT 尺寸与格式).
//
// The dump reports Unity's serialised format enums (16 and 25) without a mapping, but the vendored
// fragment stages pin the channel usage down: `BlockCompose` pass 0 writes a single float and both
// `EdgeMask` pass 1 and `GlowMask` pass 1 write one channel each, so format 16 is R8; pass 1 of
// `BlockCompose` writes `vec2` and samples `_DisabledSubtractBlockRT.xy`, so format 25 is RG16.
// This port allocates RGBA8 everywhere instead — a strict superset, so every channel any shader
// reads exists. `effectRT` keeps its RG16 layout conceptually (`.x` edge, `.y` glow).
export const RENDER_TARGETS = [
  { key: 'sceneColorRT', divisor: 6, linear: false },
  { key: 'normalBlockRT', divisor: 8, linear: false },
  { key: 'subtractBlockRT', divisor: 8, linear: false },
  { key: 'composedEnabledBlockRT', divisor: 8, linear: false },
  { key: 'disabledNormalBlockRT', divisor: 8, linear: false },
  { key: 'disabledSubtractBlockRT', divisor: 8, linear: false },
  { key: 'disabledNormalReadyBlockRT', divisor: 8, linear: false },
  { key: 'disabledSubtractReadyBlockRT', divisor: 8, linear: false },
  { key: 'composedDisabledBlockRT', divisor: 8, linear: false },
  { key: 'touchBlockRT', divisor: 8, linear: false },
  { key: 'effectRT', divisor: 4, linear: true },
  { key: 'pingA', divisor: 4, linear: false },
  { key: 'pingB', divisor: 4, linear: false },
];

/**
 * Port-internal scratch targets.
 *
 * `SubtractBlockPostProcessor.OnRenderImage` blits `source -> destination` through
 * `subtractBlockMaterial`, and the three instances live on the subtract-family cameras. A camera
 * that renders in place still gets distinct source and destination handles because Unity allocates
 * an internal temp, so these two Screen/8 targets stand in for it. They are deliberately kept out
 * of the game's 13.
 */
export const SCRATCH_TARGETS = [
  { key: 'scratchA', divisor: 8, linear: false },
  { key: 'scratchB', divisor: 8, linear: false },
  // The scene subtract needs the raw `subtractBlockRT` attribution, and both other scratches are
  // already spoken for by the two `BlockCompose` passes, so it gets its own.
  { key: 'scratchC', divisor: 8, linear: false },
];

// Unity's serialised `m_State` per shader pass (render.md §固定管线状态). `blend` is
// [src, dst] in WebGL terms; `mask` is which colour channels the pass is allowed to write.
const PASS_STATE = {
  BlockSprite: { blend: ['SRC_ALPHA', 'ONE'], mask: ['R', 'G', 'B', 'A'] },
  SubtractBlockBlender: { blend: ['ONE', 'ZERO'], mask: ['R', 'G', 'B', 'A'] },
  BlockCompose: { blend: ['ONE', 'ZERO'], mask: ['R', 'G', 'B', 'A'] },
  EdgeMask: [{ blend: ['ONE', 'ZERO'], mask: ['R', 'G', 'B', 'A'] }, { blend: ['ONE', 'ZERO'], mask: ['R'] }],
  GlowMask: [{ blend: ['ONE', 'ZERO'], mask: ['R', 'G'] }, { blend: ['ONE', 'ZERO'], mask: ['G'] }],
  DisabledBlock: { blend: ['ONE', 'ONE'], mask: ['R', 'G', 'B', 'A'] },
  ReadyBlock: { blend: ['SRC_ALPHA', 'ONE'], mask: ['R', 'G', 'B', 'A'] },
  // Premultiplied: `dst = src + dst·(1 − srcA)`, NOT straight alpha. The fragment does not
  // premultiply, which is why filled regions add their full rgb and the background is attenuated.
  ActiveBlock: { blend: ['ONE', 'ONE_MINUS_SRC_ALPHA'], mask: ['R', 'G', 'B', 'A'] },
  TouchEffect: { blend: ['ONE', 'ONE'], mask: ['R', 'G', 'B', 'A'] },
  // Port-local, see `SUBTRACT_SCENE_FRAGMENT`: overwrites the scene copy rather than blending into it.
  SubtractScene: { blend: ['ONE', 'ZERO'], mask: ['R', 'G', 'B', 'A'] },
};

const BLEND_FACTORS = { ZERO: 0, ONE: 1, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303 };
const MASK_BITS = { R: 0x4000, G: 0x4000 >> 1, B: 0x4000 >> 2, A: 0x4000 >> 3 };

// The vertex stage is the game's own, taken from the same vendored dump rather than hand-written.
//
// A shared vertex shader cannot work: `vs_TEXCOORDn` numbering is assigned per program, so
// `vs_TEXCOORD3` is a `vec4` screen position in ActiveBlock but a `vec2` spark-map UV in
// DisabledBlock and TouchEffect, and one shader emitting the first fails to link the others with
// "Types of varying 'vs_TEXCOORD3' differ between VERTEX and FRAGMENT shaders". Compiling each
// program's own vertex stage keeps the types and the meanings matched by construction.
//
// Unity's stage reads `hlslcc_mtx4x4unity_ObjectToWorld` and `hlslcc_mtx4x4unity_MatrixVP`; feeding
// it the identity and this port's projection needs no rewriting at all — the model transform is
// already folded into the projection on the CPU.

/** Attribute layout, in floats: position.xyzw, uv.xy, colour.rgba. */
export const QUAD_VERTICES = new Float32Array([
  0, 0, 0, 1, 0, 0, 1, 1, 1, 1,
  1, 0, 0, 1, 1, 0, 1, 1, 1, 1,
  0, 1, 0, 1, 0, 1, 1, 1, 1, 1,
  1, 1, 0, 1, 1, 1, 1, 1, 1, 1,
]);
const QUAD_STRIDE = 10 * 4;
const ATTRIBUTE_OFFSET = { in_POSITION0: 0, in_TEXCOORD0: 4 * 4, in_COLOR0: 6 * 4 };

/**
 * Sampler name -> vendored file, with the texture's import settings from materials.md §1.
 *
 * The wrap modes are not cosmetic: `FD_Noise` and `BlockNoise1` are **Mirror** and `PointNoise` is
 * **Repeat**, so out-of-range sampling mirrors rather than clamping, which changes the edges at low
 * `_ST` frequencies. Every texture is Point-filtered with no mipmaps, matching `MipCount = 1`.
 */
const TEXTURE_SLOTS = {
  _DisplaceMap: { file: 'BlockNoise1.png', wrap: 'MIRRORED_REPEAT' },
  _SparkMap: { file: 'PointNoise.png', wrap: 'REPEAT' },
  _NoiseMap: { file: 'FD_Noise.png', wrap: 'MIRRORED_REPEAT' },
  _TouchDisplaceMap: { file: 'BlockNoise1.png', wrap: 'MIRRORED_REPEAT' },
  _MainTex: { file: 'Block.png', wrap: 'CLAMP_TO_EDGE' },
};

/**
 * Per-material texture tiling (`_ST.xy`; every offset is 0). From the `m_TexEnvs` table in
 * materials.md — the dump's JSON has no machine-readable copy, so these are the one set of numbers
 * still transcribed by hand. `block-pipeline.test.mjs` pins each pair against that table.
 */
export const TEXTURE_ST = {
  ActiveBlock: { _DisplaceMap: [0.80, 0.30], _SparkMap: [3.00, 1.20], _NoiseMap: [1.50, 1.46], _TouchDisplaceMap: [0.55, 0.30] },
  BlockCompose: { _DisplaceMap: [2.13, 1.02] },
  DisabledBlock: { _DisplaceMap: [0.50, 0.20], _SparkMap: [3.00, 1.20] },
  TouchEffect: { _DisplaceMap: [0.55, 0.30], _NoiseMap: [1.50, 1.46] },
};

// Material tuning values are NOT transcribed here. `tools/copy-block-assets.mjs` generates
// `public/assets/rpe/block/materials.json` straight from the dump's material table, because
// hand-copying them proved wrong for a dozen floats and for `_DisplaceDirection`.

/**
 * Port of `GetGlowRingWeight`.
 *
 * Its two epsilons are `.rodata` constants, **not** the named tuning fields — the dump's own
 * erratum corrects an earlier reading of this: `kEpsFalloff = 0.001`, `kEpsSum = 1e-6`. With
 * `glowRadius = 6` and `glowWeightFalloff = 2.65` the rings weigh
 * 0.4586 / 0.2829 / 0.1566 / 0.0731 / 0.0249 / 0.0040, so the 0.01 pass threshold cuts the sixth.
 */
export function glowRingWeight(passIndex, glowRadius = 6, falloff = 2.65) {
  const kEpsFalloff = 0.001;
  const kEpsSum = 1e-6;
  if (glowRadius < 1) return 0;
  if (falloff > kEpsFalloff) {
    let sum = 0;
    for (let ring = glowRadius; ring > 0; ring--) sum += ring ** falloff;
    if (sum > kEpsSum) return (glowRadius - passIndex) ** falloff / sum;
  }
  return 1 / glowRadius;
}

/** The rings `RenderEffects` actually issues, i.e. those not below the pass threshold. */
export function glowRingWeights(glowRadius = 6, falloff = 2.65, threshold = 0.01) {
  if (glowRadius < 1) return [];
  const first = glowRingWeight(0, glowRadius, falloff);
  if (first < threshold) return [];
  const weights = [first];
  for (let pass = 1; pass < glowRadius; pass++) {
    const weight = glowRingWeight(pass, glowRadius, falloff);
    if (weight < threshold) break;
    weights.push(weight);
  }
  return weights;
}

/**
 * Make a vendored fragment stage acceptable to WebGL2.
 *
 * HLSLCC emits `#define UNITY_LOCATION(x) layout(location = x)` and stamps every sampler with it.
 * GLSL ES 3.00 — and so WebGL2 — rejects `layout(location = ...)` on anything but a program input or
 * output, so all thirteen programs failed to compile with
 * `'location' : invalid layout qualifier: only valid on program inputs and outputs`.
 *
 * The file already carries an empty definition for platforms without uniform locations, behind
 * `UNITY_SUPPORTS_UNIFORM_LOCATION`; flipping that guard to 0 selects it. That is the whole fix:
 * the samplers become plain uniforms, still bound by name, and `applyUniforms` hands each one a
 * distinct texture unit. Nothing else is rewritten, so the vendored JSON stays byte-faithful.
 */
export function adaptFragment(source) {
  return source.replace(/^([ \t]*#define[ \t]+UNITY_SUPPORTS_UNIFORM_LOCATION[ \t]+)1[ \t]*$/m, '$10');
}

/**
 * Port-local pass: scale `sceneColorRT` by `1 - subtractAttribution` so a subtract block removes the
 * scene colour instead of showing as a translucent red block.
 *
 * The game does this with `SubtractBlockPostProcessor.OnRenderImage`, which blits the subtract
 * camera's target through `subtractBlockMaterial` at `targetPass` 0/1. That material is
 * `Unlit/SubtractBlockBlender`, whose declared outputs are a scalar attribution and a `vec2` — it is a
 * *mask* operator, and the shader asset does not contain the scene operation at all; the engine's Blit
 * supplies it. `render.md` records the branch (`if (cam.targetTexture == null) Blit(src, dest); else
 * Blit(src, dest, material, targetPass)`) but not the blend factor that `targetPass` selects, so **the
 * multiply below is this port's reconstruction, not a transcription**. It is the reading that makes the
 * recorded symptom true: a subtract block removes the scene colour, which is why its `0.1` alpha is
 * otherwise almost invisible.
 *
 * The multiply is applied across the whole scene copy, where the game's Blit targets the camera. That
 * is deliberately wider than the mask's reach — `render.md` says the attribution itself only ever
 * reaches `composedEnabledBlockRT` — and it is harmless for the same reason: `ActiveBlock` samples
 * `_SceneColor` only inside its enabled-block spark/hue term, and a transparent scene contributes
 * nothing there.
 */
const SUBTRACT_SCENE_FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D _SceneColor;
uniform sampler2D _Mask;
in vec2 vs_TEXCOORD0;
out vec4 SV_Target0;
void main() {
  float attribution = texture(_Mask, vs_TEXCOORD0.xy).x;
  float keep = clamp(1.0 - attribution, 0.0, 1.0);
  SV_Target0 = texture(_SceneColor, vs_TEXCOORD0.xy) * keep;
}
`;

const SUBTRACT_SCENE_VERTEX = `#version 300 es
precision highp float;
uniform vec4 hlslcc_mtx4x4unity_MatrixVP[4];
in vec4 in_POSITION0;
in vec2 in_TEXCOORD0;
out highp vec2 vs_TEXCOORD0;
void main() {
  vs_TEXCOORD0.xy = in_TEXCOORD0.xy;
  gl_Position = hlslcc_mtx4x4unity_MatrixVP[0] * in_POSITION0.xxxx
              + hlslcc_mtx4x4unity_MatrixVP[1] * in_POSITION0.yyyy
              + hlslcc_mtx4x4unity_MatrixVP[2] * in_POSITION0.zzzz
              + hlslcc_mtx4x4unity_MatrixVP[3] * in_POSITION0.wwww;
}
`;

/**
 * The two textures `materials.md` §1 marks sRGB. `Block.png` is uniform red so decoding it is a
 * no-op, but it is listed for completeness.
 */
const SRGB_TEXTURES = new Set(['Block.png', 'BlockNoise1.png']);

/**
 * Decode an sRGB-encoded image to linear and re-quantise to 8-bit, for upload as raw RGBA.
 *
 * WebGL cannot be asked to do this for a plain `RGBA`/`UNSIGNED_BYTE` upload: that combination is
 * non-sRGB, and `UNPACK_COLORSPACE_CONVERSION_WEBGL` is a no-op in WebGL2, so the decode has to
 * happen on the CPU. The result is not byte-exact with a hardware decode — linear values are quantised
 * to 8 bits — but it is the same curve, which is what the shaders' colour arithmetic needs.
 */
function decodeSrgbToBytes(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth ?? image.width;
  canvas.height = image.naturalHeight ?? image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const linear = (value) => {
    const channel = value / 255;
    const decoded = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return Math.round(Math.max(0, Math.min(1, decoded)) * 255);
  };
  for (let index = 0; index < pixels.data.length; index += 4) {
    pixels.data[index] = linear(pixels.data[index]);
    pixels.data[index + 1] = linear(pixels.data[index + 1]);
    pixels.data[index + 2] = linear(pixels.data[index + 2]);
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`着色器编译失败: ${log}`);
  }
  return shader;
}

export class BlockPipeline {
  constructor() {
    this.gl = null;
    this.canvas = null;
    this.targets = new Map();
    this.programs = new Map();
    this.textures = new Map();
    this.disabled = false;
    this.lastError = '';
    // On by default, and not merely a hypothesis: `ActiveBlock` has exactly three contributions —
    // the enabled look gated on `glow + edge + enabledMask`, the ready pulse gated on
    // `_ReadyComposeRT.x · abs(m)`, and the touch layer. It has no disabled-fill path at all, and for
    // a disabled-but-not-ready block every one of those gates is zero, so it draws nothing. Only
    // `DisabledBlock` can make such a block visible. That product is also why the two masks exist:
    // `_ReadyComposeRT` holds disabled *and* ready, `abs(m)` holds pure ready, and multiplying them
    // isolates ready.
    this.sceneEffects = true;
    // When off, `sceneColorRT` stays transparent, so `ActiveBlock`'s displaced `_SceneColor` term
    // contributes nothing and a block renders as its fill, edge and glow alone. The game samples the
    // camera target there, which is why a block shows a distorted copy of the notes and judge lines
    // it overlaps — faithful, but it reads as a doubled image in a still editor frame.
    this.sceneDistortion = true;
    // `'srgb'` (default) decodes `Block`/`BlockNoise1` to linear, which is what `materials.md` §1's
    // `colorSpace` column asks for; `'raw'` uploads the PNGs as stored. See `loadImages` for the
    // measured difference between the two readings, and why the decode is not the default it once was.
    this.textureColorSpace = 'srgb';
    // `BlockRender` tuning fields from data.md. The edge dilates one round; the glow is nominally
    // six, but the sixth ring's weight (0.0040) sits below the pass threshold, so five run.
    this.edgeSize = 1;
    this.glowRadius = 6;
    this.glowWeightFalloff = 2.65;
    this.glowPassWeightThreshold = 0.01;
  }

  /** Wire up WebGL, compile the vendored programs and take the generated material table. */
  ensure(canvas, shaders, materials = null) {
    if (this.canvas === canvas && this.gl) return true;
    this.canvas = canvas;
    this.materials = materials?.materials ?? null;
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    } catch { gl = null; }
    if (!gl) { this.disabled = true; this.lastError = 'WebGL2 不可用'; return false; }
    this.gl = gl;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);
    // Compile every program before giving up, and report all of them: bailing on the first failure
    // hides whether one shader is broken or a dozen are.
    const failures = [];
    for (const [key, programs] of Object.entries(shaders.programs)) {
      try { this.programs.set(key, programs.map((program, index) => this.buildProgram(key, index, program))); }
      catch (error) { failures.push(String((error && error.message) || error)); }
    }
    if (failures.length) {
      this.disabled = true;
      this.lastError = failures.join(' | ');
      return false;
    }
    for (const target of [...RENDER_TARGETS, ...SCRATCH_TARGETS]) this.createTarget(target);
    for (const [name, slot] of Object.entries(TEXTURE_SLOTS)) this.loadTexture(name, slot);
    // The subtract scene pass is port-local, so it is compiled here instead of coming from the dump.
    // It reuses `PASS_STATE.SubtractScene`; `applyUniforms` unbinds nothing, so leaving `defaults`
    // empty is fine — every uniform it has is set explicitly by `subtractScene`.
    try {
      const vertex = compile(gl, gl.VERTEX_SHADER, SUBTRACT_SCENE_VERTEX);
      const fragment = compile(gl, gl.FRAGMENT_SHADER, SUBTRACT_SCENE_FRAGMENT);
      const handle = gl.createProgram();
      gl.attachShader(handle, vertex);
      gl.attachShader(handle, fragment);
      gl.linkProgram(handle);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(handle));
      const uniforms = new Map();
      const types = new Map();
      for (let slot = 0; slot < gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS); slot++) {
        const info = gl.getActiveUniform(handle, slot);
        const name = info.name.replace(/\[0\]$/, '');
        uniforms.set(name, gl.getUniformLocation(handle, info.name));
        types.set(name, info.type);
      }
      this.programs.set('SubtractScene', [{ key: 'SubtractScene', index: 0, handle, uniforms, types, state: PASS_STATE.SubtractScene, source: { vertex: SUBTRACT_SCENE_VERTEX, fragment: SUBTRACT_SCENE_FRAGMENT } }]);
    } catch (error) {
      failures.push(String((error && error.message) || error));
    }
    if (failures.length) {
      this.disabled = true;
      this.lastError = failures.join(' | ');
      return false;
    }
    return true;
  }

  buildProgram(key, index, program) {
    const gl = this.gl;
    // Each program keeps its own vertex stage, so the varying types match by construction.
    const vertex = compile(gl, gl.VERTEX_SHADER, adaptFragment(program.vertex));
    const fragment = compile(gl, gl.FRAGMENT_SHADER, adaptFragment(program.fragment));
    const handle = gl.createProgram();
    gl.attachShader(handle, vertex);
    gl.attachShader(handle, fragment);
    gl.linkProgram(handle);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(handle);
      gl.deleteProgram(handle);
      throw new Error(`${key}#${index} 链接失败: ${log}`);
    }
    const uniforms = new Map();
    const types = new Map();
    for (let slot = 0; slot < gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS); slot++) {
      const info = gl.getActiveUniform(handle, slot);
      const name = info.name.replace(/\[0\]$/, '');
      uniforms.set(name, gl.getUniformLocation(handle, info.name));
      types.set(name, info.type);
    }
    const state = Array.isArray(PASS_STATE[key]) ? PASS_STATE[key][index] : PASS_STATE[key];
    // `adaptFragment` strips the explicit texture units, so the samplers are plain uniforms and
    // `applyUniforms` fully controls each one's unit — which is why enumerating them is safe here.
    return { key, index, handle, uniforms, types, state, source: program };
  }

  createTarget({ key, divisor, linear }) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.targets.set(key, { texture, framebuffer: gl.createFramebuffer(), divisor, width: 0, height: 0 });
  }

  loadTexture(name, slot) {
    const gl = this.gl;
    const wrap = slot.wrap === 'REPEAT' ? gl.REPEAT : slot.wrap === 'MIRRORED_REPEAT' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Every block texture is Point-filtered with a single mip in the game, so linear filtering or a
    // mipmapped minification would make the noise visibly blurrier than it is.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    // 1x1 opaque black until the image arrives; the composite tolerates it.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.textures.set(name, { texture, file: slot.file, wrap: slot.wrap, image: null });
  }

  /**
   * Upload the vendored PNGs once they are decoded.
   *
   * `materials.md` §1 lists a `colorSpace` per texture (`BlockNoise1` and `Block` sRGB, `PointNoise`
   * and `FD_Noise` linear), and every value `block-params.json` carries is a *linear* one, so the two
   * sRGB textures are decoded on upload and the other two are not. The measured consequence of the
   * decode, which is worth stating precisely rather than hand-waving:
   *
   * - `BlockNoise1` (the displacement map) has mean `0.5041` as stored but `0.2382` once decoded, so
   *   the decode does **not** bias the ripple itself — `BlockCompose` centres on the literal `- 0.5`
   *   either way — but it does make `dispAvg` average ≈0.24 instead of ≈0.50, and `dispAvg` also
   *   drives the fill colour through `_FillColor - dispAvg · _DisplaceBlendIntensity`. Raw mean gives
   *   `fillBase ≈ 0.711`, decoded gives `≈ 0.821`, so the decoded reading is the brighter one.
   * - `PointNoise` (the spark map) is sparse either way — only 7.1 % of its texels exceed `0.1` as
   *   stored, 0.8 % once decoded — so the spark term is near zero over most of a block in both
   *   readings. That is why the block fill reads as a dark red rather than the `_FillColor` swatch.
   * - `Block.png` is unaffected: it is uniform red, and `1.0` decodes to `1.0`.
   *
   * The switch is kept because the dump does not record whether Unity's `sRGBTexture` flag reaches
   * these shaders as a decode, so the undocumented reading stays reachable: `textureColorSpace = 'raw'`
   * uploads the PNGs as stored. `'srgb'` is the direction `materials.md` names and is therefore the
   * default; it used to be `'raw'`, which showed as a darker fill than the dump implies.
   */
  async loadImages(base = `${import.meta.env?.BASE_URL ?? '/'}assets/rpe/block/`) {
    await Promise.all([...this.textures.values()].map(async (entry) => {
      if (entry.image) return;
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(`无法载入 ${entry.file}`));
        element.src = `${base}${entry.file}`;
      });
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      // Unity's UV origin is bottom-left: its importer flips an image vertically so that v = 0 is the
      // file's *bottom* row, and the quad's v also increases upward. Uploading with the flip off puts
      // the file's top row at v = 0, which mirrors every noise and displacement texture.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      const source = this.textureColorSpace === 'srgb' && SRGB_TEXTURES.has(entry.file)
        ? decodeSrgbToBytes(image)
        : image;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      entry.image = source;
    }));
  }

  resize(width, height) {
    const gl = this.gl;
    for (const [key, target] of this.targets) {
      const w = Math.max(1, Math.floor(width / target.divisor));
      const h = Math.max(1, Math.floor(height / target.divisor));
      if (target.width === w && target.height === h) continue;
      target.width = w;
      target.height = h;
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.disabled = true;
        this.lastError = `${key} 帧缓冲不完整`;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /**
   * Copy the scene underneath the blocks into `sceneColorRT`, the job `RefreshSceneColorCommands`
   * does with `cmd.Blit(CameraTarget, sceneColorRT)`.
   *
   * The game takes this at Screen/6 with Point filtering. Reproducing that matters because
   * `ActiveBlock` samples `_SceneColor` at a *displaced* uv and folds the result into its spark/hue
   * term — it is not a full-screen copy, so this cannot double-draw the background.
   */
  uploadScene(source, view = null) {
    if (!source) return false;
    const gl = this.gl;
    const target = this.targets.get('sceneColorRT');
    if (typeof document === 'undefined') return false;
    this.sceneCanvas ??= document.createElement('canvas');
    const canvas = this.sceneCanvas;
    if (canvas.width !== target.width || canvas.height !== target.height) {
      canvas.width = target.width;
      canvas.height = target.height;
    }
    const context = canvas.getContext('2d');
    if (!context) return false;
    // Point-like downscale, matching the target's NEAREST filter.
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    // `view` is the block viewport in the source's own (device) pixels, so a viewport smaller than
    // the canvas crops rather than squashing the scene into the block area.
    if (view) context.drawImage(source, view.left, view.top, view.width, view.height, 0, 0, canvas.width, canvas.height);
    else context.drawImage(source, 0, 0, canvas.width, canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // Flip, because the two origins disagree: a 2D canvas's row 0 is its top row, while the
    // full-screen quad puts v = 0 at clip y = -1, i.e. the framebuffer's bottom row — which is GL
    // row 0. Without the flip, `ActiveBlock` samples `_SceneColor` with v = 0 at the bottom of the
    // screen and reads the *top* of the scene, so every block shows a vertically mirrored copy of
    // whatever it overlaps. Mask targets do not need this: they are both drawn and sampled in GL
    // orientation.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    return true;
  }

  /** Bind a program and apply its recovered fixed-function state. */
  use(key, index = 0) {
    const gl = this.gl;
    const program = this.programs.get(key)?.[index];
    if (!program) throw new Error(`缺少 program ${key}#${index}`);
    gl.useProgram(program.handle);
    gl.blendFunc(gl[program.state.blend[0]], gl[program.state.blend[1]]);
    gl.colorMask(...['R', 'G', 'B', 'A'].map((channel) => program.state.mask.includes(channel)));
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    return program;
  }

  bindTarget(key) {
    const gl = this.gl;
    const target = key ? this.targets.get(key) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(0, 0, target ? target.width : this.canvas.width, target ? target.height : this.canvas.height);
    this.currentTarget = target ?? null;
    return target;
  }

  /** Full-screen pass: the projection stretches the unit quad across the whole target. */
  fullscreen(program, { textures = {}, floats = {}, vectors = {} } = {}) {
    const gl = this.gl;
    this.setMatrices(program, FULLSCREEN_PROJECTION);
    this.bindQuad(program);
    this.applyUniforms(program, textures, floats, vectors);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  bindQuad(program, withColor = true) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    for (const [name, offset] of Object.entries(ATTRIBUTE_OFFSET)) {
      const location = gl.getAttribLocation(program.handle, name);
      if (location < 0) continue;
      const size = name === 'in_TEXCOORD0' ? 2 : 4;
      // Block draws set a constant colour attribute (see drawBlockQuad); full-screen passes feed the
      // buffer's own colour column.
      if (name === 'in_COLOR0' && !withColor) { gl.disableVertexAttribArray(location); continue; }
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, QUAD_STRIDE, offset);
    }
  }

  applyUniforms(program, textures, floats, vectors) {
    const gl = this.gl;
    let unit = 0;
    for (const [name, target] of Object.entries(textures)) {
      const location = program.uniforms.get(name);
      if (location == null) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, target.texture ?? target);
      gl.uniform1i(location, unit);
      unit += 1;
    }
    for (const [name, value] of Object.entries(floats)) {
      const location = program.uniforms.get(name);
      if (location != null) gl.uniform1f(location, value);
    }
    for (const [name, value] of Object.entries(vectors)) {
      const location = program.uniforms.get(name);
      if (location == null) continue;
      if (value.length === 2) gl.uniform2fv(location, value);
      else if (value.length === 3) gl.uniform3fv(location, value);
      else gl.uniform4fv(location, value);
    }
  }

  clearTarget(key, color = [0, 0, 0, 0]) {
    const gl = this.gl;
    this.bindTarget(key);
    gl.clearColor(color[0], color[1], color[2], color[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Rasterise one block quad into a layer mask, with the game's `BlockSprite` material. */
  drawBlockQuad(target, block, transform, coverage, seconds) {
    const gl = this.gl;
    const program = this.use('BlockSprite', 0);
    gl.enable(gl.BLEND);
    // `_ScreenParams` and `_ProjectionParams` come from the engine, and BlockSprite is drawn without
    // a material lookup, so they have to be set explicitly here.
    this.applyEngineUniforms(program, seconds);
    this.setMatrices(program, blockMatrix(transform));
    this.bindTarget(target);
    this.bindQuad(program, false);
    // `BlockSprite` reads the renderer colour from the vertex colour, not a `_Color` uniform:
    // Unity bakes SpriteRenderer.color into the sprite's vertex stream. A constant vertex attribute
    // reproduces that without re-uploading the quad per block.
    const color = block.isSubtract
      ? [1, 1 - coverage, 1, 0.1 * coverage]     // magenta -> white, alpha pinned at 0.1
      : [1, 1, 1, coverage];
    const location = gl.getAttribLocation(program.handle, 'in_COLOR0');
    if (location >= 0) gl.vertexAttrib4f(location, color[0], color[1], color[2], color[3]);
    // `BlockSprite`'s vertex stage computes `vs_COLOR0 = in_COLOR0 * _Color`, so the material tint
    // multiplies whatever the mesh carries. Unity bakes SpriteRenderer.color into the vertex stream
    // and leaves `_Color` at the material's own value, which for the block prefab is white; leaving
    // it unset defaults to (0,0,0,0) and every mask write becomes zero. `Unlit/BlockSprite` is not
    // among the eight materials in the dump's table — it lives on the block prefab — so the material
    // table cannot supply this one.
    this.setUniform(program, '_Color', [1, 1, 1, 1]);
    this.setUniform(program, '_MainTex_ST', [1, 1, 0, 0]);
    this.applySamplers(program, { _MainTex: this.textures.get('_MainTex') });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  applySamplers(program, textures) {
    const gl = this.gl;
    let unit = 0;
    for (const [name, entry] of Object.entries(textures)) {
      const location = program.uniforms.get(name);
      if (location == null || !entry) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.uniform1i(location, unit);
      unit += 1;
    }
  }

  /** `_ST` per material; offsets are always 0, only tiling varies. */
  applyTiling(program, material) {
    const st = TEXTURE_ST[material] ?? {};
    for (const name of ['_DisplaceMap_ST', '_SparkMap_ST', '_TouchDisplaceMap_ST', '_NoiseMap_ST']) {
      const scale = st[name.replace('_ST', '')] ?? [1, 1];
      this.setUniform(program, name, [scale[0], scale[1], 0, 0]);
    }
  }

  /**
   * Set a uniform using its reflected type.
   *
   * Guessing the setter does not work with this shader set: Unity declares its matrices as
   * `uniform vec4 hlslcc_mtx4x4unity_ObjectToWorld[4]`, an array of four vec4 rather than a `mat4`,
   * so `uniformMatrix4fv` on it raises GL_INVALID_OPERATION; and the material's colour table mixes
   * `vec3` (`_SparkTint`, `_NoiseTint`) with `vec4`, so passing four components to all of them
   * raises "Uniform size does not match uniform method" for the vec3 ones. `uniform4fv` also accepts
   * the flat 16 floats of a `vec4[4]`, which is how the matrix arrays are written.
   */
  setUniform(program, name, value) {
    const gl = this.gl;
    const location = program.uniforms.get(name);
    if (location == null) return false;
    const numbers = typeof value === 'number' ? [value] : value;
    // The material table stores every colour as RGBA, including the ones the shaders declare as
    // `vec3` (_SparkTint, _NoiseTint), so handing four components to uniform3fv raised
    // "invalid size" once per program per frame. Trim to the uniform's own width — but keep a
    // genuine `vecN[]` array intact, which is how Unity writes `vec4 matrix[4]`.
    const sized = (count) => (numbers.length > count && numbers.length % count === 0
      ? numbers
      : Array.from({ length: count }, (_, index) => numbers[index] ?? 0));
    switch (program.types.get(name)) {
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(location, false, numbers); return true;
      case gl.FLOAT_VEC4: gl.uniform4fv(location, sized(4)); return true;
      case gl.FLOAT_VEC3: gl.uniform3fv(location, sized(3)); return true;
      case gl.FLOAT_VEC2: gl.uniform2fv(location, sized(2)); return true;
      case gl.INT: case gl.BOOL: gl.uniform1i(location, numbers[0]); return true;
      default: gl.uniform1f(location, numbers[0]); return true;
    }
  }

  /**
   * Feed the matrices Unity's vertex stages expect.
   *
   * `hlslcc_mtx4x4unity_ObjectToWorld` gets the identity because the model transform is folded into
   * the projection on the CPU; `hlslcc_mtx4x4unity_MatrixVP` gets the combined matrix.
   */
  setMatrices(program, matrix) {
    this.setUniform(program, 'hlslcc_mtx4x4unity_MatrixVP', matrix);
    this.setUniform(program, 'hlslcc_mtx4x4unity_ObjectToWorld', IDENTITY);
    this.setUniform(program, 'u_projection', matrix);
  }

  /** Uniforms the engine supplies rather than the material. */
  applyEngineUniforms(program, seconds) {
    this.setUniform(program, '_Time', [seconds / 20, seconds, seconds * 2, seconds * 3]);
    // Unity's `_ScreenParams` is (width, height, 1 + 1/width, 1 + 1/height); `.zw` are not the
    // reciprocal texel sizes the name suggests.
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.setUniform(program, '_ScreenParams', [width, height, 1 + 1 / width, 1 + 1 / height]);
    // `_ProjectionParams` is (yFlip, near, far, 1/far). The flip is -1 here because every block
    // camera renders into a RenderTexture — `BlockRender.Start` sets `forceIntoRenderTexture` on the
    // main camera too — and Unity flips the projection matrix in that case, which is what
    // `ComputeScreenPos` reads to orient `vs_TEXCOORD3`. Only the screen-projected varyings depend on
    // it; the quad's own position comes from the matrices.
    this.setUniform(program, '_ProjectionParams', [-1, 0.3, 1000, 1 / 1000]);
    const effect = this.targets.get('effectRT');
    this.setUniform(program, '_EffectRT_TexelSize', [1 / effect.width, 1 / effect.height, effect.width, effect.height]);
    // `UpdateTouchPos` recomputes the shine every frame instead of reading it from the material.
    this.setUniform(program, '_TouchPosShine', this.touchShine(seconds));
  }

  applyMaterial(program, material, seconds) {
    this.applyEngineUniforms(program, seconds);
    const values = this.materials?.[material];
    if (!values) return;
    for (const [name, value] of Object.entries(values.floats)) this.setUniform(program, name, value);
    for (const [name, value] of Object.entries(values.colors)) this.setUniform(program, name, value);
  }

  /** `UpdateTouchPos`: `lerp(lowThreshold, 1, 0.5 + 0.5·sin(shineSpeed·t)) · brightness`. */
  touchShine(seconds) {
    const floats = this.materials?.ActiveBlock?.floats ?? {};
    const low = floats._TouchPosLowThreshold ?? 0;
    const speed = floats._TouchPosShineSpeed ?? 0;
    const brightness = floats._TouchPosBrightness ?? 1;
    return (low + (1 - low) * (0.5 + 0.5 * Math.sin(speed * seconds))) * brightness;
  }

  /**
   * One frame of the whole pipeline, mirroring `BlockRender.LateUpdate`:
   * layer cameras -> BlockCompose pass 0 -> RenderEffects (edge + glow) -> BlockCompose pass 1
   * -> fxRenderList (disabled + ready, on their own canvas) -> ActiveBlock.
   *
   * Returns `false` when nothing was drawn, otherwise `{ sceneEffects }` — whether the additive
   * disabled/ready layer has content that the caller still has to composite (see
   * `compositeSceneEffects`). The block canvas itself is finished by the time this returns.
   */
  render({ blocks, now, aspect, width, height, scene = null, sceneView = null, view = null }) {
    const gl = this.gl;
    if (!gl || this.disabled) return false;
    this.resize(width, height);
    for (const key of ['normalBlockRT', 'subtractBlockRT', 'disabledNormalBlockRT', 'disabledSubtractBlockRT',
      'disabledNormalReadyBlockRT', 'disabledSubtractReadyBlockRT', 'touchBlockRT']) this.clearTarget(key);
    // `RefreshSceneColorCommands` copies the camera target into `sceneColorRT` ahead of the
    // composite. `ActiveBlock` samples it at a displaced uv inside its spark/hue term rather than
    // blitting it, so supplying the real scene cannot double-draw the background.
    this.clearTarget('sceneColorRT');
    if (this.sceneDistortion) this.uploadScene(scene, sceneView);

    const stats = { visible: 0, drawn: 0, skippedZeroSize: 0, quads: [] };
    for (const [index, block] of blocks.entries()) {
      const phase = blockState(block, now);
      if (!phase) continue;
      stats.visible += 1;
      const transform = blockTransform(block, now, aspect);
      // A zero-extent quad is skipped rather than drawn, which is correct — this chart's blocks
      // really do animate through a zero scale — but it means "visible" and "rasterised" are not the
      // same number, so both are counted for the diagnostic.
      if (!(Math.abs(transform.size.x) > 0) || !(Math.abs(transform.size.y) > 0)) {
        stats.skippedZeroSize += 1;
        stats.quads.push({ index, state: phase.active ? 'active' : phase.ready ? 'ready' : 'disabled', skipped: 'zero-size', size: [transform.size.x, transform.size.y] });
        continue;
      }
      const coverage = blockShowCoverage(block, now);
      // Layer cameras render raw masks with `BlockSprite`; the renderer colour rides in as the
      // vertex colour, which is what gives subtract blocks their 0.1 intensity.
      const layer = phase.active
        ? (block.isSubtract ? 'subtractBlockRT' : 'normalBlockRT')
        : (block.isSubtract ? 'disabledSubtractBlockRT' : 'disabledNormalBlockRT');
      const readyLayer = phase.ready
        ? (block.isSubtract ? 'disabledSubtractReadyBlockRT' : 'disabledNormalReadyBlockRT')
        : null;
      this.drawBlockQuad(layer, block, transform, coverage, now);
      if (readyLayer) this.drawBlockQuad(readyLayer, block, transform, coverage, now);
      stats.drawn += 1;
      // Per-block bookkeeping for `diagnose`: which layer received the quad, which state the block is
      // in, and where its centre landed in mask pixels. Without this, a block that renders wrong is
      // indistinguishable from one that was never drawn.
      stats.quads.push({
        index,
        state: phase.active ? 'active' : phase.ready ? 'ready' : 'disabled',
        isSubtract: Boolean(block.isSubtract),
        layer,
        readyLayer,
        coverage: Number(coverage.toFixed(3)),
        size: [Number(transform.size.x.toFixed(3)), Number(transform.size.y.toFixed(3))],
        rotation: Number(transform.rotation.toFixed(2)),
        maskCentre: this.maskPixel(transform, layer),
      });
    }
    this.lastStats = stats;
    // Retained so `diagnose` can re-derive each block's transform for its per-block probes: `blocks`
    // and `view` describe this frame, and `view` is the layer's viewport (which is smaller than the
    // canvas once the editor's content scale shrinks it).
    this.blocks = blocks;
    this.lastAspect = aspect;
    this.lastView = view;

    // The three `SubtractBlockPostProcessor` instances sit on the subtract-family cameras and run
    // `subtractBlockMaterial` (= `SubtractBlockBlender`) at their serialised `targetPass`.
    // `Start` never binds that material — the passes come from the scene asset — so they are pinned
    // down from the other end instead: `BlockCompose` pass 0 only reads `.x` and differences it
    // against the normal mask, which needs the scalar attribution (pass 0), while pass 1's
    // consumers read `.xy` and `.y` and therefore need the vec2 form (pass 1).
    this.blendSubtractMask('subtractBlockRT', 'scratchA', now, 0);
    this.blendSubtractMask('disabledSubtractBlockRT', 'scratchB', now, 1);

    // BlockCompose pass 0: abs(subtract - normal) plus the liquid displacement. Its scalar output
    // doubles as EdgeMask's `_ComposeRT` coverage channel.
    this.beginPass('composedEnabledBlockRT');
    let program = this.use('BlockCompose', 0);
    this.applyMaterial(program, 'BlockCompose', now);
    this.applyTiling(program, 'BlockCompose');
    this.fullscreen(program, {
      textures: { _DisplaceMap: this.textures.get('_DisplaceMap'), _NormalBlockRT: this.targets.get('normalBlockRT'), _SubtractBlockRT: this.targets.get('scratchA') },
    });

    this.renderEffects('composedEnabledBlockRT', now);

    // `SubtractBlockPostProcessor`: remove the masked-out scene colour before `ActiveBlock` samples
    // `_SceneColor`, so a subtract block reads as a hole rather than a translucent red block. It must
    // run after `BlockCompose` pass 0 (which owns `subtractBlockRT`'s first consumer) and before the
    // final composite.
    this.subtractScene(now);

    // BlockCompose pass 1: the disabled + ready masks, reading the processed subtract pair.
    this.beginPass('composedDisabledBlockRT');
    program = this.use('BlockCompose', 1);
    this.applyMaterial(program, 'BlockCompose', now);
    this.fullscreen(program, {
      textures: { _DisabledNormalBlockRT: this.targets.get('disabledNormalBlockRT'), _DisabledSubtractBlockRT: this.targets.get('scratchB') },
    });

    // The ready-subtract mask is post-processed as well, because the third
    // `SubtractBlockPostProcessor` (pass 1) sits on the subtract-ready camera. In the game its result
    // only ever lands in an internal temp that the camera's `OnRenderImage` owns, which is what this
    // scratch stands in for; `activeBlockMaterial` samples the *raw* `disabledSubtractReadyBlockRT`
    // below, exactly as `Start` binds it.
    this.blendSubtractMask('disabledSubtractReadyBlockRT', 'scratchA', now, 1);

    // The `fxRenderList` canvases draw into the camera target before it is copied into
    // `sceneColorRT`, so they must run here rather than after the composite.
    const sceneEffects = this.sceneEffects ? this.renderSceneEffects(now) : false;

    // ActiveBlock: the single full-screen composite that produces the visible image. `Start` binds
    // its `_Disabled*RT` samplers to the *pure ready* masks — literally `disabledNormalReadyBlockRT`
    // and `disabledSubtractReadyBlockRT`, not `scratchA`/`scratchB` — unlike `blockComposeMaterial`,
    // which gets the merged (disabled + ready) masks under the same names. `ds` feeds
    // `m = ds - dn`, so binding the post-processed scratch instead would change `rd = ready·|m|`
    // for subtract blocks: `SubtractBlockBlender` pass 1 clamps and multiplies the coverage by 10,
    // while the render target holds the raw `0.1·coverage` that `BlockSprite` wrote.
    // ActiveBlock composites over what is already in the camera target — the game blits it with
    // `Blit(None, CameraTarget, activeBlockMaterial)`, which does not clear — so this pass must not
    // clear either, or the fxRenderList output underneath is wiped before it can show.
    this.bindTarget(null);
    gl.enable(gl.BLEND);
    program = this.use('ActiveBlock', 0);
    this.applyMaterial(program, 'ActiveBlock', now);
    this.applyTiling(program, 'ActiveBlock');
    const touchCount = program.uniforms.get('_TouchPosCount');
    this.setUniform(program, '_TouchPosCount', 0);
    void touchCount;
    this.fullscreen(program, {
      textures: {
        _ComposeRT: this.targets.get('composedEnabledBlockRT'),
        _EffectRT: this.targets.get('effectRT'),
        _DisabledNormalBlockRT: this.targets.get('disabledNormalReadyBlockRT'),
        _DisabledSubtractBlockRT: this.targets.get('disabledSubtractReadyBlockRT'),
        _ReadyComposeRT: this.targets.get('composedDisabledBlockRT'),
        _TouchHoverRT: this.targets.get('touchBlockRT'),
        _DisplaceMap: this.textures.get('_DisplaceMap'),
        _SparkMap: this.textures.get('_SparkMap'),
        _TouchDisplaceMap: this.textures.get('_TouchDisplaceMap'),
        _NoiseMap: this.textures.get('_NoiseMap'),
        _SceneColor: this.targets.get('sceneColorRT'),
      },
    });
    // The disabled/ready layer is returned rather than blitted here: it has to reach the preview with
    // an additive composite, which canvas 2D can only do, so `Preview` performs that step.
    return { sceneEffects };
  }

  /**
   * Draw the additive `fxRenderList` layer into a 2D context.
   *
   * `lighter` is the canvas 2D spelling of `dst + src`: it adds colour and leaves the destination
   * alpha untouched, which is exactly what `One, One` / `SrcAlpha, One` do to the game's camera
   * target. A `source-over` blit here would instead use the layer's own coverage alpha to attenuate
   * the background — the reported "some states go dark, some go black".
   */
  compositeSceneEffects(context, width, height, viewport) {
    const layer = this.sceneEffectsCanvas;
    if (!layer) return false;
    context.save();
    context.globalCompositeOperation = 'lighter';
    context.drawImage(layer, 0, 0, width, height, viewport.left, viewport.top, viewport.width, viewport.height);
    context.restore();
    return true;
  }

  /**
   * Readback summary of every render target and the final canvas.
   *
   * `readPixels` stalls the pipeline, so this is a manual diagnostic for when the composite comes
   * out blank or wrong, not part of the frame. It answers "did the masks get written at all", which
   * is the first fork when nothing appears: an empty `normalBlockRT` means the quads never
   * rasterised, an empty `composedEnabledBlockRT` means the compose pass found nothing, and a
   * populated `effectRT` with an empty canvas means the final composite discarded everywhere.
   */
  diagnose(now = 0, blocks = [], view = null) {
    const gl = this.gl;
    const report = { now, disabled: this.disabled, lastError: this.lastError, targets: {} };
    // Where each live block *should* land, in viewport pixels, derived independently of the GL path
    // (the same mapping the Canvas2D renderer uses). Compared against `canvasBBox` below, this
    // separates "the transform or the data is wrong" from "the projection or the blit is wrong".
    if (blocks.length && view) {
      const aspect = view.width / view.height;
      const screen = blockScreen(aspect);
      report.visibleRects = blocks.map((block, index) => ({ block, index }))
        .filter(({ block }) => blockState(block, now)).slice(0, 8)
        .map(({ block, index }) => {
          const transform = blockTransform(block, now, aspect);
          const width = Math.abs(transform.size.x) * view.width / screen.x;
          const height = Math.abs(transform.size.y) * view.height / screen.y;
          // Relative to the viewport's top-left, so the numbers do not depend on canvas size or DPR.
          const left = (transform.center.x / screen.x + 0.5) * view.width - width / 2;
          const top = (0.5 - transform.center.y / screen.y) * view.height - height / 2;
          return {
            index, isSubtract: Boolean(block.isSubtract),
            time: [block.appearTime, block.enableTime, block.disableTime, block.disappearTime],
            topRightPercentage: block.topRightPercentage, bottomLeftPercentage: block.bottomLeftPercentage,
            rotation: Number(transform.rotation.toFixed(2)),
            rect: [Number(left.toFixed(1)), Number(top.toFixed(1)), Number(width.toFixed(1)), Number(height.toFixed(1))],
          };
        });
    }
    // An all-zero readback is exactly what an empty frame should look like, so report whether there
    // was anything to draw before anyone concludes the pipeline is broken.
    if (blocks.length) {
      const appear = Math.min(...blocks.map((block) => block.appearTime));
      const disappear = Math.max(...blocks.map((block) => block.disappearTime));
      report.blocks = {
        total: blocks.length,
        visibleAtNow: blocks.filter((block) => blockState(block, now)).length,
        range: [appear, disappear],
        hint: now < appear || now >= disappear ? `该时刻没有块，请把播放头移到 ${appear}–${disappear} s` : null,
      };
    } else {
      report.blocks = { total: 0, hint: '当前谱面没有判定块（blockAreas 为空）' };
    }
    // How many quads were actually rasterised this frame, and how many were skipped for having no
    // extent — the fork between "no block is live" and "a live block drew nothing". `quads` names the
    // mask layer each one went to, so a wrong layer shows up as a data difference, not a guess.
    report.lastFrame = this.lastStats ?? null;
    // Sample the pipeline's own intermediates at each drawn block's centre. This is the part that
    // distinguishes the failure modes for a block that renders too dark or not at all:
    // `compose` 0 means the mask never reached `BlockCompose`; `edge`/`glow` 0 on a block that no other
    // one covers means `RenderEffects` produced nothing for it; a non-zero `disabledSubtractReady`
    // where the block is not ready means the ready half of the composite is fed by the wrong mask.
    report.samples = this.sampleBlocks(now, this.lastAspect ?? 16 / 9);
    this.bindTarget(null);
    for (const [key, target] of this.targets) {
      this.bindTarget(key);
      const pixels = new Uint8Array(target.width * target.height * 4);
      gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let touched = 0;
      let sum = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] || pixels[index + 1] || pixels[index + 2] || pixels[index + 3]) touched += 1;
        sum += pixels[index] + pixels[index + 1] + pixels[index + 2];
      }
      const count = target.width * target.height;
      report.targets[key] = { size: `${target.width}x${target.height}`, touchedRatio: Number((touched / count).toFixed(4)), meanRgb: Number((sum / (count * 3)).toFixed(2)) };
    }
    this.bindTarget(null);
    const total = this.canvas.width * this.canvas.height;
    const out = new Uint8Array(total * 4);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    let lit = 0;
    let sum = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < out.length; index += 4) {
      const alpha = out[index + 3];
      if (alpha > 8) {
        lit += 1;
        const pixel = index / 4;
        const x = pixel % this.canvas.width;
        const y = Math.floor(pixel / this.canvas.width);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      sum += out[index] + out[index + 1] + out[index + 2];
    }
    report.canvas = {
      size: `${this.canvas.width}x${this.canvas.height}`,
      litRatio: Number((lit / total).toFixed(4)),
      meanRgb: Number((sum / (total * 3)).toFixed(2)),
      // Bounding box of everything drawn, in GL pixels; divide by devicePixelRatio to compare with
      // `visibleRects`, which is in viewport pixels.
      canvasBBox: lit ? [minX, minY, maxX - minX + 1, maxY - minY + 1] : null,
    };
    return report;
  }

  /**
   * Read the pipeline's own intermediates at each drawn block's centre.
   *
   * This is the diagnostic that separates the failure modes behind "this block is too dark / black",
   * which is otherwise indistinguishable from a distance:
   *
   * - `compose` is 0 on a block that was rasterised → its mask never survived `BlockCompose`, so
   *   `ActiveBlock` has nothing to fill with (the shader discards there and the hole shows through).
   * - `edge` and `glow` are the effect channels `ActiveBlock` adds on top; a block whose `compose` is
   *   fine but whose edge is 0 everywhere it is not covered by another block means `RenderEffects`
   *   produced nothing, which is exactly "no edge ripple".
   * - `disabledSubtractReady` is the ready mask `ActiveBlock` differences against the normal one; a
   *   non-zero value for a block that is not in its ready window points at a wrong binding.
   *
   * Every value is sampled at the block's centre in that target's own pixel grid, so a mask and an
   * effect target are both addressed correctly despite their different divisors.
   */
  sampleBlocks(now, aspect) {
    const gl = this.gl;
    const probes = [
      ['compose', 'composedEnabledBlockRT', 0],
      ['effectEdge', 'effectRT', 0],
      ['effectGlow', 'effectRT', 1],
      ['readyCompose', 'composedDisabledBlockRT', 0],
      ['disabledNormal', 'disabledNormalBlockRT', 0],
      ['disabledSubtract', 'disabledSubtractBlockRT', 0],
      ['disabledNormalReady', 'disabledNormalReadyBlockRT', 0],
      ['disabledSubtractReady', 'disabledSubtractReadyBlockRT', 1],
      ['sceneColor', 'sceneColorRT', 0],
    ];
    const rows = (this.lastStats?.quads ?? []).filter((quad) => !quad.skipped).slice(0, 16);
    const read = new Map();
    for (const [, key] of probes) {
      if (read.has(key)) continue;
      const target = this.targets.get(key);
      if (!target?.width) { read.set(key, null); continue; }
      this.bindTarget(key);
      const pixels = new Uint8Array(target.width * target.height * 4);
      gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      read.set(key, { target, pixels });
    }
    if (!rows.length) return [];
    return rows.map((quad) => {
      const block = this.blocks?.[quad.index];
      const transform = block ? blockTransform(block, now, aspect) : null;
      const entry = { block: quad.index, state: quad.state, isSubtract: quad.isSubtract, layer: quad.layer, readyLayer: quad.readyLayer };
      for (const [label, key, channel] of probes) {
        const buffer = read.get(key);
        if (!buffer || !transform) { entry[label] = null; continue; }
        const position = this.maskPixel(transform, key);
        const x = Math.max(0, Math.min(buffer.target.width - 1, position[0]));
        const y = Math.max(0, Math.min(buffer.target.height - 1, position[1]));
        entry[label] = buffer.pixels[(y * buffer.target.width + x) * 4 + channel];
      }
      return entry;
    });
  }

  /**
   * Where a block's centre lands in a target's pixel grid.
   *
   * A block fills the whole canvas only while the editor's content scale is 1; at any other scale the
   * layer's viewport (`this.lastView`) is smaller than the canvas, so the block's world position has
   * to be shrunk and re-centred inside it before it is converted to target pixels. Mask work happens at
   * `Screen/8` and effects at `Screen/4`, hence the per-target dimensions. `null` when the target has
   * no size yet.
   */
  maskPixel(transform, key) {
    const target = this.targets.get(key);
    if (!target || !target.width || !this.canvas.width || !this.canvas.height) return null;
    const view = this.lastView ?? { width: this.canvas.width, height: this.canvas.height };
    const { screen } = transform;
    const offsetX = (this.canvas.width - view.width) / 2;
    const offsetY = (this.canvas.height - view.height) / 2;
    return [
      Math.round((offsetX + (transform.center.x / screen.x + 0.5) * view.width) / this.canvas.width * target.width),
      // GL row 0 is the bottom and block world space is y-up, so no flip is needed here.
      Math.round((offsetY + (transform.center.y / screen.y + 0.5) * view.height) / this.canvas.height * target.height),
    ];
  }

  /** Bind a target and clear it, ready for a `One, Zero` (overwriting) pass. */
  beginPass(key) {
    const gl = this.gl;
    this.bindTarget(key);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
  }

  /**
   * `RenderEffects`: EdgeMask then GlowMask, both writing into `effectRT`.
   *
   * EdgeMask pass 1 writes `.x` (edge) only, GlowMask pass 1 writes `.y` (glow) only, so the two
   * accumulate into one RG texture — that is why `ActiveBlock` reads `_EffectRT.x` and `.y`.
   */
  renderEffects(sourceMask, seconds) {
    const gl = this.gl;
    const effect = this.targets.get('effectRT');
    const compose = this.targets.get(sourceMask);
    // `RenderEffects` clears its destination up front, and `UpdateDilateTexelSize` derives the
    // texel size from `effectRT` — not from the source mask, which is the natural but wrong guess.
    this.clearTarget('effectRT');
    const dilate = [1 / effect.width, 1 / effect.height, effect.width, effect.height];

    if (this.edgeSize >= 1) {
      if (this.edgeSize === 1) {
        // One round short-circuits to pass 1, which also folds in `_ComposeRT`.
        this.beginPass('effectRT');
        const program = this.use('EdgeMask', 1);
        this.applyMaterial(program, 'EdgeMask', seconds);
        this.setUniform(program, '_DilateTexelSize', dilate);
        this.fullscreen(program, { textures: { _MainTex: compose, _ComposeRT: compose } });
      } else {
        let from = sourceMask;
        let to = 'pingA';
        for (let pass = 0; pass < this.edgeSize; pass++) {
          const last = pass === this.edgeSize - 1;
          this.beginPass(last ? 'effectRT' : to);
          const program = this.use('EdgeMask', last ? 1 : 0);
          this.applyMaterial(program, 'EdgeMask', seconds);
          this.setUniform(program, '_DilateTexelSize', dilate);
          this.fullscreen(program, { textures: { _MainTex: this.targets.get(from), _ComposeRT: compose } });
          from = to;
          to = to === 'pingA' ? 'pingB' : 'pingA';
        }
      }
    }

    // GlowMask: weighted dilation ping-ponging between pingA and pingB, then a final `.y`-only write
    // into `effectRT` that preserves the edge already sitting in `.x`.
    if (this.glowRadius >= 1) {
      this.clearTarget('pingA');
      this.clearTarget('pingB');
      let weight = glowRingWeight(0, this.glowRadius, this.glowWeightFalloff);
      // If even the first ring is below the threshold the whole glow stage is skipped.
      if (weight >= this.glowPassWeightThreshold) {
        let pass = 1;
        let from = sourceMask;
        let to = 'pingA';
        for (;;) {
          this.beginPass(to);
          const program = this.use('GlowMask', 0);
          this.applyMaterial(program, 'GlowMask', seconds);
          this.setUniform(program, '_DilateTexelSize', dilate);
          this.setUniform(program, '_PassWeight', weight);
          this.setUniform(program, '_GlowFirstPass', pass === 1 ? 1 : 0);
          this.fullscreen(program, { textures: { _MainTex: this.targets.get(from), _ComposeRT: compose } });
          from = to;
          to = to === 'pingA' ? 'pingB' : 'pingA';
          if (pass >= this.glowRadius) break;
          weight = glowRingWeight(pass, this.glowRadius, this.glowWeightFalloff);
          pass += 1;
          if (weight < this.glowPassWeightThreshold) break;
        }
        this.beginPass('effectRT');
        const final = this.use('GlowMask', 1);
        this.applyMaterial(final, 'GlowMask', seconds);
        this.fullscreen(final, { textures: { _MainTex: this.targets.get(from) } });
      }
    }
  }

  /**
   * `Unlit/SubtractBlockBlender` — the subtract camera's post-process, run at `targetPass`.
   *
   * Pass 0 is the scalar-only variant: `SV_Target = (x >= low) + (x >= high ? -1 : 0)`, giving a
   * clean attribution flag that `BlockCompose` pass 0 differences against the normal mask, so a
   * lone subtract block reads as 1 and an overlapping pair cancels to 0. Pass 1 adds the documented
   * smoothstep coverage lift and writes `vec2(v, t.y · v · 10)`, which is what the `.xy` and `.y`
   * consumers of the disabled masks need.
   */
  blendSubtractMask(sourceMask, dest, seconds = 0, pass = 1) {
    const gl = this.gl;
    this.beginPass(dest);
    const program = this.use('SubtractBlockBlender', pass);
    this.applyMaterial(program, 'SubtractBlockBlender', seconds);
    this.fullscreen(program, { textures: { _MainTex: this.targets.get(sourceMask) } });
  }

  /**
   * `Unlit/ReadyBlock` — the breathing pulse. Reads the pure-ready masks (`.x` normal, `.y`
   * subtract), discards outside the block when `abs(m)·c <= 1e-4`, and writes
   * `vec4(vec3(a)·pulse·tint, a)` with `pulse = sin(_Time.y · _ShineSpeed) · 0.5 + 1`.
   */
  readyPulse(dest, seconds) {
    const gl = this.gl;
    this.bindTarget(dest);
    gl.enable(gl.BLEND);
    const program = this.use('ReadyBlock', 0);
    this.applyMaterial(program, 'ReadyBlock', seconds);
    this.fullscreen(program, {
      textures: {
        // `Start` binds blockReadyMaterial's samplers to the pure-ready masks and to
        // `composedDisabledBlockRT` — not to the enabled compose, despite the shared name.
        _DisabledNormalBlockRT: this.targets.get('disabledNormalReadyBlockRT'),
        _DisabledSubtractBlockRT: this.targets.get('disabledSubtractReadyBlockRT'),
        _ComposeRT: this.targets.get('composedDisabledBlockRT'),
      },
    });
  }

  /**
   * `Unlit/DisabledBlock` — the flat disabled fill plus spark.
   *
   * `Start` binds `_ComposeRT` to `composedDisabledBlockRT`, so this must run after compose pass 1.
   */
  disabledBlock(dest, seconds) {
    const gl = this.gl;
    this.bindTarget(dest);
    gl.enable(gl.BLEND);
    const program = this.use('DisabledBlock', 0);
    this.applyMaterial(program, 'DisabledBlock', seconds);
    this.applyTiling(program, 'DisabledBlock');
    this.fullscreen(program, {
      textures: {
        _ComposeRT: this.targets.get('composedDisabledBlockRT'),
        _DisplaceMap: this.textures.get('_DisplaceMap'),
        _SparkMap: this.textures.get('_SparkMap'),
      },
    });
  }

  /**
   * `SubtractBlockPostProcessor` — remove the scene colour inside a subtract block.
   *
   * `subtractBlockRT` goes through `SubtractBlockBlender` pass 0 first, whose attribution is `1`
   * across a subtract block and `0` everywhere else (its two thresholds bracket the `0.1` alpha that
   * `BlockSprite` writes for subtract quads). Scaling the scene copy by `1 - attribution` is what
   * makes a subtract block read as a hole rather than as a translucent red block; without it the
   * only visible trace of a subtract block is its `0.1` alpha, which is why the Canvas2D fallback
   * had to draw an editor-only magenta outline to make one visible at all.
   *
   * Skipped entirely when no subtract quad was drawn, so charts without subtract blocks pay nothing.
   */
  subtractScene(seconds) {
    const mask = this.targets.get('subtractBlockRT');
    if (!mask?.width) return false;
    // Charts without subtract blocks pay nothing: the pass only runs when a subtract quad was drawn.
    // It is deliberately *not* gated on `sceneDistortion`: the subtract is a property of the block,
    // not of the scene sampling. With the scene copy left empty the multiplication is a no-op, which
    // is why running it unconditionally in that case costs a draw and changes nothing.
    if (!(this.lastStats?.quads ?? []).some((quad) => quad.isSubtract)) return false;
    // `SubtractBlockBlender` pass 0 turns the raw `0.1` mask into the `1 / 0` attribution the scene
    // multiply needs. It writes its own scratch: `scratchA` already holds the enabled-mask
    // attribution that `BlockCompose` pass 0 consumed, and `scratchB` is the disabled pair's.
    this.blendSubtractMask('subtractBlockRT', 'scratchC', seconds, 0);
    const program = this.use('SubtractScene', 0);
    this.bindTarget('sceneColorRT');
    this.gl.enable(this.gl.BLEND);
    this.fullscreen(program, { textures: { _SceneColor: this.targets.get('sceneColorRT'), _Mask: this.targets.get('scratchC') } });
    return true;
  }

  /**
   * The `fxRenderList` screen-space passes, rendered onto their own canvas so they can be composited
   * **additively** over the preview instead of replacing it.
   *
   * `BlockRender.Start` stretches every canvas in `fxRenderList` to the full screen, points it at the
   * main camera and leaves the material on it. That is the only mechanism that can host
   * `DisabledBlock`, `ReadyBlock` and `TouchEffect`: none of them appears in `LateUpdate`, in
   * `RenderEffects` or in `RefreshSceneColorCommands`, yet all three sample screen-space masks and
   * `composedDisabledBlockRT`, which only exists after compose pass 1. They therefore run as
   * full-screen canvases through the main camera, between compose pass 1 (a `LateUpdate` step) and
   * the command buffer that copies the camera target into `sceneColorRT`.
   *
   * Both passes blend additively (`One, One` and `SrcAlpha, One`), so in the game they only add to the
   * camera target, which already holds the background, judge lines and notes: the disabled fill never
   * *replaces* what is behind it. Colour alone cannot express that here, because these passes also
   * write an **alpha** proportional to the block's coverage (`One, One` accumulates it), and a GL
   * canvas blitted with `source-over` uses that alpha to attenuate the destination — a disabled block
   * would therefore darken 40-60 % of the pixels it covers. Keeping the layer separate and drawing it
   * with `globalCompositeOperation = 'lighter'` reproduces the additive intent: colour adds, alpha is
   * left alone.
   */
  renderSceneEffects(seconds) {
    if (typeof document === 'undefined') return false;
    const layer = this.sceneEffectsCanvas ??= document.createElement('canvas');
    if (layer.width !== this.canvas.width || layer.height !== this.canvas.height) {
      layer.width = this.canvas.width;
      layer.height = this.canvas.height;
    }
    const previousCanvas = this.canvas;
    this.canvas = layer;
    try {
      // Start from transparent. The scene stays in `sceneColorRT` for `_SceneColor` sampling and the
      // 2D preview draws the real background underneath; blitting the scene here as well would
      // double it, because this layer is composited over that same background.
      this.beginPass(null);
      this.disabledBlock(null, seconds);
      this.readyPulse(null, seconds);
    } finally {
      this.canvas = previousCanvas;
    }
    return true;
  }

  /**
   * `Unlit/TouchEffect` — the touch layer.
   *
   * `ActiveBlock` samples it as `_TouchHoverRT` and reads `_TouchPos[10]` / `_TouchPosCount`. An
   * editor preview has no touch input, so the pass is exercised with `count = 0` and contributes
   * nothing; the shader is compiled and wired but has no visible effect without pointer data.
   */
  touchEffect(dest, seconds, positions = []) {
    const gl = this.gl;
    this.bindTarget(dest);
    gl.enable(gl.BLEND);
    const program = this.use('TouchEffect', 0);
    this.applyMaterial(program, 'TouchEffect', seconds);
    const count = program.uniforms.get('_TouchPosCount');
    this.setUniform(program, '_TouchPosCount', positions.length);
    void count;
    for (const [index, position] of positions.slice(0, 10).entries()) {
      // `getActiveUniform` reports array elements as `_TouchPos[0]`, whose location is the base of
      // the array; consecutive elements follow contiguously.
      const name = index === 0 ? '_TouchPos' : `_TouchPos[${index}]`;
      const location = program.uniforms.get(name);
      if (location != null) gl.uniform2f(location, position.x, position.y);
    }
    this.fullscreen(program, {
      textures: {
        _DisplaceMap: this.textures.get('_DisplaceMap'),
        _TouchHoverRT: this.targets.get('touchBlockRT'),
        _NoiseMap: this.textures.get('_NoiseMap'),
      },
    });
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Maps the unit quad's `[0,1]²` onto clip space's `[-1,1]²`, i.e. the whole target.
 *
 * The quad buffer spans `[0,1]`, so an identity projection would cover only the upper-right
 * quadrant — every full-screen pass would draw into a quarter of the target.
 */
export const FULLSCREEN_PROJECTION = new Float32Array([
  2, 0, 0, 0,
  0, 2, 0, 0,
  0, 0, 1, 0,
  -1, -1, 0, 1,
]);

/**
 * Column-major MVP for one block quad.
 *
 * The buffer holds a unit quad spanning [0,1]², so it is first centred, then scaled by the block's
 * (signed) `size`, rotated by its counter-clockwise angle and translated to `center`. The
 * projection maps the game's screen space — `blockScreen(aspect)`, i.e. 10 world units tall and
 * `10 × aspect` wide, origin at the middle — onto clip space.
 */
export function blockMatrix({ center, size, rotation, screen }) {
  const radians = rotation * (Math.PI / 180);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const sx = size.x;
  const sy = size.y;
  const kx = 2 / screen.x;
  const ky = 2 / screen.y;
  // R * S with the -0.5 centring folded into the translation.
  return new Float32Array([
    kx * sx * cos, ky * sx * sin, 0, 0,
    -kx * sy * sin, ky * sy * cos, 0, 0,
    0, 0, 1, 0,
    kx * (center.x - 0.5 * sx * cos + 0.5 * sy * sin),
    ky * (center.y - 0.5 * sx * sin - 0.5 * sy * cos),
    0, 1,
  ]);
}

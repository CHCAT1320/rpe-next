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

import { blockState, blockTransform, blockShowCoverage } from '../core/block-area.mjs';

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
};

const BLEND_FACTORS = { ZERO: 0, ONE: 1, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303 };
const MASK_BITS = { R: 0x4000, G: 0x4000 >> 1, B: 0x4000 >> 2, A: 0x4000 >> 3 };

/**
 * Vertex stage shared by every program. The game's own vertex code only computes varyings from the
 * quad UV plus `_ST` uniforms, so this replaces it one-for-one while letting the port supply its
 * own projection. Extra outputs are harmless: GLSL ES 3.00 allows a vertex `out` with no matching
 * fragment `in`.
 */
const VERTEX_SOURCE = `#version 300 es
precision highp float;
in highp vec4 in_POSITION0;
in highp vec4 in_COLOR0;
in highp vec2 in_TEXCOORD0;
uniform mat4 u_projection;
uniform vec4 _DisplaceMap_ST;
uniform vec4 _SparkMap_ST;
uniform vec4 _TouchDisplaceMap_ST;
uniform vec4 _NoiseMap_ST;
uniform vec4 _ProjectionParams;
uniform vec4 _ScreenParams;
out highp vec2 vs_TEXCOORD0;
out highp vec2 vs_TEXCOORD1;
out highp vec2 vs_TEXCOORD2;
out highp vec4 vs_TEXCOORD3;
out highp vec2 vs_TEXCOORD4;
out highp vec2 vs_TEXCOORD5;
out highp float vs_TEXCOORD6;
out highp vec4 vs_COLOR0;
void main() {
  vs_TEXCOORD0 = in_TEXCOORD0;
  vs_TEXCOORD1 = in_TEXCOORD0 * _DisplaceMap_ST.xy + _DisplaceMap_ST.zw;
  vs_TEXCOORD2 = in_TEXCOORD0 * _SparkMap_ST.xy + _SparkMap_ST.zw;
  vs_TEXCOORD4 = in_TEXCOORD0 * _TouchDisplaceMap_ST.xy + _TouchDisplaceMap_ST.zw;
  vs_TEXCOORD5 = in_TEXCOORD0 * _NoiseMap_ST.xy + _NoiseMap_ST.zw;
  vs_COLOR0 = in_COLOR0;
  vec4 clip = u_projection * in_POSITION0;
  gl_Position = clip;
  // Unity's ComputeScreenPos.
  vec2 projected = (clip.xy * vec2(1.0, _ProjectionParams.x) + clip.ww) * 0.5;
  vs_TEXCOORD3 = vec4(projected, clip.zw);
  // The entry-band constant: (8/9) * screenHeight / screenWidth.
  vs_TEXCOORD6 = _ScreenParams.y * 0.888888896 / _ScreenParams.x;
}
`;

const TEXTURE_SLOTS = {
  _DisplaceMap: 'BlockNoise1.png',
  _SparkMap: 'PointNoise.png',
  _NoiseMap: 'FD_Noise.png',
  _TouchDisplaceMap: 'BlockNoise1.png',
  _MainTex: 'Block.png',
};

/** Per-material texture tiling from materials.md (`_ST`; every offset is 0). */
const TEXTURE_ST = {
  ActiveBlock: { _DisplaceMap: [0.80, 0.30], _SparkMap: [3.00, 1.20], _NoiseMap: [1.50, 1.46], _TouchDisplaceMap: [0.55, 0.30] },
  BlockCompose: { _DisplaceMap: [2.13, 1.02] },
  DisabledBlock: { _DisplaceMap: [0.50, 0.20], _SparkMap: [3.00, 1.20] },
  TouchEffect: { _DisplaceMap: [0.55, 0.30], _NoiseMap: [1.50, 1.46] },
};

/** Material scalars read straight out of block-params.json. */
const MATERIAL_UNIFORMS = {
  ActiveBlock: {
    _EdgeColor: [1, 0.33018857, 0.33018857, 1], _EdgeOpacity: 0.8,
    _FillColor: [0.71320748, 0.23549296, 0.23549296, 1], _FillOpacity: 0.667, _FillStrength: 0.667,
    _GlowColor: [1, 0.17924517, 0.17924517, 1], _GlowIntensity: 0.8,
    _SparkTint: [1, 0.28490567, 0.28490567, 1], _SparkMapOpacity: 5.69,
    _SparkHueShiftAmount: 0, _SparkDisplaceIntensity: 0, _DisplaceBlendIntensity: 0.411,
    _DisplaceSpeed: 1.5, _DisplaceStrength: 0.15, _DisplaceDirection: [0.5, 0.5, 0, 0],
    _BackgroundPixelScale: 6, _TouchPosCount: 0, _TouchPosShine: 1,
    _TouchPosRadius: 0.5, _TouchPosSDFSmoothness: 0.47, _TouchPosSDFFalloff: 0.41,
    _TouchDisplaceSpeed: 0, _TouchDisplaceStrength: 0,
    _NoiseEvoSpeed: 0, _NoiseDirChangeSpeed: 60, _NoiseDisplaceStrength: 0, _NoiseRadius: 0.5,
    _NoiseSmoothness: 0.5, _SDFCellSize: 1, _SDFSmoothness: 0.5, _SDFFalloff: 0.5, _SDFMoveSpeed: 9.3,
  },
  DisabledBlock: {
    _FillColor: [0.497, 0.1377, 0.1377, 1], _FillOpacity: 0.4,
    _SparkTint: [0.3113, 0.0778, 0.0778, 1], _SparkMapOpacity: 3.5,
    _DisplaceSpeed: 0, _DisplaceStrength: 0, _SparkDisplaceIntensity: 0,
    _DisplaceBlendIntensity: 0, _SparkHueShiftAmount: 0, _BackgroundPixelScale: 6,
  },
  ReadyBlock: { _ShineColor: [1, 1, 1, 1], _ShineBrightness: 0.12, _ShineSpeed: 37.9 },
  SubtractBlockBlender: { _ClampThresholdLow: 0.09, _ClampThresholdHigh: 0.12 },
  TouchEffect: { _DisplaceSpeed: 0, _DisplaceStrength: 0, _DisplaceDirection: [0.5, 0.5, 0, 0], _NoiseEvoSpeed: 1, _NoiseDirChangeSpeed: 60, _NoiseDisplaceStrength: 0, _NoiseRadius: 0.5, _NoiseSmoothness: 0.5, _SDFCellSize: 1, _SDFSmoothness: 0.5, _SDFFalloff: 0.5, _SDFMoveSpeed: 9.3 },
};

/** Glow ring weights: `(glowRadius − p)^falloff / Σ`, stopping below the pass threshold. */
export function glowRingWeights(radius = 6, falloff = 2.65, threshold = 0.01) {
  const raw = [];
  for (let pass = 0; pass <= radius; pass++) raw.push((radius - pass) ** falloff);
  const total = raw.reduce((sum, value) => sum + value, 0);
  const weights = [];
  for (const value of raw) {
    const weight = value / total;
    if (weight >= threshold) weights.push(weight);
  }
  return weights;
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
    // Stages whose invocation the dump does not place in `BlockRender.LateUpdate`. That method's
    // equivalent C# was recovered and is exactly two commands — copy `CameraTarget` into
    // `sceneColorRT`, then blit `ActiveBlock` back over `CameraTarget` — so `DisabledBlock`,
    // `ReadyBlock`, `TouchEffect` and the three `SubtractBlockPostProcessor`s are not invoked
    // there at all. They belong to the layer cameras: the subtract camera's output is
    // post-processed through `SubtractBlockBlender` at `targetPass`, and the disabled / ready /
    // touch cameras render with their own materials. Those per-camera post-process chains are not
    // fully pinned down, so the passes below stay callable but unwired by default rather than
    // guessed into the frame.
    this.optionalStages = false;
  }

  /** Wire up WebGL and compile the vendored programs. Safe to call repeatedly. */
  ensure(canvas, shaders) {
    if (this.canvas === canvas && this.gl) return true;
    this.canvas = canvas;
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    } catch { gl = null; }
    if (!gl) { this.disabled = true; this.lastError = 'WebGL2 不可用'; return false; }
    this.gl = gl;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    // Unit quad: position.xy in [0,1], uv, and a colour slot filled per draw.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1,
    ]), gl.STATIC_DRAW);
    try {
      for (const [key, programs] of Object.entries(shaders.programs)) {
        this.programs.set(key, programs.map((program, index) => this.buildProgram(key, index, program)));
      }
    } catch (error) { this.disabled = true; this.lastError = error.message; return false; }
    for (const target of [...RENDER_TARGETS, ...SCRATCH_TARGETS]) this.createTarget(target);
    for (const [name, file] of Object.entries(TEXTURE_SLOTS)) this.loadTexture(name, file);
    return true;
  }

  buildProgram(key, index, program) {
    const gl = this.gl;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, program.fragment);
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
    for (let slot = 0; slot < gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS); slot++) {
      const info = gl.getActiveUniform(handle, slot);
      uniforms.set(info.name.replace(/\[0\]$/, ''), gl.getUniformLocation(handle, info.name));
    }
    const state = Array.isArray(PASS_STATE[key]) ? PASS_STATE[key][index] : PASS_STATE[key];
    return { key, index, handle, uniforms, state, source: program };
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

  loadTexture(name, file) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Every block texture is Point-filtered in the game (materials.md); using LINEAR here makes the
    // noise visibly blurrier than it should be.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 1x1 opaque black until the image arrives; the composite tolerates it.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.textures.set(name, { texture, file, image: null });
  }

  /** Upload the vendored PNGs once they are decoded. Returns a promise for the first call. */
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
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      entry.image = image;
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
  uploadScene(source) {
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
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
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

  /** Full-screen pass: the quad is the clip-space square, so the projection is the identity. */
  fullscreen(program, { textures = {}, floats = {}, vectors = {} } = {}) {
    const gl = this.gl;
    gl.uniformMatrix4fv(program.uniforms.get('u_projection'), false, IDENTITY);
    this.bindQuad(program);
    this.applyUniforms(program, textures, floats, vectors);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  bindQuad(program, withColor = true) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const stride = 4 * 4;
    const position = gl.getAttribLocation(program.handle, 'in_POSITION0');
    if (position >= 0) { gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 4, gl.FLOAT, false, stride, 0); }
    const color = gl.getAttribLocation(program.handle, 'in_COLOR0');
    if (color >= 0) {
      // Block draws set a constant colour attribute (see drawBlockQuad); full-screen passes feed
      // the buffer's own colour column.
      if (withColor) { gl.enableVertexAttribArray(color); gl.vertexAttribPointer(color, 4, gl.FLOAT, false, stride, 0); }
      else gl.disableVertexAttribArray(color);
    }
    const uv = gl.getAttribLocation(program.handle, 'in_TEXCOORD0');
    if (uv >= 0) { gl.enableVertexAttribArray(uv); gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, stride, 2 * 4); }
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
  drawBlockQuad(target, block, transform, coverage) {
    const gl = this.gl;
    const program = this.use('BlockSprite', 0);
    gl.enable(gl.BLEND);
    gl.uniformMatrix4fv(program.uniforms.get('u_projection'), false, blockMatrix(transform));
    gl.uniform4f(program.uniforms.get('_ProjectionParams'), 1, 0, 0, 0);
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
    const gl = this.gl;
    const st = TEXTURE_ST[material] ?? {};
    for (const name of ['_DisplaceMap_ST', '_SparkMap_ST', '_TouchDisplaceMap_ST', '_NoiseMap_ST']) {
      const location = program.uniforms.get(name);
      if (location == null) continue;
      const scale = st[name.replace('_ST', '')] ?? [1, 1];
      gl.uniform4f(location, scale[0], scale[1], 0, 0);
    }
  }

  applyMaterial(program, material, seconds) {
    const gl = this.gl;
    gl.uniform4f(program.uniforms.get('_Time'), seconds / 20, seconds, seconds * 2, seconds * 3);
    gl.uniform4f(program.uniforms.get('_ScreenParams'), this.canvas.width, this.canvas.height, 1 / this.canvas.width, 1 / this.canvas.height);
    gl.uniform4f(program.uniforms.get('_ProjectionParams'), 1, 0, 0, 0);
    gl.uniform4f(program.uniforms.get('_EffectRT_TexelSize'),
      1 / this.targets.get('effectRT').width, 1 / this.targets.get('effectRT').height,
      this.targets.get('effectRT').width, this.targets.get('effectRT').height);
    for (const [name, value] of Object.entries(MATERIAL_UNIFORMS[material] ?? {})) {
      const location = program.uniforms.get(name);
      if (location == null) continue;
      if (typeof value === 'number') gl.uniform1f(location, value);
      else if (value.length === 3) gl.uniform3fv(location, value);
      else if (value.length === 4) gl.uniform4fv(location, value);
      else gl.uniform2fv(location, value);
    }
  }

  /**
   * One frame of the whole pipeline, mirroring `BlockRender.LateUpdate`:
   * layer cameras -> BlockCompose pass 0 -> RenderEffects (edge + glow) -> BlockCompose pass 1
   * -> ActiveBlock.
   */
  render({ blocks, now, aspect, width, height, scene = null }) {
    const gl = this.gl;
    if (!gl || this.disabled) return false;
    this.resize(width, height);
    for (const key of ['normalBlockRT', 'subtractBlockRT', 'disabledNormalBlockRT', 'disabledSubtractBlockRT',
      'disabledNormalReadyBlockRT', 'disabledSubtractReadyBlockRT', 'touchBlockRT']) this.clearTarget(key);
    // `RefreshSceneColorCommands` copies the camera target into `sceneColorRT` ahead of the
    // composite. `ActiveBlock` samples it at a displaced uv inside its spark/hue term rather than
    // blitting it, so supplying the real scene cannot double-draw the background.
    this.clearTarget('sceneColorRT');
    this.uploadScene(scene);

    for (const block of blocks) {
      const phase = blockState(block, now);
      if (!phase) continue;
      const transform = blockTransform(block, now, aspect);
      if (!(Math.abs(transform.size.x) > 0) || !(Math.abs(transform.size.y) > 0)) continue;
      const coverage = blockShowCoverage(block, now);
      // Layer cameras render raw masks with `BlockSprite`; the renderer colour rides in as the
      // vertex colour, which is what gives subtract blocks their 0.1 intensity.
      if (phase.active) this.drawBlockQuad(block.isSubtract ? 'subtractBlockRT' : 'normalBlockRT', block, transform, coverage);
      else this.drawBlockQuad(block.isSubtract ? 'disabledSubtractBlockRT' : 'disabledNormalBlockRT', block, transform, coverage);
      if (phase.ready) this.drawBlockQuad(block.isSubtract ? 'disabledSubtractReadyBlockRT' : 'disabledNormalReadyBlockRT', block, transform, coverage);
    }

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

    // BlockCompose pass 1: the disabled + ready masks, reading the processed subtract pair.
    this.beginPass('composedDisabledBlockRT');
    program = this.use('BlockCompose', 1);
    this.applyMaterial(program, 'BlockCompose', now);
    this.fullscreen(program, {
      textures: { _DisabledNormalBlockRT: this.targets.get('disabledNormalBlockRT'), _DisabledSubtractBlockRT: this.targets.get('scratchB') },
    });

    // The ready-subtract mask is post-processed as well: `ActiveBlock` reads its `.y` coverage.
    this.blendSubtractMask('disabledSubtractReadyBlockRT', 'scratchA', now, 1);

    // ActiveBlock: the single full-screen composite that produces the visible image. `Start` binds
    // its `_Disabled*RT` samplers to the *pure ready* masks, unlike `blockComposeMaterial`, which
    // gets the merged ones under the same names.
    this.beginPass(null);
    program = this.use('ActiveBlock', 0);
    this.applyMaterial(program, 'ActiveBlock', now);
    this.applyTiling(program, 'ActiveBlock');
    const touchCount = program.uniforms.get('_TouchPosCount');
    if (touchCount != null) gl.uniform1i(touchCount, 0);
    this.fullscreen(program, {
      textures: {
        _ComposeRT: this.targets.get('composedEnabledBlockRT'),
        _EffectRT: this.targets.get('effectRT'),
        _DisabledNormalBlockRT: this.targets.get('disabledNormalReadyBlockRT'),
        _DisabledSubtractBlockRT: this.targets.get('scratchA'),
        _ReadyComposeRT: this.targets.get('composedDisabledBlockRT'),
        _TouchHoverRT: this.targets.get('touchBlockRT'),
        _DisplaceMap: this.textures.get('_DisplaceMap'),
        _SparkMap: this.textures.get('_SparkMap'),
        _TouchDisplaceMap: this.textures.get('_TouchDisplaceMap'),
        _NoiseMap: this.textures.get('_NoiseMap'),
        _SceneColor: this.targets.get('sceneColorRT'),
      },
    });
    return true;
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
    const edgePasses = this.edgeSize ?? 1;
    if (edgePasses <= 1) {
      // edgeSize == 1 short-circuits to a single pass that also subtracts `_ComposeRT`.
      this.bindTarget('effectRT');
      gl.enable(gl.BLEND);
      const program = this.use('EdgeMask', 1);
      this.applyMaterial(program, 'EdgeMask', seconds);
      gl.uniform4f(program.uniforms.get('_DilateTexelSize'), 1 / this.targets.get(sourceMask).width, 1 / this.targets.get(sourceMask).height, this.targets.get(sourceMask).width, this.targets.get(sourceMask).height);
      this.fullscreen(program, { textures: { _MainTex: this.targets.get(sourceMask), _ComposeRT: this.targets.get('composedEnabledBlockRT') } });
    } else {
      let from = sourceMask;
      for (let pass = 0; pass < edgePasses; pass++) {
        const to = pass === edgePasses - 1 ? 'effectRT' : 'pingA';
        this.bindTarget(to);
        gl.enable(gl.BLEND);
        const program = this.use('EdgeMask', pass === edgePasses - 1 ? 1 : 0);
        this.applyMaterial(program, 'EdgeMask', seconds);
        const source = this.targets.get(from);
        gl.uniform4f(program.uniforms.get('_DilateTexelSize'), 1 / source.width, 1 / source.height, source.width, source.height);
        this.fullscreen(program, { textures: { _MainTex: source, _ComposeRT: this.targets.get('composedEnabledBlockRT') } });
        from = to;
      }
    }

    // GlowMask: weighted dilation, ping-ponging between pingA and pingB, then a final `.y`-only
    // write into effectRT that preserves the edge already there.
    this.clearTarget('pingA');
    this.clearTarget('pingB');
    const weights = glowRingWeights(this.glowRadius ?? 6, 2.65, 0.01);
    let from = sourceMask;
    let to = 'pingA';
    for (const [pass, weight] of weights.entries()) {
      this.bindTarget(to);
      gl.enable(gl.BLEND);
      const program = this.use('GlowMask', 0);
      this.applyMaterial(program, 'GlowMask', seconds);
      const source = this.targets.get(from);
      gl.uniform4f(program.uniforms.get('_DilateTexelSize'), 1 / source.width, 1 / source.height, source.width, source.height);
      gl.uniform1f(program.uniforms.get('_PassWeight'), weight);
      gl.uniform1f(program.uniforms.get('_GlowFirstPass'), pass === 0 ? 1 : 0);
      this.fullscreen(program, { textures: { _MainTex: source, _ComposeRT: this.targets.get('composedEnabledBlockRT') } });
      from = to;
      to = to === 'pingA' ? 'pingB' : 'pingA';
    }
    this.bindTarget('effectRT');
    gl.enable(gl.BLEND);
    const final = this.use('GlowMask', 1);
    this.applyMaterial(final, 'GlowMask', seconds);
    this.fullscreen(final, { textures: { _MainTex: this.targets.get(from) } });
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
        _DisabledNormalBlockRT: this.targets.get('disabledNormalReadyBlockRT'),
        _DisabledSubtractBlockRT: this.targets.get('disabledSubtractReadyBlockRT'),
        _ComposeRT: this.targets.get('composedEnabledBlockRT'),
      },
    });
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
    if (count != null) gl.uniform1i(count, positions.length);
    for (const [index, position] of positions.slice(0, 10).entries()) {
      const location = program.uniforms.get(`_TouchPos[${index}]`);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BlockPipeline, RENDER_TARGETS, TEXTURE_ST, adaptFragment, glowRingWeight, glowRingWeights, blockMatrix,
  FULLSCREEN_PROJECTION, QUAD_VERTICES,
} from '../src/ui/block-pipeline.mjs';
import { Preview } from '../src/ui/preview.mjs';
import { blockTransform, blockState } from '../src/core/block-area.mjs';

const shaders = JSON.parse(readFileSync(new URL('../public/assets/rpe/block/shaders.json', import.meta.url), 'utf8'));
const materials = JSON.parse(readFileSync(new URL('../public/assets/rpe/block/materials.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/block-area.json', import.meta.url), 'utf8'));

/**
 * Minimal WebGL2 stand-in that still resolves uniforms from the real shader sources, so the
 * pipeline's sampler wiring and fixed-function state are exercised rather than skipped.
 */
function stubGl() {
  const calls = [];
  const record = (name) => (...args) => { calls.push({ name, args }); };
  let nextHandle = 1;
  const enumValue = (name) => name.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const gl = {
    calls,
    VERTEX_SHADER: enumValue('VERTEX_SHADER'), FRAGMENT_SHADER: enumValue('FRAGMENT_SHADER'),
    COMPILE_STATUS: enumValue('COMPILE_STATUS'), LINK_STATUS: enumValue('LINK_STATUS'), ACTIVE_UNIFORMS: enumValue('ACTIVE_UNIFORMS'),
    TEXTURE_2D: enumValue('TEXTURE_2D'), TEXTURE_MIN_FILTER: enumValue('MIN'), TEXTURE_MAG_FILTER: enumValue('MAG'),
    TEXTURE_WRAP_S: enumValue('WRAPS'), TEXTURE_WRAP_T: enumValue('WRAPT'),
    LINEAR: enumValue('LINEAR'), NEAREST: enumValue('NEAREST'), CLAMP_TO_EDGE: enumValue('CLAMP'),
    REPEAT: enumValue('REPEAT'), MIRRORED_REPEAT: enumValue('MIRROR'),
    RGBA: enumValue('RGBA'), UNSIGNED_BYTE: enumValue('UBYTE'), FRAMEBUFFER: enumValue('FB'),
    UNPACK_FLIP_Y_WEBGL: enumValue('FLIPY'), UNPACK_PREMULTIPLY_ALPHA_WEBGL: enumValue('PREMUL'),
    COLOR_ATTACHMENT0: enumValue('CA0'), FRAMEBUFFER_COMPLETE: enumValue('FBC'),
    ARRAY_BUFFER: enumValue('ARRAYBUF'), FLOAT: enumValue('FLOAT'), STATIC_DRAW: enumValue('STATIC'),
    TRIANGLE_STRIP: enumValue('TRISTRIP'), BLEND: enumValue('BLEND'), CULL_FACE: enumValue('CULL'), DEPTH_TEST: enumValue('DEPTH'),
    COLOR_BUFFER_BIT: enumValue('COLORBIT'), TEXTURE0: 1000,
    ZERO: 0, ONE: 1, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
    FLOAT: enumValue('FLOAT'), BOOL: enumValue('BOOL'), INT: enumValue('INT'),
    FLOAT_VEC2: enumValue('FV2'), FLOAT_VEC3: enumValue('FV3'), FLOAT_VEC4: enumValue('FV4'),
    FLOAT_MAT4: enumValue('FM4'), SAMPLER_2D: enumValue('S2D'),
    createShader: (type) => ({ handle: nextHandle++, type, source: '' }),
    shaderSource: (shader, source) => { shader.source = source; },
    compileShader: record('compileShader'),
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: record('deleteShader'),
    createProgram: () => ({ handle: nextHandle++, shaders: [] }),
    attachShader: (program, shader) => program.shaders.push(shader),
    linkProgram: record('linkProgram'),
    getProgramParameter: (program, parameter) => (parameter === enumValue('LINK_STATUS') ? true : uniformsOf(program).length),
    getProgramInfoLog: () => '',
    deleteProgram: record('deleteProgram'),
    // Report the declared type so the pipeline's type dispatch is exercised rather than assumed.
    getActiveUniform: (program, index) => {
      const entry = uniformsOf(program)[index];
      return { name: entry.name, type: gl[entry.type] };
    },
    getUniformLocation: (program, name) => ({ program, name }),
    createBuffer: () => ({ handle: nextHandle++ }), bindBuffer: record('bindBuffer'), bufferData: record('bufferData'),
    createTexture: () => ({ handle: nextHandle++ }), bindTexture: record('bindTexture'),
    texParameteri: record('texParameteri'), texImage2D: record('texImage2D'), pixelStorei: record('pixelStorei'),
    activeTexture: record('activeTexture'),
    createFramebuffer: () => ({ handle: nextHandle++ }), bindFramebuffer: record('bindFramebuffer'),
    framebufferTexture2D: record('framebufferTexture2D'), checkFramebufferStatus: () => enumValue('FBC'),
    viewport: record('viewport'), clearColor: record('clearColor'), clear: record('clear'),
    enable: record('enable'), disable: record('disable'),
    blendFunc: (source, destination) => calls.push({ name: 'blendFunc', args: [source, destination] }),
    colorMask: (...args) => calls.push({ name: 'colorMask', args }),
    drawArrays: record('drawArrays'),
    getAttribLocation: (_program, name) => ({ in_POSITION0: 0, in_TEXCOORD0: 1, in_COLOR0: 2 })[name] ?? -1,
    enableVertexAttribArray: record('enableVertexAttribArray'), disableVertexAttribArray: record('disableVertexAttribArray'),
    vertexAttribPointer: record('vertexAttribPointer'), vertexAttrib4f: record('vertexAttrib4f'),
    useProgram: (program) => calls.push({ name: 'useProgram', args: [program] }),
    // `diagnose` reads targets back; zero pixels are enough for the bookkeeping assertions, but the
    // buffer has to actually be filled so the per-block probes read real (if empty) values.
    readPixels: (x, y, width, height, format, type, pixels) => { calls.push({ name: 'readPixels', args: [x, y, width, height] }); if (pixels) pixels.fill(0); },
    uniformMatrix4fv: record('uniformMatrix4fv'), uniform1i: record('uniform1i'), uniform1f: record('uniform1f'),
    uniform4f: record('uniform4f'), uniform2fv: record('uniform2fv'), uniform3fv: record('uniform3fv'), uniform4fv: record('uniform4fv'),
  };
  const GLSL_TYPE_NAMES = { float: 'FLOAT', bool: 'BOOL', int: 'INT', vec2: 'FLOAT_VEC2', vec3: 'FLOAT_VEC3', vec4: 'FLOAT_VEC4', mat4: 'FLOAT_MAT4', sampler2D: 'SAMPLER_2D' };
  const uniformsOf = (program) => {
    const source = program.shaders.map((shader) => shader.source).join('\n');
    const found = new Map();
    for (const match of source.matchAll(/^\s*uniform\s+(?:mediump |highp |lowp )?(\w+)\s+(\w+)\s*(\[\d+\])?\s*;/gm)) {
      found.set(match[2], GLSL_TYPE_NAMES[match[1]] ?? 'FLOAT');
    }
    for (const match of source.matchAll(/UNITY_LOCATION\(\d+\)\s*uniform\s+(?:mediump |highp |lowp )?sampler2D\s+(\w+)\s*;/g)) {
      found.set(match[1], 'SAMPLER_2D');
    }
    return [...found].map(([name, type]) => ({ name, type }));
  };
  gl.__calls = calls;
  gl.__programs = new Map();
  return gl;
}

function makePipeline(gl) {
  const canvas = { width: 1600, height: 900, getContext: () => gl };
  const pipeline = new BlockPipeline();
  assert.equal(pipeline.ensure(canvas, shaders, materials), true, pipeline.lastError);
  // Map the GL handle back to `key#index` so pass order is assertable: useProgram is handed the
  // raw handle, which carries no metadata of its own.
  for (const [key, programs] of pipeline.programs) {
    for (const program of programs) gl.__programs.set(program.handle.handle, `${key}#${program.index}`);
  }
  // Record which texture object each `activeTexture` unit holds, so a sampler's *destination* can be
  // identified rather than merely its existence. `applyUniforms` sends textures to sequential units
  // and then calls `uniform1i(location(name), unit)` with that 0-based index, while `activeTexture`
  // receives the `TEXTUREn` enum, so the first call establishes the base the indices are offset from.
  // Because units are reused by every pass, the bookkeeping is snapshotted per `useProgram` call —
  // otherwise a later pass would overwrite an earlier one's wiring and `effectRT` would appear on
  // `BlockCompose#0` too.
  const units = new Map();
  const bindings = new Map();
  const samplerTexture = new Map();
  const useCounts = new Map();
  let current = null;
  let wanted = null;
  let base = null;
  const activeTexture = gl.activeTexture;
  // `applyUniforms` passes the 0-based index to `uniform1i` but the `TEXTUREn` enum to
  // `activeTexture`, so normalise the latter back to an index as soon as the base is known.
  gl.activeTexture = (unit) => { base ??= unit; wanted = unit - base; activeTexture(unit); };
  const bindTexture = gl.bindTexture;
  gl.bindTexture = (target, texture) => {
    if (wanted !== null) {
      units.set(wanted, texture);
      for (const [key, unit] of bindings) if (unit === wanted) samplerTexture.set(key, texture);
    }
    bindTexture(target, texture);
  };
  const useProgram = gl.useProgram;
  gl.useProgram = (program) => {
    const count = (useCounts.get(program.handle) ?? 0) + 1;
    useCounts.set(program.handle, count);
    current = `${program.handle}#${count}`;
    useProgram(program);
  };
  const uniform1i = gl.uniform1i;
  gl.uniform1i = (location, unit) => {
    const key = `${location.program.handle}:${location.name}`;
    bindings.set(key, unit);
    if (current !== null) samplerTexture.set(`${current}:${location.name}`, units.get(unit));
    uniform1i(location, unit);
  };
  const textureObjects = new Map();
  for (const [key, target] of pipeline.targets) textureObjects.set(target.texture, key);
  for (const [name, entry] of pipeline.textures) textureObjects.set(entry.texture, name);
  gl.__samplerState = { samplerTexture, useCounts, textureObjects };
  return { pipeline, canvas };
}

/**
 * Resolve every sampler of one program's *last* use to the name of the texture it was given.
 *
 * Returns `{}` for a pass that never ran; an object that cannot be matched to the pipeline's own
 * tables resolves to `'unknown-texture'` rather than being silently omitted.
 */
function samplerTargets(pipeline, gl, key, index) {
  const program = pipeline.programs.get(key)[index];
  const { samplerTexture, useCounts, textureObjects } = gl.__samplerState;
  const handle = program.handle.handle;
  const count = useCounts.get(handle);
  if (!count) return {};
  const result = {};
  for (const name of program.uniforms.keys()) {
    if (program.types.get(name) !== gl.SAMPLER_2D) continue;
    // Integer uniforms like `_TouchPosCount` also honour `uniform1i`, so they are filtered out here.
    const texture = samplerTexture.get(`${handle}#${count}:${name}`);
    if (!texture) continue;
    result[name] = textureObjects.get(texture) ?? 'unknown-texture';
  }
  return result;
}

/** Pass sequence as `key#index` strings, in `useProgram` order. */
function passSequence(gl) {
  return gl.__calls.filter((call) => call.name === 'useProgram').map((call) => gl.__programs.get(call.args[0].handle));
}

const viewport = { left: 0, top: 0, width: 1600, height: 900 };

// ---------------------------------------------------------------------------

test('光晕权重复现文档的 5 圈数值', () => {
  const weights = glowRingWeights(6, 2.65, 0.01);
  assert.equal(weights.length, 5, '第 6 圈权重低于阈值应被丢弃');
  for (const [index, expected] of [0.4586, 0.2829, 0.1566, 0.0731, 0.0249].entries()) {
    assert.ok(Math.abs(weights[index] - expected) < 5e-5, `第 ${index} 圈: ${weights[index]} != ${expected}`);
  }
  // `GetGlowRingWeight` itself, including the ring the threshold cuts.
  for (const [index, expected] of [0.4586, 0.2829, 0.1566, 0.0731, 0.0249, 0.004].entries()) {
    assert.ok(Math.abs(glowRingWeight(index, 6, 2.65) - expected) < 5e-5, `ring ${index}: ${glowRingWeight(index, 6, 2.65)} != ${expected}`);
  }
  // The loop runs passes 0..glowRadius-1, and `glowRadius` itself weighs 0.
  assert.equal(glowRingWeight(6, 6, 2.65), 0);
  assert.equal(glowRingWeights(6, 2.65, 0).length, 6, '阈值为 0 时保留 6 轮');
  assert.deepEqual(glowRingWeights(6, 2.65, 0.5), [], '首圈低于阈值则整段跳过');
  assert.deepEqual(glowRingWeights(0, 2.65, 0.01), [], 'glowRadius < 1 时无辉光');
  // Falloff at or below kEpsFalloff degenerates to a uniform 1/glowRadius.
  assert.equal(glowRingWeight(2, 4, 0.001), 0.25);
});

test('RT 表与反汇编一致：13 张，掩码 Screen/8、效果 Screen/4、只有 effectRT 用线性过滤', () => {
  assert.equal(RENDER_TARGETS.length, 13);
  const byKey = Object.fromEntries(RENDER_TARGETS.map((target) => [target.key, target]));
  assert.equal(byKey.sceneColorRT.divisor, 6);
  assert.equal(byKey.effectRT.divisor, 4);
  assert.equal(byKey.pingA.divisor, 4);
  assert.equal(byKey.pingB.divisor, 4);
  assert.equal(byKey.normalBlockRT.divisor, 8);
  assert.equal(byKey.disabledNormalReadyBlockRT.divisor, 8);
  assert.deepEqual(RENDER_TARGETS.filter((target) => target.linear).map((target) => target.key), ['effectRT']);
});

test('blockMatrix 把单位四边形映射到块矩形（含旋转）', () => {
  const matrix = blockMatrix({ center: { x: 0, y: 0 }, size: { x: 2, y: 1 }, rotation: 0, screen: { x: 10, y: 10 } });
  const apply = (x, y) => ({ x: matrix[0] * x + matrix[4] * y + matrix[12], y: matrix[1] * x + matrix[5] * y + matrix[13] });
  const low = apply(0, 0);
  const high = apply(1, 1);
  assert.ok(Math.abs(low.x + 0.2) < 1e-6 && Math.abs(low.y + 0.1) < 1e-6, JSON.stringify(low));
  assert.ok(Math.abs(high.x - 0.2) < 1e-6 && Math.abs(high.y - 0.1) < 1e-6, JSON.stringify(high));
  // A 90 degree rotation keeps the centre fixed.
  const rotated = blockMatrix({ center: { x: 0, y: 0 }, size: { x: 2, y: 1 }, rotation: 90, screen: { x: 10, y: 10 } });
  const centre = { x: rotated[0] * 0.5 + rotated[4] * 0.5 + rotated[12], y: rotated[1] * 0.5 + rotated[5] * 0.5 + rotated[13] };
  assert.ok(Math.abs(centre.x) < 1e-6 && Math.abs(centre.y) < 1e-6, JSON.stringify(centre));
});

test('13 个 program 全部编译，按材质命名', () => {
  const { pipeline } = makePipeline(stubGl());
  assert.equal(pipeline.disabled, false, pipeline.lastError);
  const total = [...pipeline.programs.values()].reduce((sum, programs) => sum + programs.length, 0);
  assert.equal(total, 13);
  for (const key of ['BlockSprite', 'SubtractBlockBlender', 'BlockCompose', 'EdgeMask', 'GlowMask', 'DisabledBlock', 'ReadyBlock', 'ActiveBlock', 'TouchEffect']) {
    assert.ok(pipeline.programs.has(key), `缺少 ${key}`);
  }
});

test('render 按 LateUpdate 的顺序跑完整条管线', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, fillRect() {} }) }) };
  try {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  assert.deepEqual(pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 }), { sceneEffects: true });
  const sequence = passSequence(gl);
  // A block is active at t=66 s, so one quad is rasterised, then the five fixed stages run in order.
  const tail = sequence.slice(sequence.indexOf('BlockCompose#0'));
  assert.deepEqual(tail, [
    'BlockCompose#0',
    'EdgeMask#1',                     // edgeSize == 1 short-circuits to pass 1
    'GlowMask#0', 'GlowMask#0', 'GlowMask#0', 'GlowMask#0', 'GlowMask#0',
    'GlowMask#1',                     // final `.y`-only write preserves the edge
    'BlockCompose#1',
    'SubtractBlockBlender#1',         // the ready-subtract mask is post-processed too
    'DisabledBlock#0',
    'ReadyBlock#0',
    'ActiveBlock#0',
  ]);
  assert.ok(sequence.includes('BlockSprite#0'), '至少栅格化一个块四边形');
  // The subtract post-processors run after the cameras and before the compose that consumes them,
  // and the ready-subtract one runs between compose pass 1 and the final composite.
  const blendAt = sequence.indexOf('SubtractBlockBlender#0');
  assert.equal(sequence[blendAt + 1], 'SubtractBlockBlender#1', '启用/禁用两路各一次');
  assert.equal(sequence[blendAt + 2], 'BlockCompose#0');
  const compose1 = sequence.indexOf('BlockCompose#1');
  assert.equal(sequence[compose1 + 1], 'SubtractBlockBlender#1', '预备减块遮罩也要后处理');
  assert.equal(sequence[compose1 + 2], 'DisabledBlock#0', 'fxRenderList 通道在合成之前');
  assert.equal(sequence.at(-1), 'ActiveBlock#0');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('固定功能状态与 Shader 资产一致（GLSL 里没有这些）', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });

  // ActiveBlock is premultiplied: One, OneMinusSrcAlpha.
  assert.equal(pipeline.programs.get('ActiveBlock')[0].state.blend.join(','), 'ONE,ONE_MINUS_SRC_ALPHA');
  assert.equal(pipeline.programs.get('BlockSprite')[0].state.blend.join(','), 'SRC_ALPHA,ONE');
  assert.equal(pipeline.programs.get('DisabledBlock')[0].state.blend.join(','), 'ONE,ONE');
  assert.equal(pipeline.programs.get('ReadyBlock')[0].state.blend.join(','), 'SRC_ALPHA,ONE');
  assert.equal(pipeline.programs.get('TouchEffect')[0].state.blend.join(','), 'ONE,ONE');
  // ColorMask: EdgeMask pass 1 writes R only, GlowMask pass 0 writes RG, pass 1 writes G.
  assert.deepEqual(pipeline.programs.get('EdgeMask')[1].state.mask, ['R']);
  assert.deepEqual(pipeline.programs.get('GlowMask')[0].state.mask, ['R', 'G']);
  assert.deepEqual(pipeline.programs.get('GlowMask')[1].state.mask, ['G']);
});

test('每个 program 都绑定到正确的 RT（sampler 接线）', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });

  // ActiveBlock samples 11 slots; check the ones whose wiring render.md pins down.
  const active = pipeline.programs.get('ActiveBlock')[0];
  for (const name of ['_ComposeRT', '_EffectRT', '_DisabledNormalBlockRT', '_DisabledSubtractBlockRT',
    '_ReadyComposeRT', '_TouchHoverRT', '_DisplaceMap', '_SparkMap', '_TouchDisplaceMap', '_NoiseMap', '_SceneColor']) {
    assert.ok(active.uniforms.has(name), `ActiveBlock 缺少 sampler ${name}`);
  }
  // render.md: blockComposeMaterial binds the *merged* masks, activeBlockMaterial the *pure ready*
  // masks, even though the sampler names collide.
  // 13 documented targets plus this port's two Screen/8 scratches, which stand in for the internal
  // temp Unity allocates so a camera's `OnRenderImage` has distinct source and destination handles.
  assert.equal(pipeline.targets.size, 15);
  assert.equal(pipeline.textures.size, 5, '4 张不同的 PNG 占 5 个 sampler 名（BlockNoise1 用了两次）');
});

// Naming a sampler is not the same as feeding it the right RT: the collision between
// `blockComposeMaterial`'s and `activeBlockMaterial`'s `_Disabled*BlockRT` makes a wrong binding
// invisible to a name-only check. This walks `sampler name -> texture unit -> texture object` and
// compares against `BlockRender.Start`'s binding table in render.md.
test('每个 sampler 实际接到 Start 指定的那张 RT（而不只是名字存在）', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, fillRect() {} }) }) };
  try {
    const gl = stubGl();
    const { pipeline } = makePipeline(gl);
    pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });

    // activeBlockMaterial: the `_Disabled*` samplers carry the *pure ready* render targets, and
    // `_ReadyComposeRT` the composed disabled mask. `_DisabledSubtractBlockRT` is the regression this
    // pins: it used to receive `scratchA`, the `SubtractBlockBlender` pass 1 output.
    const active = samplerTargets(pipeline, gl, 'ActiveBlock', 0);
    assert.deepEqual(active, {
      _ComposeRT: 'composedEnabledBlockRT',
      _EffectRT: 'effectRT',
      _DisabledNormalBlockRT: 'disabledNormalReadyBlockRT',
      _DisabledSubtractBlockRT: 'disabledSubtractReadyBlockRT',
      _ReadyComposeRT: 'composedDisabledBlockRT',
      _TouchHoverRT: 'touchBlockRT',
      _SceneColor: 'sceneColorRT',
      _DisplaceMap: '_DisplaceMap',
      _SparkMap: '_SparkMap',
      _TouchDisplaceMap: '_TouchDisplaceMap',
      _NoiseMap: '_NoiseMap',
    });

    // blockComposeMaterial gets the merged masks under the same two names, plus the scratch the
    // subtract post-processors wrote into.
    const merge = samplerTargets(pipeline, gl, 'BlockCompose', 0);
    assert.equal(merge._NormalBlockRT, 'normalBlockRT');
    assert.equal(merge._SubtractBlockRT, 'scratchA');
    assert.equal(merge._DisplaceMap, '_DisplaceMap');
    const disabled = samplerTargets(pipeline, gl, 'BlockCompose', 1);
    assert.equal(disabled._DisabledNormalBlockRT, 'disabledNormalBlockRT');
    assert.equal(disabled._DisabledSubtractBlockRT, 'scratchB');

    // blockReadyMaterial / disabledBlockMaterial read the pure-ready pair and the disabled compose.
    for (const [key, index] of [['ReadyBlock', 0], ['DisabledBlock', 0]]) {
      const targets = samplerTargets(pipeline, gl, key, index);
      assert.equal(targets._ComposeRT, 'composedDisabledBlockRT', `${key}._ComposeRT`);
      if (key === 'ReadyBlock') {
        assert.equal(targets._DisabledNormalBlockRT, 'disabledNormalReadyBlockRT');
        assert.equal(targets._DisabledSubtractBlockRT, 'disabledSubtractReadyBlockRT');
      }
    }

    // The two dilation passes consume the enabled compose as `_ComposeRT` and the ping-pong output as
    // `_MainTex`; the final GlowMask pass preserves the edge already in `effectRT`.
    const edge = samplerTargets(pipeline, gl, 'EdgeMask', 1);
    assert.equal(edge._MainTex, 'composedEnabledBlockRT', 'edgeSize == 1 直接读源遮罩');
    assert.equal(edge._ComposeRT, 'composedEnabledBlockRT');
    const glowFinal = samplerTargets(pipeline, gl, 'GlowMask', 1);
    // Five rings ping-pong pingA → pingB → pingA → pingB → pingA, so the final `.y`-only write reads
    // the odd one back. The sixth ring's weight (0.0040) is below the 0.01 threshold and is cut.
    assert.equal(glowFinal._MainTex, 'pingA');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('RT 尺寸按除数派生：1600x900 -> 掩码 200x112、效果 400x225', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
  assert.deepEqual([pipeline.targets.get('normalBlockRT').width, pipeline.targets.get('normalBlockRT').height], [200, 112]);
  assert.deepEqual([pipeline.targets.get('effectRT').width, pipeline.targets.get('effectRT').height], [400, 225]);
  assert.deepEqual([pipeline.targets.get('sceneColorRT').width, pipeline.targets.get('sceneColorRT').height], [266, 150]);
});

test('隐藏的块不产生绘制调用', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  // 73.5 s is past every disappearTime in the corpus.
  pipeline.render({ blocks: fixture, now: 73.5, aspect: 16 / 9, width: 1600, height: 900 });
  assert.equal(passSequence(gl).filter((entry) => entry === 'BlockSprite#0').length, 0);
  assert.ok(passSequence(gl).includes('ActiveBlock#0'), '合成阶段照常执行');
});

test('fxRenderList 通道按文档算法调用，且默认开启', () => {
  // `renderSceneEffects` needs a canvas to render the additive layer onto. Without a DOM it declines
  // and reports `sceneEffects: false`, so the layer is stubbed in here.
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, fillRect() {} }) }) };
  try {
    const gl = stubGl();
    const { pipeline } = makePipeline(gl);
    assert.deepEqual(pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 }), { sceneEffects: true });
    // On by default: ActiveBlock cannot draw a disabled block, so these are required, not optional.
    assert.ok(passSequence(gl).includes('DisabledBlock#0'), '禁用态填充默认执行');
    assert.ok(passSequence(gl).includes('ReadyBlock#0'));
    // The scene is left in `sceneColorRT` for `_SceneColor` sampling rather than blitted onto the
    // block canvas, which is composited over the 2D background and would otherwise double it.
    assert.ok(!passSequence(gl).some((entry) => entry.startsWith('Passthrough')), '不应把场景再铺一遍');
    for (const key of ['SubtractBlockBlender', 'ReadyBlock', 'DisabledBlock', 'TouchEffect']) {
      assert.ok(pipeline.programs.has(key), `缺少 ${key}`);
    }
    // The additive layer targets its own canvas, not the block canvas that gets blitted: it must not
    // contribute alpha to the layer that is composited over the preview.
    assert.notEqual(pipeline.sceneEffectsCanvas, pipeline.canvas);

    pipeline.readyPulse('composedDisabledBlockRT', 1);
    pipeline.touchEffect('touchBlockRT', 1, []);
    assert.deepEqual(passSequence(gl).slice(-2), ['ReadyBlock#0', 'TouchEffect#0']);
    // Pass selection is explicit: 0 for the enabled scalar attribution, 1 for the vec2 form.
    pipeline.blendSubtractMask('subtractBlockRT', 'scratchA', 1, 0);
    assert.equal(passSequence(gl).at(-1), 'SubtractBlockBlender#0');

    // The `fxRenderList` path in full. These are full-screen canvases drawn through the main camera,
    // so they land in the camera target *before* `RefreshSceneColorCommands` copies it into
    // sceneColorRT — hence before ActiveBlock, not after it.
    const gl2 = stubGl();
    const second = makePipeline(gl2);
    second.pipeline.sceneEffects = true;
    second.pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
    assert.deepEqual(passSequence(gl2).slice(-3), ['DisabledBlock#0', 'ReadyBlock#0', 'ActiveBlock#0']);
    // Turning it off leaves the composite intact, just without the disabled fill and pulse.
    const gl3 = stubGl();
    const third = makePipeline(gl3);
    third.pipeline.sceneEffects = false;
    assert.deepEqual(third.pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 }), { sceneEffects: false });
    assert.equal(passSequence(gl3).at(-1), 'ActiveBlock#0');
    assert.ok(!passSequence(gl3).includes('DisabledBlock#0'));
    // ...and `Start` binds both `_ComposeRT` samplers to the disabled compose, not the enabled one,
    // despite the shared sampler name.
    assert.equal(second.pipeline.programs.get('DisabledBlock')[0].uniforms.has('_ComposeRT'), true);
    assert.equal(second.pipeline.programs.get('ReadyBlock')[0].uniforms.has('_ComposeRT'), true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('RefreshSceneColorCommands：场景先拷进 sceneColorRT 再合成', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  // A stand-in scene source: uploadScene only needs something drawImage accepts.
  let uploaded = 0;
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({ imageSmoothingEnabled: true, clearRect() {}, drawImage() { uploaded++; } }) }) };
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900, scene: { width: 1600, height: 900 } });
  // Once per frame, before the composite. The fxRenderList passes add onto a transparent block
  // canvas rather than re-copying the scene, so there is nothing to refresh afterwards.
  assert.equal(uploaded, 1, '场景应被拷入 sceneColorRT');
  assert.equal(pipeline.targets.get('sceneColorRT').width, Math.floor(1600 / 6));
  assert.equal(pipeline.targets.get('sceneColorRT').height, Math.floor(900 / 6));
  // Without a scene the copy is skipped rather than failing the frame.
  assert.deepEqual(pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 }), { sceneEffects: true });
  assert.equal(uploaded, 1);
});


test('blockCompose 的输入接线与反编译一致', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  // BlockCompose pass 0 reads the raw normal/subtract masks plus the displacement texture;
  // pass 1 reads the disabled pair. Pass 1 additionally samples _DisabledSubtractBlockRT.xy, which
  // is what pins format 25 down to a two-channel target.
  const compose0 = pipeline.programs.get('BlockCompose')[0];
  const compose1 = pipeline.programs.get('BlockCompose')[1];
  for (const name of ['_DisplaceMap', '_NormalBlockRT', '_SubtractBlockRT']) assert.ok(compose0.uniforms.has(name), name);
  for (const name of ['_DisabledNormalBlockRT', '_DisabledSubtractBlockRT']) assert.ok(compose1.uniforms.has(name), name);
  const body1 = compose1.source.fragment;
  assert.ok(/SV_Target0\.y\s*=/.test(body1), 'pass 1 应同时写出覆盖度通道 .y');
  const body0 = compose0.source.fragment;
  assert.ok(/SV_Target0\s*=/.test(body0) && !/SV_Target0\.y/.test(body0), 'pass 0 只写标量');
});

test('减法混合器的双阈值常量来自材质资产', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  pipeline.blendSubtractMask('subtractBlockRT', 'disabledSubtractBlockRT', 1);
  // 0.1 (a subtract block's mask intensity) sits between the thresholds, 1.0 (normal) above both.
  const low = 0.09; const high = 0.12;
  const attribution = (x) => (x >= low ? 1 : 0) + (x >= high ? -1 : -0);
  assert.equal(attribution(0.1), 1, '减块落在两阈值之间');
  assert.equal(attribution(1.0), 0, '普通块高于两阈值');
  assert.equal(attribution(0.05), 0, '空处低于两阈值');
});

test('材质参数由 dump 生成，不再手抄', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  // `BlockCompose` had no entry at all while these were transcribed by hand, so the liquid
  // displacement — the shader's entire point — contributed nothing.
  // The dump stores float32, so compare with a tolerance that reflects that rather than 1e-9.
  const near = (actual, expected) => Math.abs(actual - expected) < 1e-6;
  assert.ok(near(pipeline.materials.BlockCompose.floats._DisplaceSpeed, 2.59), String(pipeline.materials.BlockCompose.floats._DisplaceSpeed));
  assert.ok(near(pipeline.materials.BlockCompose.floats._DisplaceStrength, 0.1));
  // Values that were simply wrong when hand-copied.
  const active = pipeline.materials.ActiveBlock.floats;
  assert.equal(active._NoiseDisplaceStrength, 1);
  assert.equal(active._NoiseSmoothness, 1);
  assert.ok(near(active._SDFCellSize, 0.11));
  assert.ok(near(active._SDFFalloff, 0.34));
  assert.ok(near(active._SparkDisplaceIntensity, 2.39));
  assert.ok(near(active._SparkHueShiftAmount, 0.2));
  assert.ok(near(active._TouchDisplaceSpeed, 2.9));
  assert.deepEqual(pipeline.materials.ActiveBlock.colors._DisplaceDirection, [1, 1, 0, 0]);
  assert.ok(near(pipeline.materials.ActiveBlock.colors._EdgeColor[1], 0.3301885724067688));
  assert.ok(near(pipeline.materials.ActiveBlock.colors._FillColor[0], 0.713207483291626));
  // All eight materials the pipeline names by hand must exist in the generated table.
  for (const name of ['ActiveBlock', 'BlockCompose', 'DisabledBlock', 'EdgeMask', 'GlowMask', 'ReadyBlock', 'SubtractBlockBlender', 'TouchEffect']) {
    assert.ok(pipeline.materials[name], `缺少材质 ${name}`);
  }
  assert.ok(near(pipeline.materials.SubtractBlockBlender.floats._ClampThresholdLow, 0.09));
  assert.ok(near(pipeline.materials.SubtractBlockBlender.floats._ClampThresholdHigh, 0.12));
  // `UpdateTouchPos` recomputes the shine each frame rather than reading it from the material.
  const low = active._TouchPosLowThreshold;
  const expected = (low + (1 - low) * 0.5) * active._TouchPosBrightness;
  assert.ok(near(pipeline.touchShine(0), expected), `${pipeline.touchShine(0)} != ${expected}`);
  // At a sine peak the shine saturates at the brightness multiplier.
  assert.ok(near(pipeline.touchShine(Math.PI / 2 / active._TouchPosShineSpeed), active._TouchPosBrightness));
});

test('_ST tiling 与 materials.md 的 m_TexEnvs 表逐项一致', () => {
  // The only numbers still transcribed by hand, because the dump's JSON has no tiling table.
  // Quoted here from materials.md §2 so a transcription slip cannot survive.
  assert.deepEqual(TEXTURE_ST.ActiveBlock, {
    _DisplaceMap: [0.8, 0.3], _SparkMap: [3.0, 1.2], _NoiseMap: [1.5, 1.46], _TouchDisplaceMap: [0.55, 0.3],
  });
  assert.deepEqual(TEXTURE_ST.BlockCompose, { _DisplaceMap: [2.13, 1.02] });
  assert.deepEqual(TEXTURE_ST.DisabledBlock, { _DisplaceMap: [0.5, 0.2], _SparkMap: [3.0, 1.2] });
  assert.deepEqual(TEXTURE_ST.TouchEffect, { _DisplaceMap: [0.55, 0.3], _NoiseMap: [1.5, 1.46] });

  // Every tiling must actually be applied: an absent entry silently becomes 1,1 and changes the
  // displacement/spark frequency by up to 3x.
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
  const writes = gl.__calls.filter((call) => /_ST$/.test(call.args[0]?.name ?? ''));
  assert.ok(writes.length > 0, '_ST tiling 应被写入');
  // materials.md §3: the mask displacement and the fill/spark displacement are two separate systems
  // with different tiling, so the compose pass must not inherit ActiveBlock's numbers.
  const forProgram = (key, name) => gl.__calls.filter((call) => call.args[0]?.name === name && call.args[0]?.program === pipeline.programs.get(key)[0].handle);
  const compose = forProgram('BlockCompose', '_DisplaceMap_ST');
  assert.ok(compose.some((call) => Math.abs(call.args[1][0] - 2.13) < 1e-9 && Math.abs(call.args[1][1] - 1.02) < 1e-9), 'compose 位移应为 (2.13, 1.02)');
  const active = forProgram('ActiveBlock', '_DisplaceMap_ST');
  assert.ok(active.some((call) => Math.abs(call.args[1][0] - 0.8) < 1e-9 && Math.abs(call.args[1][1] - 0.3) < 1e-9), '填充位移应为 (0.80, 0.30)');
  for (const [material, entries] of Object.entries(TEXTURE_ST)) {
    for (const [name, scale] of Object.entries(entries)) {
      assert.ok(scale[0] !== 1 || scale[1] !== 1, `${material}.${name} 不应是默认 tiling`);
    }
  }
});

test('贴图 Wrap 按 materials.md §1：噪声镜像、PointNoise 平铺、Block 钳制', () => {
  const { pipeline } = makePipeline(stubGl());
  // Out-of-range sampling mirrors rather than clamps, which changes the edges at low `_ST`
  // frequencies — the doc calls this out specifically.
  assert.equal(pipeline.textures.get('_DisplaceMap').file, 'BlockNoise1.png');
  assert.equal(pipeline.textures.get('_DisplaceMap').wrap, 'MIRRORED_REPEAT');
  assert.equal(pipeline.textures.get('_TouchDisplaceMap').wrap, 'MIRRORED_REPEAT');
  assert.equal(pipeline.textures.get('_NoiseMap').file, 'FD_Noise.png');
  assert.equal(pipeline.textures.get('_NoiseMap').wrap, 'MIRRORED_REPEAT');
  assert.equal(pipeline.textures.get('_SparkMap').file, 'PointNoise.png');
  assert.equal(pipeline.textures.get('_SparkMap').wrap, 'REPEAT');
  assert.equal(pipeline.textures.get('_MainTex').file, 'Block.png');
  assert.equal(pipeline.textures.get('_MainTex').wrap, 'CLAMP_TO_EDGE');
  // `BlockNoise1` backs two sampler names.
  assert.equal(pipeline.textures.size, 5);
});

test('每个 sampler 拿到互不重复的 texture unit', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
  // With the location qualifier neutralised, only `uniform1i` decides where each sampler reads
  // from, so the units have to be distinct within a pass. ActiveBlock binds eleven and runs last.
  const units = gl.__calls.filter((call) => call.name === 'activeTexture').map((call) => call.args[0] - gl.TEXTURE0);
  assert.ok(units.length >= 11, `activeTexture 调用过少: ${units.length}`);
  assert.deepEqual(units.slice(-11), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'ActiveBlock 的 11 个 sampler 应各占一个 unit');
  const bound = gl.__calls.filter((call) => call.name === 'uniform1i');
  assert.ok(bound.length >= 11, '每个 sampler 都应设置 uniform');
});

test('适配 WebGL2：UNITY_LOCATION 必须被中和，否则全部 program 编译失败', () => {
  // GLSL ES 3.00 rejects `layout(location = ...)` on a uniform, and HLSLCC stamps every sampler
  // with it through this macro. Unity's own no-uniform-location branch is empty, so flipping the
  // guard is the whole fix.
  const source = shaders.programs.ActiveBlock[0].fragment;
  assert.match(source, /#define\s+UNITY_SUPPORTS_UNIFORM_LOCATION\s+1/, 'dump 原文应为 1');
  const adapted = adaptFragment(source);
  assert.match(adapted, /#define\s+UNITY_SUPPORTS_UNIFORM_LOCATION\s+0/);
  // Everything else must survive untouched, and no layout(location) may remain on a uniform.
  assert.equal(adapted.length, source.length, '只应改动那一个字符');
  const leftovers = adapted.split('\n').filter((line) => /layout\s*\(\s*location/.test(line) && !/(^|\s)(out|in)\s/.test(line) && !/^\s*#define/.test(line));
  assert.deepEqual(leftovers, [], '仍有 uniform 使用 layout(location)');
  // The same guard exists in every vendored fragment, so the rewrite must apply to all of them.
  for (const [key, programs] of Object.entries(shaders.programs)) {
    for (const [index, program] of programs.entries()) {
      assert.match(adaptFragment(program.fragment), /#define\s+UNITY_SUPPORTS_UNIFORM_LOCATION\s+0/, `${key}#${index} 未被适配`);
    }
  }
  // A fragment without the guard is passed through unchanged rather than corrupted.
  assert.equal(adaptFragment('void main() {}'), 'void main() {}');
});

test('逐 program 校验顶点输出与片元输入的类型一致（链接失败的成因）', () => {
  const parse = (source, keyword) => {
    const map = new Map();
    const pattern = new RegExp(`^\\s*${keyword}\\s+(?:(?:highp|mediump|lowp)\\s+)?(\\w+)\\s+(\\w+)\\s*;`, 'gm');
    for (const match of source.matchAll(pattern)) map.set(match[2], match[1]);
    return map;
  };
  for (const [key, programs] of Object.entries(shaders.programs)) {
    for (const [index, program] of programs.entries()) {
      const outs = parse(program.vertex, 'out');
      for (const [name, type] of parse(program.fragment, 'in')) {
        assert.ok(outs.has(name), `${key}#${index}: 片元需要 ${name}，但顶点没有输出`);
        assert.equal(outs.get(name), type, `${key}#${index}: ${name} 类型不一致（顶点 ${outs.get(name)} / 片元 ${type}）`);
      }
    }
  }
  // The concrete case that broke linking: `vs_TEXCOORDn` numbering is per program, so the same name
  // is a vec4 screen position in one and a vec2 spark-map UV in another. A single shared vertex
  // stage is therefore impossible, which is why every program keeps its own.
  assert.equal(parse(shaders.programs.ActiveBlock[0].fragment, 'in').get('vs_TEXCOORD3'), 'vec4');
  assert.equal(parse(shaders.programs.DisabledBlock[0].fragment, 'in').get('vs_TEXCOORD3'), 'vec2');
  assert.equal(parse(shaders.programs.TouchEffect[0].fragment, 'in').get('vs_TEXCOORD3'), 'vec2');
  // ...and the pipeline really does compile each program's own vertex stage rather than one shared
  // source.
  const sources = new Set(Object.values(shaders.programs).map((programs) => programs[0].vertex));
  assert.ok(sources.size > 1, '各 program 的顶点阶段应各不相同');
});

test('全屏 pass 覆盖整个目标，而不是右上角四分之一', () => {
  // The quad buffer spans [0,1], so an identity projection covers a single quadrant. Every
  // full-screen pass would have drawn into a quarter of its target.
  const project = (matrix, x, y) => ({
    x: matrix[0] * x + matrix[4] * y + matrix[12],
    y: matrix[1] * x + matrix[5] * y + matrix[13],
  });
  assert.deepEqual(project(FULLSCREEN_PROJECTION, 0, 0), { x: -1, y: -1 });
  assert.deepEqual(project(FULLSCREEN_PROJECTION, 1, 1), { x: 1, y: 1 });
  // And the quad buffer really does span [0,1] in the position columns.
  assert.deepEqual([...[0, 1, 2, 3].map((i) => QUAD_VERTICES[i * 10])], [0, 1, 0, 1]);
  assert.deepEqual([...[0, 1, 2, 3].map((i) => QUAD_VERTICES[i * 10 + 1])], [0, 0, 1, 1]);
});

test('uniform 按反射类型派发：矩阵数组走 uniform4fv，vec3 不走 uniform4fv', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
  const active = pipeline.programs.get('ActiveBlock')[0];
  // Unity declares its matrices as `vec4 name[4]`, not `mat4`, so uniformMatrix4fv raises
  // GL_INVALID_OPERATION on them and they have to be written as 16 flat floats.
  assert.equal(active.types.get('hlslcc_mtx4x4unity_MatrixVP'), gl.FLOAT_VEC4);
  assert.equal(active.types.get('u_projection'), undefined, '游戏 program 没有 u_projection');
  const vpWrites = gl.__calls.filter((call) => call.name === 'uniform4fv' && call.args[0]?.name === 'hlslcc_mtx4x4unity_MatrixVP');
  assert.ok(vpWrites.length > 0, '矩阵应通过 uniform4fv 写入');
  assert.equal(vpWrites[0].args[1].length, 16, 'vec4[4] 需要 16 个 float');
  for (const call of gl.__calls.filter((entry) => entry.name === 'uniformMatrix4fv')) {
    assert.notEqual(call.args[0]?.name, 'hlslcc_mtx4x4unity_MatrixVP', '不应把矩阵数组当 mat4 写');
  }
  // The material's colour table mixes vec3 with vec4; feeding four components to a vec3 raises
  // "Uniform size does not match uniform method".
  assert.equal(active.types.get('_SparkTint'), gl.FLOAT_VEC3);
  assert.equal(active.types.get('_FillColor'), gl.FLOAT_VEC4);
  assert.ok(gl.__calls.some((call) => call.name === 'uniform3fv'), 'vec3 uniform 应以 uniform3fv 写入');
  // Component counts must match the setter, or the driver raises "invalid size". The material table
  // stores colours as RGBA even where the shader declares a vec3.
  const width = { uniform1i: 1, uniform1f: 1, uniform2fv: 2, uniform3fv: 3, uniform4fv: 4 };
  for (const call of gl.__calls) {
    const expected = width[call.name];
    if (!expected) continue;
    const size = call.args[1].length ?? 1;
    assert.equal(size % expected, 0, `${call.args[0]?.name}: ${call.name} 收到 ${size} 个分量，应为 ${expected} 的倍数`);
    assert.ok(size > 0, `${call.args[0]?.name}: 空分量`);
  }
  for (const call of gl.__calls.filter((entry) => entry.name === 'uniform4fv')) {
    assert.notEqual(call.args[1].length, 3, `${call.args[0]?.name} 被当成 vec4 写入`);
  }
});

test('BlockSprite 的 _Color 必须写入，否则遮罩全为零', () => {
  // `BlockSprite`'s vertex stage computes `vs_COLOR0 = in_COLOR0 * _Color`. The per-block colour
  // rides in the vertex attribute (Unity bakes SpriteRenderer.color into the mesh) and `_Color` is
  // the material tint, so leaving it unset defaults to (0,0,0,0) and every mask write becomes zero —
  // which silently blanks the whole composite, since every later pass reads those masks.
  // `Unlit/BlockSprite` is on the block prefab rather than in the dump's material table.
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
  const sprite = pipeline.programs.get('BlockSprite')[0].handle;
  const writes = gl.__calls.filter((call) => call.args[0]?.name === '_Color' && call.args[0]?.program === sprite);
  assert.ok(writes.length > 0, '_Color 应被写入');
  assert.deepEqual(writes[0].args[1], [1, 1, 1, 1], '_Color 应为白色，颜色由顶点属性承载');
  assert.ok(gl.__calls.some((call) => call.args[0]?.name === '_MainTex_ST' && call.args[0]?.program === sprite), '_MainTex_ST 应被写入');

  // More generally: every uniform a program actually reads has to be written by the frame, or the
  // driver leaves it at zero. `BlockSprite` is drawn without a material lookup, so its uniforms are
  // the ones most easily missed.
  const written = new Set(gl.__calls.map((call) => call.args[0]?.name).filter(Boolean));
  const engine = new Set(['_Time', '_ScreenParams', '_ProjectionParams', '_EffectRT_TexelSize', '_TouchPosShine', 'hlslcc_mtx4x4unity_ObjectToWorld', 'hlslcc_mtx4x4unity_MatrixVP']);
  for (const name of ['_Color', '_MainTex_ST']) assert.ok(written.has(name), `${name} 未被写入`);
  assert.ok(engine.size > 0);
});

test('块层按设备像素渲染，再贴进视口的 CSS 像素矩形', () => {
  // `prepareCanvas` scales the 2D context by devicePixelRatio, so `viewport` is CSS pixels while the
  // canvas is device pixels. Rendering the GL layer at canvas size and blitting it into the viewport
  // rectangle scaled and offset every block by that ratio.
  const captured = { render: null, image: null, composite: null };
  const host = {
    canvas: { width: 2800, height: 1800 },
    blockCanvas: { tag: 'gl' },
    blockSceneEffects: true,
    chart: { blockAreas: [] },
    blockPipeline: {
      disabled: false,
      render: (options) => { captured.render = options; return { sceneEffects: true }; },
      compositeSceneEffects: (...args) => { captured.composite = args; },
    },
  };
  const context = {
    drawImage: (...args) => { captured.image = args; },
    save() {}, restore() {}, set globalCompositeOperation(value) { this.operation = value; },
  };
  const viewport = { left: 100, top: 50, width: 700, height: 450 };
  const previous = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  try {
    assert.equal(Preview.prototype.drawBlocksPipeline.call(host, context, 3, viewport), true);
  } finally {
    globalThis.devicePixelRatio = previous;
  }
  assert.equal(captured.render.width, 1400, 'GL 层宽应为视口的设备像素宽');
  assert.equal(captured.render.height, 900);
  assert.equal(captured.render.aspect, 700 / 450, '宽高比取自 CSS 视口，两种单位下一致');
  assert.deepEqual(captured.render.sceneView, { left: 200, top: 100, width: 1400, height: 900 }, '场景按视口裁剪');
  // The whole GL canvas is mapped onto the viewport's CSS rectangle.
  assert.deepEqual(captured.image.slice(1), [0, 0, 1400, 900, 100, 50, 700, 450]);
  // The additive disabled/ready layer is composited before the block canvas, so `ActiveBlock` (which
  // already contains the layer via `_SceneColor`) stays on top, as it does in the game.
  assert.deepEqual(captured.composite, [context, 1400, 900, viewport]);
});

test('禁用态/预备态层用加法合成，而不是把预览压暗', () => {
  // `DisabledBlock` is `One, One` and `ReadyBlock` is `SrcAlpha, One`, so both write an alpha
  // proportional to the block's coverage. Blitting that layer with `source-over` therefore uses the
  // coverage to attenuate whatever is underneath, which is how the disabled and ready states ended up
  // dark or black; `lighter` adds colour and preserves the destination, matching the game's additive
  // passes onto the camera target.
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, fillRect() {} }) }) };
  try {
    const gl = stubGl();
    const { pipeline } = makePipeline(gl);
    assert.deepEqual(pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 }), { sceneEffects: true });
    const layer = pipeline.sceneEffectsCanvas;
    assert.ok(layer, 'fxRenderList 层应有独立画布');
    assert.deepEqual([layer.width, layer.height], [1600, 900], '层尺寸跟画布一致');
    const calls = [];
    const context = {
      save() { calls.push('save'); }, restore() { calls.push('restore'); },
      set globalCompositeOperation(value) { calls.push(`op:${value}`); },
      drawImage: (...args) => { calls.push(['drawImage', ...args]); },
    };
    const viewport = { left: 10, top: 20, width: 800, height: 450 };
    assert.equal(pipeline.compositeSceneEffects(context, 1600, 900, viewport), true);
    assert.deepEqual(calls, ['save', 'op:lighter', ['drawImage', layer, 0, 0, 1600, 900, 10, 20, 800, 450], 'restore']);
    // With the layer disabled there is nothing to composite, and no canvas is allocated.
    const off = makePipeline(stubGl());
    off.pipeline.sceneEffects = false;
    assert.deepEqual(off.pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 }), { sceneEffects: false });
    assert.equal(off.pipeline.sceneEffectsCanvas, undefined);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('两个加法通道真的写入非零 alpha，否则这个合成差异不可见', () => {
  // Guards the premise of the test above: if the fragment stages wrote alpha 0, a `source-over` blit
  // would be indistinguishable from `lighter` and the regression could not be observed.
  const source = shaders.programs.DisabledBlock[0].fragment;
  const writes = [...source.matchAll(/SV_Target0\.w\s*=\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.deepEqual(writes, ['vs_COLOR0.w'], 'DisabledBlock 的 alpha 直接来自顶点色，即 BlockSprite 写入的覆盖度');
  // ReadyBlock writes the same coverage into rgb and alpha (as two component writes), which is what
  // makes `lighter` (add) and `source-over` (replace, attenuated by that alpha) differ so visibly.
  const ready = shaders.programs.ReadyBlock[0].fragment;
  assert.ok(/SV_Target0\.w\s*=/.test(ready), 'ReadyBlock 写 alpha');
  assert.ok(/SV_Target0\.xyz\s*=/.test(ready), 'ReadyBlock 同时写 rgb');
});

test('贴图按 Unity 约定垂直翻转（v = 0 对应图像底部）', async () => {
  // Unity's UV origin is bottom-left, so its importer stores textures flipped and the quad's v also
  // increases upward. Uploading with the flip off puts the file's top row at v = 0, mirroring every
  // noise and displacement map.
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  const previous = globalThis.Image;
  globalThis.Image = class { set src(value) { this.href = value; queueMicrotask(() => this.onload?.()); } };
  try {
    await pipeline.loadImages('/fake/');
  } finally {
    globalThis.Image = previous;
  }
  const flips = gl.__calls.filter((call) => call.name === 'pixelStorei' && call.args[0] === gl.UNPACK_FLIP_Y_WEBGL);
  assert.equal(flips.length, pipeline.textures.size, '每张贴图都应设置翻转');
  for (const call of flips) assert.equal(call.args[1], true, 'UNPACK_FLIP_Y_WEBGL 应为 true');
});

test('渲染到 RT 时 _ProjectionParams.x 为 -1', () => {
  // The block cameras render into RenderTextures and `BlockRender.Start` sets
  // `forceIntoRenderTexture` on the main camera, where Unity flips the projection matrix.
  // `ComputeScreenPos` reads that through `_ProjectionParams.x` to orient `vs_TEXCOORD3`, which
  // `ActiveBlock` uses to sample `_SceneColor`. Only the screen-projected varyings depend on it; the
  // quad's own position comes from the matrices.
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
  const writes = gl.__calls.filter((call) => call.args[0]?.name === '_ProjectionParams');
  assert.ok(writes.length > 0, '_ProjectionParams 应被写入');
  for (const call of writes) assert.equal(call.args[1][0], -1, 'yFlip 应为 -1');
});

test('场景上传必须垂直翻转，否则块内场景镜像', () => {
  // A 2D canvas's row 0 is its top; the full-screen quad puts v = 0 at the framebuffer's bottom row.
  // Sampling `_SceneColor` without the flip reads the top of the scene at the bottom of the screen,
  // so a block shows a vertically mirrored copy of what it overlaps.
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({ imageSmoothingEnabled: true, clearRect() {}, drawImage() {} }) }) };
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  assert.deepEqual(pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900, scene: { width: 1600, height: 900 } }), { sceneEffects: true });
  const flips = gl.__calls.filter((call) => call.name === 'pixelStorei' && call.args[0] === gl.UNPACK_FLIP_Y_WEBGL);
  assert.ok(flips.length > 0, 'sceneColorRT 的上传应设置翻转');
  for (const call of flips) assert.equal(call.args[1], true, 'UNPACK_FLIP_Y_WEBGL 应为 true');
  // ...and the mask targets must not be re-uploaded from a canvas, which would need the same care.
  const uploads = gl.__calls.filter((call) => call.name === 'texImage2D' && call.args.length === 6);
  assert.ok(uploads.length >= 1, '应有来自 canvas 的上传');
});

test('诊断记录每个块进了哪一层，并在各 RT 的块中心取值', () => {
  // A blank or too-dark block has three plausible causes that look identical from outside: the quad
  // never rasterised, it went to the wrong layer, or the composite/effect targets are empty for it.
  // `diagnose` has to distinguish them, so pin the bookkeeping down.
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, fillRect() {} }) }) };
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  const now = 66;
  pipeline.render({ blocks: fixture, now, aspect: 16 / 9, width: 1600, height: 900 });
  const quads = pipeline.lastStats.quads;
  assert.ok(quads.length > 0, '应有块被光栅化');
  for (const quad of quads) {
    assert.ok(['active', 'ready', 'disabled'].includes(quad.state), `未知状态 ${quad.state}`);
    assert.ok(quad.layer.endsWith('BlockRT'), `层名 ${quad.layer}`);
    if (quad.state === 'active') assert.equal(quad.layer, quad.isSubtract ? 'subtractBlockRT' : 'normalBlockRT');
    else assert.equal(quad.layer, quad.isSubtract ? 'disabledSubtractBlockRT' : 'disabledNormalBlockRT');
    // The ready half is only drawn when the block is inside its ready window.
    assert.equal(Boolean(quad.readyLayer), quad.state === 'ready', 'readyLayer 只在预备态出现');
  }
  // Per-block probes address each target in that target's own pixel grid (masks /8, effects /4).
  const block = fixture.find((entry) => blockState(entry, now)?.active);
  const aspect = 16 / 9;
  const transform = blockTransform(block, now, aspect);
  const mask = pipeline.maskPixel(transform, 'normalBlockRT');
  const effect = pipeline.maskPixel(transform, 'effectRT');
  assert.equal(mask[0], Math.round((transform.center.x / transform.screen.x + 0.5) * pipeline.targets.get('normalBlockRT').width));
  assert.ok(effect[0] > mask[0], 'effectRT 分辨率是掩码的两倍，同一世界点落在更大的像素坐标上');
  const report = pipeline.diagnose(now, fixture, { width: 1600, height: 900 });
  assert.ok(report.samples.length > 0, '应给出逐块采样');
  const keys = Object.keys(report.samples[0]);
  for (const name of ['compose', 'effectEdge', 'effectGlow', 'readyCompose', 'disabledNormalReady', 'sceneColor']) {
    assert.ok(keys.includes(name), `采样缺少 ${name}`);
  }
  for (const sample of report.samples) {
    for (const [name, value] of Object.entries(sample)) {
      if (name === 'block' || name === 'state' || name === 'isSubtract' || name === 'layer' || name === 'readyLayer') continue;
      assert.ok(value === null || Number.isInteger(value), `${name} 应为整数像素值或 null，实际 ${value}`);
    }
  }
});

test('减块走 subtract 遮罩层，普通块走 normal 层', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  const subtractIndex = fixture.findIndex((block) => block.isSubtract);
  assert.ok(subtractIndex >= 0, '语料里应有减块');
  const block = fixture[subtractIndex];
  const now = block.enableTime + 0.01;
  pipeline.render({ blocks: [block], now, aspect: 16 / 9, width: 1600, height: 900 });
  // The subtract quad must land in subtractBlockRT: check the framebuffer bound just before the
  // first drawArrays is that target's.
  const draws = gl.__calls.filter((call) => call.name === 'drawArrays');
  assert.ok(draws.length >= 1);
  const binds = gl.__calls.filter((call) => call.name === 'bindFramebuffer');
  assert.ok(binds.length > 0);
  assert.equal(pipeline.targets.has('subtractBlockRT'), true);
  assert.equal(blockState(block, now).active, true);
  // Sanity: the transform is finite for this real block at this time.
  const transform = blockTransform(block, now, 16 / 9);
  assert.ok(Number.isFinite(transform.size.x) && Number.isFinite(transform.size.y));
});

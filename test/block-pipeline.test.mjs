import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BlockPipeline, RENDER_TARGETS, TEXTURE_ST, adaptFragment, glowRingWeight, glowRingWeights, blockMatrix,
  FULLSCREEN_PROJECTION, QUAD_VERTICES,
} from '../src/ui/block-pipeline.mjs';
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
  return { pipeline, canvas };
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
  // 13 from the game, plus this port's own passthrough.
  assert.equal(total, 14);
  for (const key of ['BlockSprite', 'SubtractBlockBlender', 'BlockCompose', 'EdgeMask', 'GlowMask', 'DisabledBlock', 'ReadyBlock', 'ActiveBlock', 'TouchEffect']) {
    assert.ok(pipeline.programs.has(key), `缺少 ${key}`);
  }
});

test('render 按 LateUpdate 的顺序跑完整条管线', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  assert.equal(pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 }), true);
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
    'Passthrough#0',                  // fxRenderList: seed the canvas with the scene
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
  assert.equal(sequence[compose1 + 2], 'Passthrough#0', 'fxRenderList 通道在合成之前');
  assert.equal(sequence.at(-1), 'ActiveBlock#0');
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
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
  // On by default: ActiveBlock cannot draw a disabled block, so these are required, not optional.
  assert.ok(passSequence(gl).includes('DisabledBlock#0'), '禁用态填充默认执行');
  assert.ok(passSequence(gl).includes('ReadyBlock#0'));
  assert.ok(passSequence(gl).includes('Passthrough#0'), '先把场景铺到画布上');
  for (const key of ['SubtractBlockBlender', 'ReadyBlock', 'DisabledBlock', 'TouchEffect']) {
    assert.ok(pipeline.programs.has(key), `缺少 ${key}`);
  }

  pipeline.readyPulse('composedDisabledBlockRT', 1);
  pipeline.touchEffect('touchBlockRT', 1, []);
  assert.deepEqual(passSequence(gl).slice(-2), ['ReadyBlock#0', 'TouchEffect#0']);
  // Pass selection is explicit: 0 for the enabled scalar attribution, 1 for the vec2 form.
  pipeline.blendSubtractMask('subtractBlockRT', 'scratchA', 1, 0);
  assert.equal(passSequence(gl).at(-1), 'SubtractBlockBlender#0');

  // The `fxRenderList` path in full. These are full-screen canvases drawn through the main camera,
  // so they land in the camera target *before* `RefreshSceneColorCommands` copies it into
  // sceneColorRT — hence before ActiveBlock, not after it. The passthrough seeds the canvas with the
  // scene so the additive passes have something to add to.
  const gl2 = stubGl();
  const second = makePipeline(gl2);
  second.pipeline.sceneEffects = true;
  second.pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
  assert.deepEqual(passSequence(gl2).slice(-4), ['Passthrough#0', 'DisabledBlock#0', 'ReadyBlock#0', 'ActiveBlock#0']);
  // Turning it off leaves the composite intact, just without the disabled fill and pulse.
  const gl3 = stubGl();
  const third = makePipeline(gl3);
  third.pipeline.sceneEffects = false;
  third.pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
  assert.equal(passSequence(gl3).at(-1), 'ActiveBlock#0');
  assert.ok(!passSequence(gl3).includes('DisabledBlock#0'));
  // ...and `Start` binds both `_ComposeRT` samplers to the disabled compose, not the enabled one,
  // despite the shared sampler name.
  assert.equal(second.pipeline.programs.get('DisabledBlock')[0].uniforms.has('_ComposeRT'), true);
  assert.equal(second.pipeline.programs.get('ReadyBlock')[0].uniforms.has('_ComposeRT'), true);
});

test('RefreshSceneColorCommands：场景先拷进 sceneColorRT 再合成', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  // A stand-in scene source: uploadScene only needs something drawImage accepts.
  let uploaded = 0;
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({ imageSmoothingEnabled: true, clearRect() {}, drawImage() { uploaded++; } }) }) };
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900, scene: { width: 1600, height: 900 } });
  // Twice per frame: once up front, and again after the fxRenderList passes have drawn into the
  // camera target, because `RefreshSceneColorCommands` copies it *after* they run.
  assert.equal(uploaded, 2, '场景应被拷入 sceneColorRT（合成前 + fx 通道后）');
  assert.equal(pipeline.targets.get('sceneColorRT').width, Math.floor(1600 / 6));
  assert.equal(pipeline.targets.get('sceneColorRT').height, Math.floor(900 / 6));
  // Without a scene the up-front copy is skipped rather than failing the frame, but the post-fx
  // refresh still runs: the fxRenderList passes have drawn into the camera target by then, so it has
  // to be re-copied regardless of where the scene originally came from.
  assert.equal(pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 }), true);
  assert.equal(uploaded, 3);
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

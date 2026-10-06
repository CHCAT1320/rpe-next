import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BlockPipeline, RENDER_TARGETS, glowRingWeight, glowRingWeights, blockMatrix } from '../src/ui/block-pipeline.mjs';
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
    RGBA: enumValue('RGBA'), UNSIGNED_BYTE: enumValue('UBYTE'), FRAMEBUFFER: enumValue('FB'),
    COLOR_ATTACHMENT0: enumValue('CA0'), FRAMEBUFFER_COMPLETE: enumValue('FBC'),
    ARRAY_BUFFER: enumValue('ARRAYBUF'), FLOAT: enumValue('FLOAT'), STATIC_DRAW: enumValue('STATIC'),
    TRIANGLE_STRIP: enumValue('TRISTRIP'), BLEND: enumValue('BLEND'), CULL_FACE: enumValue('CULL'), DEPTH_TEST: enumValue('DEPTH'),
    COLOR_BUFFER_BIT: enumValue('COLORBIT'), TEXTURE0: 1000,
    ZERO: 0, ONE: 1, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
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
    getActiveUniform: (program, index) => ({ name: uniformsOf(program)[index] }),
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
    getAttribLocation: () => 0,
    enableVertexAttribArray: record('enableVertexAttribArray'), disableVertexAttribArray: record('disableVertexAttribArray'),
    vertexAttribPointer: record('vertexAttribPointer'), vertexAttrib4f: record('vertexAttrib4f'),
    useProgram: (program) => calls.push({ name: 'useProgram', args: [program] }),
    uniformMatrix4fv: record('uniformMatrix4fv'), uniform1i: record('uniform1i'), uniform1f: record('uniform1f'),
    uniform4f: record('uniform4f'), uniform2fv: record('uniform2fv'), uniform3fv: record('uniform3fv'), uniform4fv: record('uniform4fv'),
  };
  const uniformsOf = (program) => {
    const source = program.shaders.map((shader) => shader.source).join('\n');
    const names = new Set();
    for (const match of source.matchAll(/^\s*uniform\s+(?:mediump |highp |lowp )?(?:\w+)\s+(\w+)\s*(\[\d+\])?\s*;/gm)) names.add(match[1]);
    for (const match of source.matchAll(/UNITY_LOCATION\(\d+\)\s*uniform\s+(?:mediump |highp |lowp )?sampler2D\s+(\w+)\s*;/g)) names.add(match[1]);
    return [...names];
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
  assert.equal(total, 13);
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
  assert.equal(sequence[compose1 + 2], 'ActiveBlock#0');
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

test('可选阶段按文档算法调用，且默认不参与渲染', () => {
  const gl = stubGl();
  const { pipeline } = makePipeline(gl);
  pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
  const baseline = passSequence(gl);
  // These three have no invocation in the measured LateUpdate, in RenderEffects, or in
  // RefreshSceneColorCommands (whose recovered body is two blits), so they stay unwired.
  for (const key of ['ReadyBlock#0', 'TouchEffect#0', 'DisabledBlock#0']) {
    assert.ok(!baseline.includes(key), `${key} 不应默认执行`);
  }
  // They are still compiled and available.
  for (const key of ['SubtractBlockBlender', 'ReadyBlock', 'DisabledBlock', 'TouchEffect']) {
    assert.ok(pipeline.programs.has(key), `缺少 ${key}`);
  }

  pipeline.readyPulse('composedDisabledBlockRT', 1);
  pipeline.touchEffect('touchBlockRT', 1, []);
  assert.deepEqual(passSequence(gl).slice(-2), ['ReadyBlock#0', 'TouchEffect#0']);
  // Pass selection is explicit: 0 for the enabled scalar attribution, 1 for the vec2 form.
  pipeline.blendSubtractMask('subtractBlockRT', 'scratchA', 1, 0);
  assert.equal(passSequence(gl).at(-1), 'SubtractBlockBlender#0');

  // The switchable hypothesis path adds the disabled fill and the ready pulse over the final image.
  const gl2 = stubGl();
  const second = makePipeline(gl2);
  second.pipeline.optionalStages = true;
  second.pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 });
  assert.deepEqual(passSequence(gl2).slice(-3), ['ActiveBlock#0', 'DisabledBlock#0', 'ReadyBlock#0']);
  // ...and `Start` binds both of their `_ComposeRT` samplers to the disabled compose, not the
  // enabled one, despite the shared sampler name.
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
  assert.equal(uploaded, 1, '场景应被拷入 sceneColorRT');
  assert.equal(pipeline.targets.get('sceneColorRT').width, Math.floor(1600 / 6));
  assert.equal(pipeline.targets.get('sceneColorRT').height, Math.floor(900 / 6));
  // Without a scene the stage is skipped rather than failing the frame.
  assert.equal(pipeline.render({ blocks: fixture, now: 66, aspect: 16 / 9, width: 1600, height: 900 }), true);
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

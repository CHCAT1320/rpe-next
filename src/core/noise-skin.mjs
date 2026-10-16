export const NOISE_LAYER_VERSION = 230;
export const DEFAULT_NOISE_LAYER = 'default';
export const noiseLayers = chart => chart.noiseAreaLayers?.length ? chart.noiseAreaLayers : [{ id: DEFAULT_NOISE_LAYER, name: '默认层', skin: '', parameters: {} }];
export const noiseLayerId = area => area.layerId ?? DEFAULT_NOISE_LAYER;
export function withNoiseLayers(chart, layers, areas = chart.blockAreaList ?? []) {
  const next = { ...chart, META: { ...chart.META, RPEVersion: Math.max(chart.META.RPEVersion ?? 0, NOISE_LAYER_VERSION) }, noiseAreaLayers: layers, blockAreaList: areas };
  validateNoiseLayers(next); return next;
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
function validateSkinSettings(settings) {
  if (!object(settings)) throw new Error('噪域皮肤配置必须为对象');
  if (settings.channel !== undefined && !['normal', 'low'].includes(settings.channel)) throw new Error('噪域皮肤通道无效');
  if (settings.parameters !== undefined && (!object(settings.parameters) || Object.values(settings.parameters).some(value => !(finite(value) || Array.isArray(value) && [2, 4].includes(value.length) && value.every(finite))))) throw new Error('噪域皮肤参数无效');
  if (settings.parameters?.touchReleaseDuration < 0) throw new Error('touchReleaseDuration 不得为负数');
}
export function skinPath(path) {
  if (typeof path !== 'string' || !path || /[\\:\x00-\x1f?#]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('皮肤路径无效：' + path);
  return path;
}
export function validateNoiseLayers(chart) {
  if (chart.noiseAreaLayers === undefined) { if ((chart.blockAreaList??[]).some(area=>noiseLayerId(area)!==DEFAULT_NOISE_LAYER)) throw new Error('噪域引用了不存在的层'); return; }
  if (!Array.isArray(chart.noiseAreaLayers) || !chart.noiseAreaLayers.length) throw new Error('至少保留一个噪域层');
  const ids = new Set();
  for (const layer of chart.noiseAreaLayers) {
    if (!object(layer) || typeof layer.id !== 'string' || !layer.id || ids.has(layer.id) || typeof layer.name !== 'string') throw new Error('噪域层名称或标识无效');
    ids.add(layer.id);
    if (layer.skin) { skinPath(layer.skin); if (!/^shader\/[^/]+$/.test(layer.skin)) throw new Error('噪域皮肤必须位于 shader/皮肤名'); }
    validateSkinSettings(layer);
    if (layer.skinPresets !== undefined) {
      if (!object(layer.skinPresets)) throw new Error('噪域皮肤参数记录必须为对象');
      for (const [root, settings] of Object.entries(layer.skinPresets)) {
        skinPath(root); if (!/^shader\/[^/]+$/.test(root)) throw new Error('皮肤参数记录路径无效');
        validateSkinSettings(settings);
      }
    }
  }
  for (const area of chart.blockAreaList ?? []) if (!ids.has(noiseLayerId(area))) throw new Error('噪域引用了不存在的层');
}
export function noiseSkinModified(settings = {}, definition) {
  if (settings.channel === 'low' && (!definition || definition.low)) return true;
  return Object.entries(settings.parameters ?? {}).some(([name, value]) => {
    const parameter = definition?.parameters.find(entry => entry.name === name);
    return !parameter || JSON.stringify(value) !== JSON.stringify(parameter.value);
  });
}
export function rememberedNoiseSkinSettings(layer) {
  const presets = structuredClone(layer.skinPresets ?? {});
  if (layer.skin && (Object.keys(layer.parameters ?? {}).length || layer.channel === 'low')) presets[layer.skin] = { parameters: structuredClone(layer.parameters ?? {}), channel: layer.channel ?? 'normal' };
  return presets;
}
export function switchNoiseSkin(layer, skin, modified = false) {
  const skinPresets = rememberedNoiseSkinSettings(layer);
  const settings = modified ? skinPresets[skin] : null;
  return { ...layer, skin, parameters: structuredClone(settings?.parameters ?? {}), channel: settings?.channel ?? 'normal', skinPresets };
}
export function updateNoiseSkinSettings(layer, patch, definition) {
  const skinPresets = rememberedNoiseSkinSettings(layer); const next = { ...layer, ...patch };
  if (next.skin) {
    if (noiseSkinModified(next, definition)) skinPresets[next.skin] = { parameters: structuredClone(next.parameters ?? {}), channel: next.channel ?? 'normal' };
    else { delete skinPresets[next.skin]; next.parameters = {}; next.channel = 'normal'; }
  }
  return { ...next, skinPresets };
}
export function skinParameters(source) {
  const parameters = [];
  for (const match of source.matchAll(/uniform\s+(float|vec2|vec4)\s+(\w+)\s*;[^\r\n]*?\/\/\s*%([^%\r\n]+)%([^\r\n]*)/g)) {
    const [, type, name, raw, suffix] = match; const values = raw.split(',').map(value => Number(value.trim()));
    const count = type === 'float' ? 1 : Number(type.slice(3));
    if (values.length !== count || values.some(value => !finite(value))) throw new Error('皮肤参数默认值无效：' + name);
    const range = suffix.match(/(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)/);
    if (range && (Number(range[1]) > Number(range[2]) || values.some(value => value < Number(range[1]) || value > Number(range[2])))) throw new Error('皮肤参数范围无效：' + name);
    if (automatic(name)) throw new Error('皮肤参数名称保留：' + name);
    parameters.push({ name, type, value: count === 1 ? values[0] : values, ...(range ? { min: Number(range[1]), max: Number(range[2]) } : {}) });
  }
  const release = parameters.find(parameter => parameter.name === 'touchReleaseDuration');
  if (!release || release.type !== 'float' || release.value < 0) throw new Error('main.glsl 必须声明非负的 touchReleaseDuration 参数');
  if (new Set(parameters.map(parameter => parameter.name)).size !== parameters.length) throw new Error('皮肤参数重复');
  return parameters;
}
export function skinTextures(source, file) {
  return [...source.matchAll(/uniform\s+sampler2D\s+(\w+)\s*;\s*\/\/\s*@texture\s+(\S+)([^\r\n]*)/g)].map(([, name, path, options]) => {
    const settings = { wrap: 'clamp', filter: 'linear', colorspace: 'linear', alphaMode: 'straight' };
    for (const option of options.trim().split(/\s+/).filter(Boolean)) {
      const [key, value] = option.split('=');
      if (!({ wrap: ['clamp', 'repeat', 'mirror'], filter: ['nearest', 'linear'], colorspace: ['linear', 'srgb'], alphaMode: ['straight', 'premult'] }[key]?.includes(value))) throw new Error('纹理选项无效：' + option);
      settings[key] = value;
    }
    skinPath(path); const directory = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
    return { name, path: skinPath(directory + path), ...settings };
  });
}
export function skinSize(screenWidth, screenHeight, specification = {}, maximum = Infinity) {
  const sizes = [screenWidth, screenHeight].map((size, index) => {
    const scale = specification[index ? 'scaleY' : 'scaleX'] ?? 1;
    if (!finite(scale) || scale <= 0) throw new Error('皮肤分辨率倍率必须大于零');
    const result = Math.floor(size * scale);
    if (result < 1 || result > maximum) throw new Error('皮肤纹理尺寸超出设备范围');
    return result;
  });
  return sizes;
}
const automatic = name => ['screenTexture', 'blockMask', 'screenSize', 'targetSize', 'targetTexelSize', 'time', 'touchCount', 'touchPoints', 'screenTextureSize', 'blockMaskSize'].includes(name);
function noiseSkinConfig(files) {
  const bytes = files.get('config.json');
  const config = bytes === undefined ? { version: 1, targets: {}, passes: [{ shader: 'main.glsl', output: '$screen' }] }
    : JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));
  if (!object(config)) throw new Error('皮肤 config.json 必须为对象');
  if (config.author !== undefined && typeof config.author !== 'string') throw new Error('皮肤 author 必须为作者名文本');
  return config;
}
export function noiseSkinLabel(name, author = '') { return author.trim() ? `${name}(${author.trim()})` : name; }
export function noiseSkinAuthor(files) { return noiseSkinConfig(files).author?.trim() ?? ''; }
export function parseNoiseSkin(files) {
  for (const path of files.keys()) skinPath(path);
  const decoder = new TextDecoder();
  const text = name => { skinPath(name); const bytes = files.get(name); if (!bytes) throw new Error('皮肤缺少文件：' + name); return typeof bytes === 'string' ? bytes : decoder.decode(bytes); };
  const main = text('main.glsl'); const parameters = skinParameters(main);
  const config = noiseSkinConfig(files);
  if (config.version !== 1) throw new Error('仅支持噪域皮肤协议 version=1');
  const sources = new Map([['main.glsl', main]]); const textures = new Map();
  const channel = (value, low = false) => {
    if (!object(value) || !Array.isArray(value.passes) || !value.passes.length || (!low && !object(value.targets))) throw new Error('皮肤通道缺少 targets 或 passes');
    const targets = value.targets ?? {}; if (!object(targets)) throw new Error('皮肤 targets 必须为对象');
    for (const [name, target] of Object.entries(targets)) {
      if (!name || name === '$screen' || name.includes('.') || !object(target)) throw new Error('皮肤 Target 名称无效');
      if (!['r8', 'rg8', 'rgba8'].includes(target.format ?? 'rgba8') || !['nearest', 'linear'].includes(target.filter ?? 'nearest') || target.noClear !== undefined && typeof target.noClear !== 'boolean') throw new Error('皮肤 Target 配置无效：' + name);
      for (const key of ['scaleX', 'scaleY']) if (target[key] !== undefined && (!finite(target[key]) || target[key] <= 0)) throw new Error('Target 倍率无效');
    }
    const blockMask = value.blockMask ?? {};
    if (!object(blockMask)) throw new Error('blockMask 必须为对象');
    for (const scale of [blockMask.scaleX ?? 1, blockMask.scaleY ?? 1]) if (!finite(scale) || scale <= 0) throw new Error('blockMask 倍率无效');
    const written = new Set();
    const passes = value.passes.map(pass => {
      if (!object(pass) || typeof pass.output !== 'string') throw new Error('皮肤 Pass 无效');
      const source = text(pass.shader); if (!pass.shader.endsWith('.glsl')) throw new Error('Pass 必须引用 GLSL 文件'); sources.set(pass.shader, source);
      const images = skinTextures(source, pass.shader); textures.set(pass.shader, images);
      for (const image of images) if (!files.has(image.path)) throw new Error('皮肤缺少图片：' + image.path);
      const [output, component, extra] = pass.output.split('.'); const target = targets[output];
      if (output !== '$screen' && !Object.hasOwn(targets, output) || extra || component && (output === '$screen' || !target || !(target.format === 'r8' ? 'r' : target.format === 'rg8' ? 'rg' : 'rgba').includes(component) || component.length !== 1)) throw new Error('Pass 输出无效：' + pass.output);
      const inputs = pass.inputs ?? {}; const constants = pass.constants ?? {};
      if (!object(inputs) || !object(constants)) throw new Error('Pass inputs/constants 必须为对象');
      const uniforms = new Map([...source.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+(\w+)/g)].map(([, type, name]) => [name, type]));
      const reservedSizes = new Set([...Object.keys(inputs), ...images.map(image=>image.name)].map(name=>name+'Size'));
      for (const [name, input] of Object.entries(inputs)) {
        if (automatic(name) || uniforms.get(name) !== 'sampler2D' || images.some(image => image.name === name)) throw new Error('Pass 采样器无效：' + name);
        if (input !== '$screen' && (!Object.hasOwn(targets, input) || !targets[input].noClear && (!written.has(input) || input === output))) throw new Error('Target 在写入前读取：' + input);
      }
      for (const [name, value] of Object.entries(constants)) {
        const type = finite(value) ? 'float' : Array.isArray(value) && [2, 4].includes(value.length) && value.every(finite) ? 'vec' + value.length : null;
        if (!type || automatic(name) || reservedSizes.has(name) || name === 'touchReleaseDuration' || uniforms.get(name) !== type) throw new Error('Pass 常量无效：' + name);
      }
      for (const parameter of parameters) if (uniforms.has(parameter.name) && uniforms.get(parameter.name) !== parameter.type || automatic(parameter.name) || reservedSizes.has(parameter.name)) throw new Error('皮肤参数类型或名称冲突：' + parameter.name);
      for (const [name,type] of Object.entries({screenTexture:'sampler2D',blockMask:'sampler2D',time:'float',screenSize:'vec2',targetSize:'vec2',targetTexelSize:'vec2',screenTextureSize:'vec2',blockMaskSize:'vec2',touchCount:'int',touchPoints:'vec4',...Object.fromEntries([...reservedSizes].map(name=>[name,'vec2']))})) if (uniforms.has(name)&&uniforms.get(name)!==type) throw new Error('自动 uniform 类型错误：'+name);
      for (const [name, type] of uniforms) if (type === 'sampler2D' && !['screenTexture', 'blockMask'].includes(name) && !Object.hasOwn(inputs, name) && !images.some(image => image.name === name)) throw new Error('未绑定采样器：' + name);
      written.add(output); return { ...pass, inputs, constants, output, component };
    });
    return { targets, passes, blockMask };
  };
  return { author: config.author?.trim() ?? '', parameters, sources, textures, files, normal: channel(config), low: config.lowPerformance === undefined ? null : channel(config.lowPerformance, true) };
}
export function maskWord(normal, subtract) {
  return (normal[0] ? 1 : 0) | (subtract[0] === 1 ? 2 : 0) | (normal[1] ? 4 : 0) | (subtract[1] === 1 ? 8 : 0) | (normal[2] ? 16 : 0) | (subtract[2] === 1 ? 32 : 0);
}

import { load, dump, CORE_SCHEMA } from './vendor/js-yaml.mjs';

export const NOTE_SKIN_LIMITS = Object.freeze({ files: 256, bytes: 192 * 1024 * 1024, fileBytes: 48 * 1024 * 1024, pixels: 96 * 1024 * 1024, dimension: 16384 });
export const NOTE_SKIN_IMAGES = ['click.png', 'click_mh.png', 'drag.png', 'drag_mh.png', 'flick.png', 'flick_mh.png', 'hold.png', 'hold_mh.png', 'hit_fx.png'];
export const NOTE_SKIN_SOUNDS = Object.freeze({ tap: 'click.ogg', drag: 'drag.ogg', flick: 'flick.ogg' });
export const NOTE_SKIN_DEFAULTS = Object.freeze({ description: '', hitFxDuration: 0.5, hitFxScale: 1, hitFxRotate: false, hitFxTinted: true, hideParticles: false, holdKeepHead: false, holdRepeat: false, holdCompact: false, colorPerfect: 0xe1ffec9f, colorGood: 0xebb4e1ff });
const fail = message => { throw new Error('音符皮肤：' + message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function noteSkinInfo(source) {
  if (!plain(source)) fail('info.yml 须为属性映射');
  const info = { ...NOTE_SKIN_DEFAULTS };
  for (const key of ['name','author','hitFx','holdAtlas','holdAtlasMH',...Object.keys(NOTE_SKIN_DEFAULTS)]) if (Object.hasOwn(source,key)) info[key]=source[key];
  for (const [key, limit] of [['name',100], ['author',200], ['description',4000]]) {
    if (typeof info[key] !== 'string' || info[key].length > limit || key === 'name' && !info[key].trim()) fail(`${key} 须为${key === 'name' ? '非空' : ''}文本，最多 ${limit} 字符`);
  }
  for (const key of ['hitFx','holdAtlas','holdAtlasMH']) {
    const minimum = key === 'hitFx' ? 1 : 0;
    if (!Array.isArray(info[key]) || info[key].length !== 2 || !info[key].every(value => Number.isInteger(value) && value >= minimum && value <= 65535)) fail(`${key} 须为两个${minimum ? '正' : '非负'}整数`);
    info[key] = [...info[key]];
  }
  if (info.hitFx[0] * info.hitFx[1] > 10240) fail('打击动画图集不能超过 10240 帧');
  for (const key of ['hitFxDuration','hitFxScale']) if (!Number.isFinite(info[key]) || info[key] <= 0 || info[key] > (key === 'hitFxDuration' ? 120 : 64)) fail(`${key} 须为有效正数`);
  for (const key of ['hitFxRotate','hitFxTinted','hideParticles','holdKeepHead','holdRepeat','holdCompact']) if (typeof info[key] !== 'boolean') fail(`${key} 须为 true 或 false`);
  for (const key of ['colorPerfect','colorGood']) {
    if (typeof info[key] === 'string' && /^(?:0x|#)[\da-f]{6}(?:[\da-f]{2})?$/i.test(info[key])) info[key] = parseInt(info[key].replace(/^(0x|#)/i,''),16);
    if (!Number.isInteger(info[key]) || info[key] < 0 || info[key] > 0xffffffff) fail(`${key} 须为 RGB 或 ARGB 十六进制颜色`);
  }
  return info;
}

export function parseNoteSkinInfo(text) {
  if (typeof text !== 'string' || text.length > 65536) fail('info.yml 超过 64 KiB');
  let source;
  try { source = load(text.replace(/^\uFEFF/,''), { schema: CORE_SCHEMA }); }
  catch (error) { fail('info.yml 语法错误：' + error.message); }
  return noteSkinInfo(source);
}

export function serializeNoteSkinInfo(info) {
  return dump(noteSkinInfo(info), { schema: CORE_SCHEMA, noRefs: true, lineWidth: 100, sortKeys: false });
}

export function noteSkinColor(value) {
  return { rgb: [(value >>> 16) & 255, (value >>> 8) & 255, value & 255], alpha: value > 0xffffff ? ((value >>> 24) & 255) / 255 : 1 };
}

function imageSize(bytes, name) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || [137,80,78,71,13,10,26,10].some((value,index) => bytes[index] !== value) || String.fromCharCode(...bytes.subarray(12,16)) !== 'IHDR') fail(`${name} 不是 PNG 图片`);
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength); const width = view.getUint32(16); const height = view.getUint32(20);
  if (!width || !height || width > NOTE_SKIN_LIMITS.dimension || height > NOTE_SKIN_LIMITS.dimension) fail(`${name} 的图片尺寸无效或过大`);
  return {width,height};
}

export function normalizeNoteSkinFiles(source) {
  if (!(source instanceof Map) || source.size > NOTE_SKIN_LIMITS.files) fail('文件数量超限');
  const files = new Map(); let bytes = 0;
  for (const [path,value] of source) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes(':') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')) fail('包中包含不安全路径');
    if (path.endsWith('/') || path.startsWith('__MACOSX/') || path.split('/').at(-1).startsWith('.')) continue;
    if (!(value instanceof Uint8Array) || value.length > NOTE_SKIN_LIMITS.fileBytes) fail('素材文件无效或过大');
    bytes += value.length; if (bytes > NOTE_SKIN_LIMITS.bytes) fail('资源包解压后过大');
    files.set(path,value);
  }
  const manifests = [...files.keys()].filter(path => /(^|\/)info\.ya?ml$/i.test(path));
  if (manifests.length !== 1) fail('资源包需要唯一的 info.yml');
  const manifest = manifests[0]; const prefix = manifest.slice(0,manifest.lastIndexOf('/')+1);
  if (prefix && [...files.keys()].some(path=>!path.startsWith(prefix))) fail('资源包包含皮肤目录以外的文件');
  const normalized = new Map();
  for (const [path,value] of files) {
    let name = path.slice(prefix.length);
    const lower = name.toLowerCase();
    if (NOTE_SKIN_IMAGES.includes(lower) || Object.values(NOTE_SKIN_SOUNDS).includes(lower) || lower === 'ending.ogg') name = lower;
    if (path === manifest) name = 'info.yml';
    if (normalized.has(name)) fail(`文件名重复：${name}`);
    normalized.set(name,value);
  }
  return normalized;
}

export function parseNoteSkin(source, id = null) {
  const files = normalizeNoteSkinFiles(source); const images = {}; let pixels = 0;
  let text; try { text = new TextDecoder('utf-8',{fatal:true}).decode(files.get('info.yml')); } catch { fail('info.yml 需要 UTF-8 编码'); }
  const info = parseNoteSkinInfo(text);
  for (const name of NOTE_SKIN_IMAGES) {
    if (!files.has(name)) fail(`缺少 ${name}`);
    images[name] = imageSize(files.get(name),name); pixels += images[name].width * images[name].height;
  }
  if (pixels > NOTE_SKIN_LIMITS.pixels) fail('贴图总像素数过大');
  for (const [name,key] of [['hold.png','holdAtlas'],['hold_mh.png','holdAtlasMH']]) if (info[key][0]+info[key][1] >= images[name].height) fail(`${key} 的头尾高度之和必须小于 ${name} 的高度`);
  if (info.hitFx[0] > images['hit_fx.png'].width || info.hitFx[1] > images['hit_fx.png'].height) fail('hitFx 帧数超出图片尺寸');
  const warnings = [];
  if (images['hit_fx.png'].width % info.hitFx[0] || images['hit_fx.png'].height % info.hitFx[1]) warnings.push('打击动画尺寸不能被帧数整除，将按等分区域读取');
  if (files.has('ending.ogg')) warnings.push('结算音乐保留在皮肤包中，编辑器不播放结算界面');
  const sounds = new Map(Object.entries(NOTE_SKIN_SOUNDS).filter(([,name])=>files.has(name)).map(([type,name])=>[type,files.get(name)]));
  return { id, info, files, images, sounds, warnings, bytes:[...files.values()].reduce((sum,value)=>sum+value.length,0) };
}

export function noteSkinFrame(info, age) {
  if (!Number.isFinite(age) || age < 0 || age >= info.hitFxDuration) return null;
  const count = info.hitFx[0]*info.hitFx[1]; const index = Math.min(count-1,Math.floor(age/info.hitFxDuration*count));
  return {index,column:index%info.hitFx[0],row:Math.floor(index/info.hitFx[0])};
}

export function holdSkinLayout(info, image, highlighted, head, tail, width, heightWidth = width) {
  const [tailPixels,headPixels] = info[highlighted ? 'holdAtlasMH' : 'holdAtlas'];
  const scale = heightWidth / image.width; const headHeight = headPixels * scale; const tailHeight = tailPixels * scale;
  const length = Math.abs(tail-head); const direction = tail <= head ? 1 : -1;
  return {direction,length,scale,headHeight,tailHeight,bodyPixels:image.height-tailPixels-headPixels,
    headY:info.holdCompact ? -headHeight/2 : 0,
    tailY:-length-(info.holdCompact ? tailHeight/2 : tailHeight),
    bodyTop:-length,bodyHeight:length,tailPixels,headPixels};
}

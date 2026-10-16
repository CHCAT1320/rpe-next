export const EDITOR_SKIN_VERSION = 1;
export const EDITOR_SKIN_API = 3;
export const EDITOR_SKIN_LIMITS = Object.freeze({ files: 512, bytes: 32 * 1024 * 1024, fileBytes: 12 * 1024 * 1024 });
export const EDITOR_SKIN_COMPONENTS = Object.freeze({
  root: ':root', app: 'body', header: 'header', brand: '.brand', 'document-name': '#document-name', 'file-actions': 'header nav',
  transport: '.transport', 'transport-actions': '.transport-group', workspace: '.workspace', editor: '.editor', toolbar: '.editor-toolbar',
  tools: '.tools', 'view-controls': '.view-controls-inline', 'timeline-header': '.timeline-head', stage: '.stage',
  'editor-actions': '.editor-footer', inspector: '.inspector', 'inspector-tabs': '.inspector-tabs', 'chart-tools': '[data-panel="chart"] .action-grid',
  'project-home': '#home', 'project-list': '#project-cards', footer: 'body > footer', status: '#status', notifications: '#notifications',
  dialog: '#modal', settings: '#settings-modal', 'settings-body': '.settings-body', 'theme-settings': '#editor-skin-settings',
  'context-menu': '.timeline-context-menu', 'line-overview': '.line-switcher', 'clipboard-history': '#clipboard-results',
  ...Object.fromEntries(['new', 'open', 'save', 'export', 'library', 'migrate', 'recover', 'preferences', 'help', 'play', 'rewind', 'view-toggle',
    'seek', 'undo', 'redo', 'copy', 'cut', 'paste', 'mirror', 'delete', 'notes-only', 'game-ui', 'reset-camera', 'mute-current-line',
    'metadata', 'bpm', 'assets', 'audio-analysis-tool', 'noise-areas-tool', 'curve-notes', 'curve-trajectory', 'text-lines-tool',
    'noise-fit-tool', 'noise-tracking-tool', 'multi-line-tool', 'diagnose', 'history-panel', 'collaboration-tool'].map(id => [id, '#' + id])),
  'line-controls': '.line-select-group', 'beat-controls': '.beat-seek', 'view-buttons': '.view-buttons', 'multi-line-controls': '.multi-line-head-controls',
  'offset-control': 'label:has(#offset)', 'rate-control': 'label:has(#rate)', 'pitch-control': '.preserve-pitch',
  'time-progress': '.scrubber-wrap', 'time-readouts': '.time-readouts', clock: '#clock', 'beat-display': '#beat-display', 'bpm-display': '#bpm-display',
  'note-properties': '#properties', 'event-properties': '#event-properties', 'line-properties': '.line-properties-form',
  'noise-properties': '#noise-properties', 'noise-layers': '.noise-layer-panel', 'noise-list': '.noise-list',
  'line-list': '#line-list', 'multi-line-list': '.multi-line-list', 'asset-tree': '.asset-tree', 'asset-details': '.asset-details',
  'sample-bar': '.noise-sample-bar', 'sample-panel': '.event-sample-panel', field: ':is(.field,.noise-field)', hint: '.hint',
  'panel-title': '.panel-title', 'panel-actions': ':is(.batch-panel-actions,.trajectory-footer,.text-lines-footer,.noise-fit-footer,.noise-tracking-footer)',
  'batch-controls': '.batch-controls', 'batch-ball': '.batch-ball', chat: '.collaboration-chat', 'peer-markers': '.collaboration-markers',
  ...Object.fromEntries(['notes', 'events', 'lines', 'chart', 'noise'].map(pane => [`tab-${pane}`, `[data-pane="${pane}"]`])),
  ...Object.fromEntries([['select', 0], ['tap', 1], ['hold', 2], ['flick', 3], ['drag', 4]].map(([name, type]) => [`tool-${name}`, `[data-tool="${type}"]`])),
});
export const EDITOR_SKIN_SLOTS = ['file-actions', 'transport-actions', 'editor-actions', 'chart-tools', 'toolbar', 'inspector-tabs', 'timeline-header', 'footer'];
export const EDITOR_SKIN_MOVABLE = ['new', 'open', 'save', 'export', 'library', 'migrate', 'recover', 'preferences', 'help', 'play', 'rewind', 'view-toggle',
  'undo', 'redo', 'copy', 'cut', 'paste', 'mirror', 'delete', 'metadata', 'bpm', 'assets', 'audio-analysis-tool', 'noise-areas-tool',
  'curve-notes', 'curve-trajectory', 'text-lines-tool', 'noise-fit-tool', 'noise-tracking-tool', 'multi-line-tool', 'diagnose', 'history-panel', 'collaboration-tool',
  'seek', 'notes-only', 'game-ui', 'reset-camera', 'mute-current-line', 'tools', 'view-controls', 'view-buttons', 'line-controls', 'beat-controls',
  'offset-control', 'rate-control', 'pitch-control', 'time-readouts', 'multi-line-controls', 'tab-notes', 'tab-events', 'tab-lines', 'tab-chart', 'tab-noise',
  'tool-select', 'tool-tap', 'tool-hold', 'tool-flick', 'tool-drag'];
export const EDITOR_SKIN_CANVASES = Object.freeze({ notes: '#notes', events: '#events', noise: '#noise-editor-canvas', density: '#note-density', history: '#history-strip', audio: '#audio-analysis-overlay', selection: '.selection-overlay', 'batch-preview': '', easing: '.easing-preview', bezier: '.bezier-editor', curve: '.curve-preview', 'text-lines': '.text-lines-preview', trajectory: '.trajectory-preview,.trajectory-preset-thumbnail', 'noise-fit': '.noise-fit-source', 'line-thumbnail': '.line-switcher-card canvas', 'clipboard-thumbnail': '.clipboard-thumbnail' });
export const EDITOR_SKIN_BUILTINS = Object.freeze(Object.fromEntries(['folder', 'save', 'setting', 'help', 'play', 'replay', 'showback', 'jump', 'copy', 'shear', 'paste', 'delete0', 'switch', 'layout', 'return', 'info', 'waves', 'bezier', 'addline', 'mute'].map(name => [name, `rpe/Texture/icon/${name}.png`])));
export const EDITOR_SKIN_IMPORTANT = /^(?:--(?:rpen|skin)-[a-z0-9-]+|color|background(?:-[a-z-]+)?|border(?:-[a-z-]+)?|outline(?:-[a-z-]+)?|font(?:-[a-z-]+)?|line-height|letter-spacing|text-[a-z-]+|width|height|min-width|max-width|min-height|max-height|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|gap|row-gap|column-gap|flex(?:-[a-z-]+)?|grid(?:-[a-z-]+)?|order|box-shadow|filter)$/;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => { throw new Error('编辑器皮肤：' + message); };
const string = (value, name, max = 500) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(name + ' 无效'); return value; };
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const assetTypes = { image: /\.(?:png|jpe?g|webp|gif|avif|apng|svg)$/i, font: /\.(?:woff2?|ttf|otf)$/i };
export function editorSkinPath(path) {
  string(path, '文件路径', 240);
  if (/[\\:\x00-\x1f?#]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) fail('不安全的文件路径：' + path);
  return path;
}
function cssValue(value) {
  string(value, 'CSS 值', 3000);
  if (/[{};<>\\]|\/\*|\*\/|url\s*\(|(?:https?|data|javascript|file|blob):|@|expression\s*\(|!\s*important|(?:attr|env|image-set|paint|src)\s*\(/i.test(value)) fail('CSS 值含不支持的内容');
  return value;
}
export function editorSkinSelector(selector) {
  string(selector, '选择器', 500);
  if (/[{};<\\]|\/\*|\*\/|:visited|:host|::slotted|\biframe\b|\brpen-skin-recovery\b/i.test(selector)) fail('选择器含不支持的内容');
  return selector.replace(/@([a-z][a-z0-9-]*)/g, (match, key) => Object.hasOwn(EDITOR_SKIN_COMPONENTS, key) ? EDITOR_SKIN_COMPONENTS[key] : fail('未知组件：' + key));
}
function declarations(value, path) {
  if (!plain(value) || Object.keys(value).length > 100) fail(path + ' 必须为 CSS 属性对象');
  for (const [key, item] of Object.entries(value)) {
    if (!/^(?:--(?:skin|rpen)-[a-z0-9-]+|-?[a-z][a-z0-9-]*)$/.test(key) || /^(?:behavior|-moz-binding|all)$/.test(key)) fail('不支持的 CSS 属性：' + key);
    cssValue(item);
  }
}
function rules(items = [], depth = 0) {
  if (!Array.isArray(items) || items.length > 1000 || depth > 4) fail('样式规则数量或嵌套超限');
  for (const rule of items) {
    if (!plain(rule)) fail('样式规则必须为对象');
    const conditions = ['media', 'container', 'supports', 'startingStyle'].filter(key => rule[key] !== undefined);
    if (conditions.length > 1) fail('每个条件规则只能有一种条件，可用 rules 嵌套组合');
    if (conditions.length) {
      const kind = conditions[0];
      if (kind === 'startingStyle') { if (rule.startingStyle !== true) fail('startingStyle 必须为 true'); }
      else {
        string(rule[kind], kind + ' 条件', 500);
        if (/[{};@\\]|\/\*|\*\/|url\s*\(|(?:https?|data|javascript|file):/i.test(rule[kind]) || !/^[a-z0-9_ ():.\-,\/<>="'%#+*]+$/i.test(rule[kind])) fail(kind + ' 条件含非法字符');
      }
      rules(rule.rules, depth + 1);
    } else {
      editorSkinSelector(rule.selector); declarations(rule.set, rule.selector);
      if (rule.important !== undefined && (!Array.isArray(rule.important) || rule.important.some(key => !Object.hasOwn(rule.set, key) || !EDITOR_SKIN_IMPORTANT.test(key)))) fail('important 只允许覆盖本规则中的外观、尺寸及排列属性');
    }
  }
}
const paletteParameter = /^parameter\(([a-z][a-z0-9-]{0,63})\)$/;
function canvasConfig(config, parameters = {}) {
  if (!plain(config) || !plain(config.palette ?? {})) fail('canvas 无效');
  for (const [from, to] of Object.entries(config.palette ?? {})) {
    if (!/^#[0-9a-f]{6}$/i.test(from) || typeof to !== 'string') fail('Canvas 色板只支持 #rrggbb');
    const reference = to.match(paletteParameter);
    if (reference ? parameters[reference[1]]?.type !== 'color' : !/^#[0-9a-f]{6}$/i.test(to)) fail(reference ? 'Canvas 色板只能引用颜色参数：' + reference[1] : 'Canvas 色板只支持 #rrggbb 或 parameter(颜色参数)');
  }
  for (const [key, minimum, maximum] of [['fontScale', .7, 1.8], ['opacity', 0, 1], ['lineWidthScale', .25, 4]]) if (config[key] !== undefined && (!Number.isFinite(config[key]) || config[key] < minimum || config[key] > maximum)) fail('Canvas ' + key + ' 超出范围');
  if (config.lineDash !== undefined && (!Array.isArray(config.lineDash) || config.lineDash.length > 16 || config.lineDash.some(value => !Number.isFinite(value) || value < 0 || value > 100))) fail('Canvas lineDash 无效');
  if (!plain(config.targets ?? {})) fail('Canvas targets 无效');
  for (const [key, target] of Object.entries(config.targets ?? {})) { if (!Object.hasOwn(EDITOR_SKIN_CANVASES, key) || target?.targets !== undefined) fail('未知或嵌套画布：' + key); canvasConfig(target, parameters); }
}
export function resolveEditorSkin(skin, { variant = 'base', parameters = {} } = {}) {
  const selected = variant === 'base' ? {} : skin.variants?.[variant];
  if (!selected) fail('变体不存在：' + variant);
  const values = Object.fromEntries(Object.entries(skin.parameters ?? {}).map(([id, definition]) => {
    let value = Object.hasOwn(parameters, id) ? parameters[id] : definition.default;
    if (definition.type === 'number') { value = Number(value); if (!Number.isFinite(value)) value = definition.default; value = Math.max(definition.min, Math.min(definition.max, value)); value = `${value}${definition.unit ?? ''}`; }
    else if (definition.type === 'boolean') value = value === true ? '1' : '0';
    else if (definition.type === 'color' && !/^#[0-9a-f]{6}$/i.test(value)) value = definition.default;
    else if (definition.type === 'select' && !Object.hasOwn(definition.options, value)) value = definition.default;
    return [`param-${id}`, value];
  }));
  // Canvas colours are plain strings at draw time, so palette parameter references resolve here.
  const palette = entries => entries && Object.fromEntries(Object.entries(entries).map(([from, to]) => { const reference = String(to).match(paletteParameter); return [from, reference ? values['param-' + reference[1]] ?? to : to]; }));
  const targets = { ...skin.canvas?.targets, ...selected.canvas?.targets };
  return { ...skin, colorScheme: selected.colorScheme ?? skin.colorScheme, tokens: { ...skin.tokens, ...selected.tokens, ...values }, styles: [...(skin.styles ?? []), ...(selected.styles ?? [])], canvas: { ...skin.canvas, ...selected.canvas, palette: palette({ ...skin.canvas?.palette, ...selected.canvas?.palette }), targets: Object.fromEntries(Object.entries(targets).map(([role, target]) => [role, { ...target, palette: palette(target.palette) }])) } };
}
export function parseEditorSkin(files) {
  if (!(files instanceof Map) || files.size > EDITOR_SKIN_LIMITS.files) fail('皮肤文件数量超限');
  let total = 0; const paths = new Set();
  for (const [path, bytes] of files) {
    editorSkinPath(path); if (!(bytes instanceof Uint8Array) || bytes.byteLength > EDITOR_SKIN_LIMITS.fileBytes) fail('文件过大或内容无效：' + path);
    if (paths.has(path.toLowerCase())) fail('文件路径大小写冲突：' + path);
    paths.add(path.toLowerCase()); total += bytes.byteLength;
  }
  if (total > EDITOR_SKIN_LIMITS.bytes) fail('皮肤总大小超过 32 MiB');
  const source = files.get('skin.json'); if (!source) fail('根目录缺少 skin.json');
  let skin; try { skin = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source)); } catch { fail('skin.json 不是有效 UTF-8 JSON'); }
  if (!plain(skin) || skin.protocol !== 'rpen-editor-skin' || skin.version !== 1) fail('需要 rpen-editor-skin 协议 version=1');
  if (typeof skin.id !== 'string' || !identifier.test(skin.id) || skin.id === 'default') fail('id 须为小写英文开头的字母、数字或连字符，且不能为 default');
  string(skin.name, '皮肤名称', 80); if (skin.author !== undefined) string(skin.author, '作者', 100);
  if (skin.description !== undefined) string(skin.description, '说明', 2000);
  if (skin.skinVersion !== undefined) string(skin.skinVersion, '皮肤版本', 40);
  if (skin.license !== undefined) string(skin.license, '许可', 4000);
  if (skin.compatibility !== undefined) {
    if (!plain(skin.compatibility)) fail('compatibility 无效');
    for (const key of ['minApi', 'maxApi']) if (skin.compatibility[key] !== undefined && (!Number.isInteger(skin.compatibility[key]) || skin.compatibility[key] < 1)) fail('兼容 API 版本无效');
    if ((skin.compatibility.minApi ?? 1) > EDITOR_SKIN_API || (skin.compatibility.maxApi ?? Infinity) < EDITOR_SKIN_API) fail('皮肤不兼容当前编辑器皮肤 API ' + EDITOR_SKIN_API);
  }
  if (skin.colorScheme !== undefined && !['light', 'dark'].includes(skin.colorScheme)) fail('colorScheme 只支持 light/dark');
  const assets = skin.assets ?? {}; if (!plain(assets) || Object.keys(assets).length > 256) fail('assets 无效');
  const referenced = new Set(['skin.json']);
  for (const [id, asset] of Object.entries(assets)) {
    if (!identifier.test(id) || !plain(asset) || !Object.hasOwn(assetTypes, asset.type)) fail('素材标识或类型无效：' + id);
    if (asset.builtin !== undefined) {
      if (asset.type !== 'image' || typeof asset.builtin !== 'string' || !Object.hasOwn(EDITOR_SKIN_BUILTINS, asset.builtin) || asset.path !== undefined || asset.sources !== undefined) fail('内置素材引用无效：' + id);
    } else {
      editorSkinPath(asset.path); if (!files.has(asset.path) || !assetTypes[asset.type].test(asset.path)) fail('素材不存在或扩展名不匹配：' + id);
      referenced.add(asset.path);
      if (asset.sources !== undefined) {
        if (asset.type !== 'image' || !Array.isArray(asset.sources) || asset.sources.length > 4) fail('高 DPI 图片来源无效');
        const scales = new Set([1]);
        for (const source of asset.sources) {
          if (!plain(source) || !Number.isFinite(source.scale) || source.scale <= 1 || source.scale > 4 || scales.has(source.scale)) fail('高 DPI 倍率无效'); scales.add(source.scale);
          editorSkinPath(source.path); if (!files.has(source.path) || !assetTypes.image.test(source.path)) fail('高 DPI 图片缺失'); referenced.add(source.path);
        }
      }
    }
  }
  if ([...files.keys()].some(path => !referenced.has(path))) fail('包中包含未声明的文件，请仅保留 skin.json 和 assets 中列出的素材');
  if (!plain(skin.tokens ?? {})) fail('tokens 无效');
  for (const [key, value] of Object.entries(skin.tokens ?? {})) { if (!identifier.test(key)) fail('变量名无效：' + key); cssValue(value); }
  rules(skin.styles);
  if (!plain(skin.properties ?? {}) || Object.keys(skin.properties ?? {}).length > 40) fail('properties 无效');
  for (const [name, definition] of Object.entries(skin.properties ?? {})) {
    if (!/^--skin-[a-z0-9-]+$/.test(name) || !plain(definition) || !['*', '<number>', '<length>', '<angle>', '<color>', '<percentage>', '<time>'].includes(definition.syntax) || typeof definition.inherits !== 'boolean') fail('自定义属性注册无效');
    cssValue(definition.initialValue);
  }
  if (skin.preview !== undefined && (typeof skin.preview !== 'string' || assets[skin.preview]?.type !== 'image')) fail('preview 必须引用图片素材');
  if (!plain(skin.parameters ?? {}) || Object.keys(skin.parameters ?? {}).length > 40) fail('parameters 无效');
  for (const [id, definition] of Object.entries(skin.parameters ?? {})) {
    if (!identifier.test(id) || !plain(definition)) fail('参数无效：' + id); string(definition.label, '参数名称', 80);
    if (definition.type === 'number') {
      if (![definition.min, definition.max, definition.default, definition.step ?? 1].every(Number.isFinite) || definition.max < definition.min || definition.default < definition.min || definition.default > definition.max || (definition.step ?? 1) <= 0 || !/^(?:px|em|rem|%|ms|s|deg)?$/.test(definition.unit ?? '')) fail('数值参数范围无效');
    } else if (definition.type === 'boolean') { if (typeof definition.default !== 'boolean') fail('布尔参数默认值无效'); }
    else if (definition.type === 'color') { if (typeof definition.default !== 'string' || !/^#[0-9a-f]{6}$/i.test(definition.default)) fail('颜色参数默认值无效'); }
    else if (definition.type === 'select') {
      if (!plain(definition.options) || typeof definition.default !== 'string' || !Object.hasOwn(definition.options, definition.default) || Object.keys(definition.options).length > 30) fail('选择参数选项无效');
      for (const [value, label] of Object.entries(definition.options)) { cssValue(value); string(label, '参数选项', 80); }
    } else fail('参数类型无效');
  }
  if (!plain(skin.variants ?? {}) || Object.keys(skin.variants ?? {}).length > 12) fail('variants 无效');
  for (const [id, variant] of Object.entries(skin.variants ?? {})) {
    if (!identifier.test(id) || ['auto', 'base'].includes(id) || !plain(variant)) fail('变体 id 无效'); string(variant.name, '变体名称', 80);
    if (variant.colorScheme !== undefined && !['light', 'dark'].includes(variant.colorScheme)) fail('变体 colorScheme 无效');
    if (!plain(variant.tokens ?? {})) fail('变体 tokens 无效');
    for (const [key, value] of Object.entries(variant.tokens ?? {})) { if (!identifier.test(key)) fail('变体变量名无效'); cssValue(value); }
    rules(variant.styles); if (variant.canvas) canvasConfig(variant.canvas, skin.parameters);
  }
  if (skin.systemVariants !== undefined) for (const scheme of ['light', 'dark']) if (!plain(skin.systemVariants) || !Object.hasOwn(skin.variants ?? {}, skin.systemVariants[scheme])) fail('systemVariants 必须包含已有的 light/dark 变体');
  if (!Array.isArray(skin.hide ?? []) || (skin.hide?.length ?? 0) > 300) fail('hide 须为最多 300 个选择器的数组');
  for (const selector of skin.hide ?? []) editorSkinSelector(selector);
  const motions = skin.motions ?? {}; if (!plain(motions) || Object.keys(motions).length > 64) fail('motions 无效');
  for (const [id, frames] of Object.entries(motions)) {
    if (!identifier.test(id) || !plain(frames) || Object.keys(frames).length > 40) fail('动画无效：' + id);
    for (const [at, set] of Object.entries(frames)) { if (!/^(?:from|to|100%|\d{1,2}(?:\.\d+)?%)$/.test(at)) fail('动画时间位置无效：' + at); declarations(set, id); }
  }
  if (!Array.isArray(skin.organize ?? []) || (skin.organize?.length ?? 0) > 40) fail('organize 无效');
  const organized = new Set(); const groups = new Set();
  for (const group of skin.organize ?? []) {
    if (!plain(group) || !EDITOR_SKIN_SLOTS.includes(group.slot) || !Array.isArray(group.items)) fail('organize 容器无效');
    if (group.id !== undefined && (typeof group.id !== 'string' || !identifier.test(group.id) || groups.has(group.id))) fail('组织分组 id 无效或重复');
    if (group.id) groups.add(group.id);
    if (!group.id && ['label', 'direction', 'collapsible'].some(key => group[key] !== undefined)) fail('分组方向、名称或折叠设置需要 id');
    if (group.collapsible !== undefined && (typeof group.collapsible !== 'boolean' || group.collapsible && !group.label)) fail('折叠分组需要布尔值及 label');
    if (group.label !== undefined) string(group.label, '分组文字', 60);
    if (group.direction !== undefined && !['row', 'column'].includes(group.direction)) fail('分组方向无效');
    for (const item of group.items) { if (!EDITOR_SKIN_MOVABLE.includes(item) || organized.has(item)) fail('不可移动或重复的控件：' + item); organized.add(item); }
  }
  if (!Array.isArray(skin.texts ?? []) || (skin.texts?.length ?? 0) > 300) fail('texts 无效');
  for (const entry of skin.texts ?? []) {
    if (!plain(entry)) fail('文字项无效'); editorSkinSelector(entry.selector);
    for (const key of ['text', 'title', 'ariaLabel', 'placeholder']) if (entry[key] !== undefined && (typeof entry[key] !== 'string' || entry[key].length > 1000)) fail('文字内容无效');
  }
  if (Array.isArray(skin.icons)) {
    if (skin.icons.length > 300) fail('icons 超过 300 项');
    for (const icon of skin.icons) { if (!plain(icon) || assets[icon.asset]?.type !== 'image') fail('图标引用无效'); editorSkinSelector(icon.selector); }
  } else {
    if (!plain(skin.icons ?? {})) fail('icons 无效');
    for (const [id, asset] of Object.entries(skin.icons ?? {})) if (!Object.hasOwn(EDITOR_SKIN_COMPONENTS, id) || typeof asset !== 'string' || assets[asset]?.type !== 'image') fail('图标引用无效：' + id);
  }
  if (!Array.isArray(skin.decorations ?? []) || (skin.decorations?.length ?? 0) > 24) fail('decorations 无效');
  const decorations = new Set();
  for (const entry of skin.decorations ?? []) {
    if (!plain(entry) || typeof entry.id !== 'string' || !identifier.test(entry.id) || decorations.has(entry.id) || typeof entry.asset !== 'string' || assets[entry.asset]?.type !== 'image') fail('装饰引用无效'); decorations.add(entry.id);
    if (entry.selector !== undefined) editorSkinSelector(entry.selector);
    else if (!Object.hasOwn(EDITOR_SKIN_COMPONENTS, entry.target)) fail('装饰目标无效');
    if (entry.placement !== undefined && !['prepend', 'append', 'before', 'after'].includes(entry.placement)) fail('装饰位置无效');
  }
  canvasConfig(skin.canvas ?? {}, skin.parameters);
  if (!plain(skin.canvas?.targets ?? {})) fail('Canvas targets 无效');
  for (const [key, config] of Object.entries(skin.canvas?.targets ?? {})) { if (!Object.hasOwn(EDITOR_SKIN_CANVASES, key)) fail('未知画布：' + key); canvasConfig(config, skin.parameters); }
  for (const canvas of [skin.canvas, ...Object.values(skin.variants ?? {}).map(variant => variant.canvas)]) for (const config of [canvas, ...Object.values(canvas?.targets ?? {})]) if (config?.font !== undefined && (typeof config.font !== 'string' || assets[config.font]?.type !== 'font')) fail('Canvas 字体引用无效');
  const allValues = JSON.stringify([skin.tokens, skin.styles, skin.motions, skin.variants]);
  for (const match of allValues.matchAll(/\b(asset|font|motion|parameter)\(([a-z][a-z0-9-]*)\)/g)) {
    const [, kind, id] = match;
    if (kind === 'parameter' ? !Object.hasOwn(skin.parameters ?? {}, id) : kind === 'motion' ? !Object.hasOwn(motions, id) : kind === 'font' ? assets[id]?.type !== 'font' : assets[id]?.type !== 'image') fail('样式素材或动画引用不存在：' + id);
  }
  return { skin, files, bytes: total };
}

export function compileEditorSkin(skin, { images = new Map(), fonts = new Map(), imageSets = new Map() } = {}) {
  const prefix = `:root[data-editor-skin="${skin.id}"]`;
  const value = text => text.replace(/\b(asset|font|motion|parameter)\(([a-z][a-z0-9-]*)\)/g, (match, kind, id) => {
    if (kind === 'motion') return `rpen-${skin.id}-${id}`;
    if (kind === 'parameter') return `var(--rpen-param-${id})`;
    const entry = (kind === 'font' ? fonts : images).get(id); if (!entry) fail('素材尚未载入：' + id);
    return kind === 'font' ? `"${entry}"` : imageSets.get(id) ?? `url("${entry}")`;
  });
  const declarations = (set, important = []) => Object.entries(set).map(([key, item]) => `${key}:${value(item)}${important.includes(key) ? '!important' : ''}`).join(';');
  // Split only top-level commas; pseudo-elements must remain outside :is().
  const selector = text => {
    const source = editorSkinSelector(text); const parts = []; let start = 0; let depth = 0; let quote = '';
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") quote = char;
      else if (char === '(' || char === '[') depth++;
      else if (char === ')' || char === ']') depth--;
      else if (char === ',' && depth === 0) { parts.push(source.slice(start, i).trim()); start = i + 1; }
    }
    parts.push(source.slice(start).trim());
    return parts.map(part => part.startsWith(':root') ? `${prefix}${part.slice(5)}` : /^html(?=[\s.#[(:]|$)/.test(part) ? `${prefix}${part.slice(4)}` : `${prefix} ${part}`).join(',');
  };
  const rules = entries => (entries ?? []).map(rule => {
    const kind = ['media', 'container', 'supports', 'startingStyle'].find(key => rule[key] !== undefined);
    return kind ? `@${kind === 'startingStyle' ? 'starting-style' : kind}${kind === 'startingStyle' ? '' : ' ' + rule[kind]}{${rules(rule.rules)}}` : `${selector(rule.selector)}{${declarations(rule.set, rule.important)}}`;
  }).join('\n');
  const tokens = Object.entries(skin.tokens ?? {}).map(([key, text]) => `--rpen-${key}:${value(text)}`).join(';');
  const frames = Object.entries(skin.motions ?? {}).map(([id, frames]) => `@keyframes rpen-${skin.id}-${id}{${Object.entries(frames).map(([at, set]) => `${at}{${declarations(set)}}`).join('')}}`).join('\n');
  const properties = Object.entries(skin.properties ?? {}).map(([name, definition]) => `@property ${name}{syntax:"${definition.syntax}";inherits:${definition.inherits};initial-value:${value(definition.initialValue)}}`).join('\n');
  const iconEntries = Array.isArray(skin.icons) ? skin.icons : Object.entries(skin.icons ?? {}).map(([id, asset]) => ({ selector: '@' + id, asset }));
  const icons = iconEntries.map(icon => `${selector(`:is(${editorSkinSelector(icon.selector)})::before`)}{content:"";display:inline-block;width:18px;height:18px;vertical-align:middle;background-image:${imageSets.get(icon.asset) ?? `url("${images.get(icon.asset)}")`};background-size:contain;background-repeat:no-repeat;background-position:center;margin-right:6px}`).join('\n');
  const hidden = (skin.hide ?? []).map(text => `${selector(text)}{display:none!important;transition:none!important;animation:none!important}`).join('\n');
  return `${prefix}{color-scheme:${skin.colorScheme ?? 'dark'};${tokens}}\n${properties}\n${frames}\n${icons}\n${rules(skin.styles)}\n${hidden}\n@media(prefers-reduced-motion:reduce){${prefix} *,${prefix} *::before,${prefix} *::after{animation-duration:0.001ms!important;animation-iteration-count:1!important;transition-duration:0.001ms!important}}`;
}

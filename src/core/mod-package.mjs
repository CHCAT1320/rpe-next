import { parse } from './vendor/acorn.mjs';
import { parseShortcut } from './shortcut-spec.mjs';

export const MOD_API_VERSION = 1;
export const MOD_LIMITS = Object.freeze({ files: 2048, bytes: 128 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, codeBytes: 4 * 1024 * 1024 });
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const fail = message => { throw new Error('模组：' + message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function modPath(path) {
  if (typeof path !== 'string' || !path || path.length > 240 || /[\\:\x00-\x1f?#]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) fail('无效的包内路径：' + path);
  return path;
}
export function modManifest(source) {
  if (!object(source) || source.protocol !== 'rpen-mod' || source.api !== MOD_API_VERSION) fail('需要 rpen-mod 协议 api=1');
  if (!identifier.test(source.id)) fail('id 需要小写字母开头，使用字母、数字和连字符');
  for (const [key,limit] of [['name',100],['version',60],['author',160],['description',4000]]) if (typeof source[key] !== 'string' || source[key].length > limit || ['name','version'].includes(key) && !source[key].trim()) fail(key + ' 文本无效');
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(source.version)) fail('version 须为语义化版本号，例如 1.0.0');
  modPath(source.entry); if (!/\.(m?js)$/.test(source.entry)) fail('entry 需要为 .mjs / .js ES 模块');
  for (const key of ['dependencies','conflicts']) if (source[key] !== undefined && (!Array.isArray(source[key]) || source[key].length > 64 || source[key].some(id => !identifier.test(id) || id === source.id))) fail(key + ' 须为其他模组 id 的数组');
  if (source.settings !== undefined && (!object(source.settings) || Object.keys(source.settings).length > 100)) fail('settings 无效');
  for (const [key,definition] of Object.entries(source.settings ?? {})) {
    if (!identifier.test(key) || !object(definition) || typeof definition.label !== 'string' || definition.label.length > 120 || !['boolean','number','text','color','select','shortcut'].includes(definition.type)) fail('无效的设置项：' + key);
    if (definition.type === 'select' && (!object(definition.options) || !Object.keys(definition.options).length || Object.keys(definition.options).length>200 || Object.entries(definition.options).some(([key,label])=>key.length>2000||typeof label!=='string'||label.length>2000))) fail('select 缺少有效的 options');
    if (definition.type === 'number' && (!Number.isFinite(definition.min) || !Number.isFinite(definition.max) || definition.min > definition.max)) fail('number 需要有效的 min/max');
    if (definition.step!==undefined&&(!Number.isFinite(definition.step)||definition.step<=0))fail('step 必须为正数');
    modSettingValue(definition,definition.default,key);
  }
  return { ...source, dependencies: [...new Set(source.dependencies ?? [])], conflicts: [...new Set(source.conflicts ?? [])], settings: source.settings ?? {} };
}
export function modSettingValue(definition,value,key='') {
  if(!definition)fail('未知设置项：'+key);
  if (definition.type === 'boolean' && typeof value !== 'boolean' || definition.type === 'number' && (!Number.isFinite(value) || value < definition.min || value > definition.max) || ['text','color','select','shortcut'].includes(definition.type) && (typeof value !== 'string' || value.length > 2000) || definition.type === 'color' && !/^#[\da-f]{6}$/i.test(value) || definition.type === 'select' && !Object.hasOwn(definition.options,value)) fail('设置值无效：' + key);
  if(definition.type==='shortcut'&&parseShortcut(value).error)fail('快捷键无效：'+key);
  return value;
}
export function parseModPackage(source) {
  if (!(source instanceof Map) || source.size > MOD_LIMITS.files) fail('文件数量超限');
  let bytes=0;const entries=new Map();
  for (const [name,data] of source) {
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').at(-1).startsWith('.')) continue;
    modPath(name);if (!(data instanceof Uint8Array) || data.length > MOD_LIMITS.fileBytes) fail('文件无效或过大：' + name);
    bytes+=data.length;if(bytes>MOD_LIMITS.bytes)fail('解压后超过 128 MiB');entries.set(name,data);
  }
  const manifests=[...entries.keys()].filter(name=>name==='mod.json'||name.endsWith('/mod.json'));if(manifests.length!==1)fail('需要唯一的 mod.json');
  const prefix=manifests[0].slice(0,-8);if([...entries.keys()].some(name=>!name.startsWith(prefix)))fail('存在模组目录以外的文件');
  const files=new Map([...entries].map(([name,data])=>[name.slice(prefix.length),data]));let manifest;
  try {manifest=modManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(files.get('mod.json'))));}catch(error){fail('mod.json：'+error.message);}
  if (!files.has(manifest.entry)) fail('入口文件不存在：' + manifest.entry);
  for (const [name,data] of files) if (/\.(m?js)$/.test(name)) {
    if(data.length>MOD_LIMITS.codeBytes)fail('代码文件超过 4 MiB');
    try {parse(new TextDecoder('utf-8',{fatal:true}).decode(data),{ecmaVersion:'latest',sourceType:'module'});} catch(error){fail(`${name} 语法错误：${error.message}`);}
  }
  return {manifest,files,bytes};
}
export function resolveModImport(specifier,from,files,prefix,baseUrl) {
  if (typeof specifier !== 'string') fail('动态 import 路径须为字符串');
  if (specifier === '@rpen/api') return new URL('src/ui/mod-api.mjs',baseUrl).href;
  if (specifier.startsWith('@rpen/')) {const path=modPath(specifier.slice(6));if(!/^(core|application|platform|ui)\/.+\.mjs$/.test(path))fail('内部模块路径无效');return new URL('src/'+path,baseUrl).href;}
  if (!specifier.startsWith('.')) {
    if(/^(https?:|data:|blob:)/.test(specifier))return specifier;
    fail('未知模块名：'+specifier+'；请使用包内相对路径或 @rpen/');
  }
  const parts=from.split('/').slice(0,-1);
  for(const part of specifier.split('/'))if(part==='..'){if(!parts.length)fail('模块导入超出包根目录');parts.pop();}else if(part!=='.'&&part)parts.push(part);
  const path=modPath(parts.join('/'));if(!files.has(path))fail('模块不存在：'+path);
  if(!/\.(m?js|json)$/.test(path))fail('import 仅用于 JS/JSON 模块，素材请用 api.package.url');
  return prefix+path;
}
export function rewriteModModule(source,path,resolve,loadId) {
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});const edits=[];
  const visit=node=>{
    if(!node||typeof node!=='object')return;
    if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)edits.push([node.source.start,node.source.end,JSON.stringify(resolve(node.source.value,path))]);
    if(node.type==='ImportExpression'){
      if(node.source.type==='Literal')edits.push([node.source.start,node.source.end,JSON.stringify(resolve(node.source.value,path))]);
      else {edits.push([node.source.start,node.source.start,`globalThis.rpenMods.resolveModule(${JSON.stringify(loadId)},(`]);edits.push([node.source.end,node.source.end,`),${JSON.stringify(path)})`]);}
    }
    if(node.type==='MemberExpression'&&!node.computed&&node.object?.type==='MetaProperty'&&node.object.meta.name==='import'&&node.property?.name==='resolve')edits.push([node.start,node.end,`(specifier=>globalThis.rpenMods.resolveModule(${JSON.stringify(loadId)},specifier,${JSON.stringify(path)}))`]);
    for(const [key,value]of Object.entries(node))if(!['start','end','loc'].includes(key)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}
  };visit(ast);
  edits.sort((a,b)=>b[0]-a[0]||b[1]-a[1]);let rewritten=source;
  for(const [start,end,replacement]of edits)rewritten=rewritten.slice(0,start)+replacement+rewritten.slice(end);
  return rewritten;
}

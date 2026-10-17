export const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
export const slashPath = path => String(path ?? '').replaceAll('\\', '/');
export const pathKey = path => slashPath(path).toLowerCase();
export const withinFolder = (path, folder) => !folder || pathKey(path).startsWith(pathKey(folder) + '/');
export const parentFolder = path => slashPath(path).split('/').slice(0, -1).join('/');

// Paths remain portable between PEZ archives and desktop named asset copies.
export function validAssetPath(value) {
  const path = slashPath(value);
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..'
    || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('名称包含无效路径或文件名');
  return path;
}

export function collectAssetFolders(path, folders) {
  const parts = slashPath(path).split('/'); parts.pop();
  for (let index = 1; index <= parts.length; index++) folders.add(parts.slice(0, index).join('/'));
}

export function noiseSkinRoots(assets, chart = {}, chartName = '') {
  const roots = new Set(), directory = parentFolder(chartName);
  for (const name of assets.keys()) {
    const path = slashPath(name);
    if (/(?:^|\/)shader\/[^/]+\/main\.glsl$/i.test(path)) roots.add(path.slice(0, -10));
  }
  for (const layer of chart.noiseAreaLayers ?? []) for (const root of [layer.skin, ...Object.keys(layer.skinPresets ?? {})]) {
    if (!root) continue;
    for (const candidate of [root, directory ? directory + '/' + root : root]) {
      if ([...assets.keys()].some(path => withinFolder(path, candidate))) roots.add(candidate);
    }
  }
  return roots;
}

export function skinOwnedPath(path, roots) { return [...roots].some(root => pathKey(root) === pathKey(path) || withinFolder(path, root)); }
export function libraryImages(assets, chart = {}, chartName = '') {
  const roots = noiseSkinRoots(assets, chart, chartName);
  return [...assets].filter(([name]) => IMAGE_EXTENSION.test(name) && !skinOwnedPath(name, roots));
}

export function libraryFolders(assets, folders = [], chart = {}, chartName = '') {
  const roots = noiseSkinRoots(assets, chart, chartName), result = new Set();
  for (const folder of folders) if (!skinOwnedPath(folder, roots)) { result.add(slashPath(folder)); collectAssetFolders(folder + '/_', result); }
  for (const [path] of libraryImages(assets, chart, chartName)) collectAssetFolders(path, result);
  return result;
}

export function assertImageFolder(context, folder) {
  const roots = noiseSkinRoots(context.assets, context.chart, context.chartName);
  if ([...roots].some(root => skinOwnedPath(folder, roots) || withinFolder(root, folder))) throw Error('此文件夹包含噪域皮肤，请在噪域层管理中管理皮肤');
  if ([...context.assets.keys()].some(path => withinFolder(path, folder) && !IMAGE_EXTENSION.test(path))) throw Error('此文件夹包含非图片文件，请单独移动其中的图片');
}

export function moveLibraryPaths(context, from, to, folder = false) {
  from = validAssetPath(from); to = validAssetPath(to);
  const { assets } = context, folders = libraryFolders(assets, context.folders, context.chart, context.chartName);
  const roots = noiseSkinRoots(assets, context.chart, context.chartName);
  if (skinOwnedPath(from, roots) || skinOwnedPath(to, roots)) throw Error('不能在图片素材库中修改噪域皮肤文件');
  if (folder) {
    assertImageFolder(context, from);
    if (withinFolder(to, from)) throw Error('不能把文件夹移动到自己的子文件夹');
    if (!folders.has(from)) throw Error('源文件夹不存在');
    if ([...assets.keys()].some(path => pathKey(path) === pathKey(to))) throw Error('目标位置已有同名文件');
    if (from !== to && [...folders].some(path => pathKey(path) === pathKey(to) && pathKey(path) !== pathKey(from))) throw Error('目标文件夹已存在');
  } else if (!assets.has(from) || !IMAGE_EXTENSION.test(to)) throw Error('请选择有效的图片文件名');
  const paths = new Map([...assets.keys()].filter(path => folder ? withinFolder(path, from) : path === from)
    .map(path => [path, folder ? to + slashPath(path).slice(from.length) : to]));
  const occupied = new Set([...assets.keys()].filter(path => !paths.has(path)).map(pathKey));
  const targetFiles = new Set();
  for (const target of paths.values()) {
    if (occupied.has(pathKey(target)) || targetFiles.has(pathKey(target)) || [...folders].some(path => pathKey(path) === pathKey(target))) throw Error('目标位置已有同名文件或文件夹');
    targetFiles.add(pathKey(target));
    for (let parent = parentFolder(target); parent; parent = parentFolder(parent)) if (occupied.has(pathKey(parent))) throw Error('目标路径中存在同名文件');
  }
  const nextAssets = new Map([...assets].map(([path, bytes]) => [paths.get(path) ?? path, bytes]));
  const nextFolders = new Set([...context.folders ?? []].map(path => folder && (pathKey(path) === pathKey(from) || withinFolder(path, from)) ? to + slashPath(path).slice(from.length) : path));
  if (folder) nextFolders.add(to);
  for (const target of paths.values()) collectAssetFolders(target, nextFolders);
  collectAssetFolders(to + (folder ? '/_' : ''), nextFolders);
  return { assets: nextAssets, folders: nextFolders, paths };
}

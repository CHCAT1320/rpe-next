import { showDialog } from './dialog.ts';
import { mediaType } from '../platform/files.ts';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

function imageName(path) { return String(path ?? '').replaceAll('\\', '/'); }
function imageEntries(assets) { return [...(assets ?? [])].filter(([name]) => IMAGE_EXTENSIONS.test(imageName(name))); }
function createUrl(bytes, name) { return URL.createObjectURL(new Blob([bytes], { type: mediaType(name) })); }

export class AssetLibraryPanel {
  constructor(host, getContext, { notify = () => {}, onChange = () => {}, onTexture = () => {} } = {}) {
    this.host = host; this.getContext = getContext; this.notify = notify; this.onChange = onChange; this.onTexture = onTexture;
    this.selected = null; this.urls = [];
  }

  disposeUrls() { for (const url of this.urls) URL.revokeObjectURL(url); this.urls = []; }

  async mutate(mutator, message = '素材库已更新') {
    const context = this.getContext(); const next = new Map(context.assets ?? []); const folders = new Set(context.folders ?? []);
    await mutator(next, folders);
    this.onChange(next, folders); this.notify(message, 'success'); this.render();
  }

  imagePath(file) {
    const relative = imageName(file.webkitRelativePath || file.name).replace(/^\/+/, '');
    return relative || file.name;
  }

  collectFolders(path, folders) {
    const parts = imageName(path).split('/'); parts.pop();
    for (let index = 1; index <= parts.length; index++) folders.add(parts.slice(0, index).join('/'));
  }

  addFiles(files) {
    const images = [...files].filter(file => IMAGE_EXTENSIONS.test(file.name));
    if (!images.length) return this.notify('没有找到支持的图片格式', 'warning');
    return this.mutate(async (next, folders) => {
      for (const file of images) {
        let path = this.imagePath(file); const bytes = new Uint8Array(await file.arrayBuffer());
        if (next.has(path)) { const dot = path.lastIndexOf('.'); const stem = dot < 0 ? path : path.slice(0, dot); const extension = dot < 0 ? '' : path.slice(dot); let index = 2; while (next.has(`${stem}-${index}${extension}`)) index++; path = `${stem}-${index}${extension}`; }
        next.set(path, bytes); this.collectFolders(path, folders);
      }
      this.selected = imageName(this.imagePath(images[0]));
    }, `已添加 ${images.length} 个图片素材`);
  }

  createFolder() {
    const content = showDialog('新建素材文件夹', '文件夹用于整理素材，名称只允许使用普通路径字符。');
    const input = document.createElement('input'); input.type = 'text'; input.placeholder = '例如：lines/season-1'; input.setAttribute('aria-label', '素材文件夹名称'); content.append(input);
    const apply = document.querySelector('#modal-apply'); apply.hidden = false; apply.onclick = () => {
      const name = imageName(input.value).replace(/^\/+|\/+$/g, '');
      if (!name || name.split('/').some(part => !part || part === '.' || part === '..')) { document.querySelector('#modal-error').textContent = '请输入有效的文件夹名称'; return; }
      this.mutate((next, folders) => { this.collectFolders(`${name}/placeholder.png`, folders); folders.add(name); }, '已新建素材文件夹').then(() => document.querySelector('#modal').close()).catch(error => { document.querySelector('#modal-error').textContent = error.message; });
    };
    input.focus();
  }

  renameImage(name) {
    const content = showDialog('重命名图片素材', '会同步更新引用该素材的判定线贴图。');
    const input = document.createElement('input'); input.type = 'text'; input.value = name; input.setAttribute('aria-label', '新素材名称'); content.append(input);
    const apply = document.querySelector('#modal-apply'); apply.hidden = false; apply.onclick = () => {
      const nextName = imageName(input.value).replace(/^\/+|\/+$/g, '');
      if (!nextName || !IMAGE_EXTENSIONS.test(nextName) || nextName.includes('..')) { document.querySelector('#modal-error').textContent = '请输入带图片扩展名的有效名称'; return; }
      this.mutate((next, folders) => {
        if (nextName !== name && next.has(nextName)) throw new Error('目标文件名已存在');
        const bytes = next.get(name); next.delete(name); next.set(nextName, bytes); this.collectFolders(nextName, folders);
        this.onTexture(name, nextName);
        this.selected = nextName;
      }, '已重命名图片素材').then(() => document.querySelector('#modal').close()).catch(error => { document.querySelector('#modal-error').textContent = error.message; });
    };
    input.focus();
  }

  editImage(name) {
    const bytes = this.getContext().assets.get(name); if (!bytes) return;
    const content = showDialog('编辑图片素材', '支持旋转、翻转和亮度调整；应用后保存为 PNG。');
    const canvas = document.createElement('canvas'); canvas.className = 'asset-editor-canvas'; content.append(canvas);
    const controls = document.createElement('div'); controls.className = 'asset-editor-controls';
    const rotation = document.createElement('select'); [['0', '旋转 0°'], ['90', '旋转 90°'], ['180', '旋转 180°'], ['270', '旋转 270°']].forEach(([value, label]) => rotation.append(new Option(label, value)));
    const flip = document.createElement('select'); [['none', '不翻转'], ['x', '水平翻转'], ['y', '垂直翻转']].forEach(([value, label]) => flip.append(new Option(label, value)));
    const brightness = document.createElement('input'); brightness.type = 'range'; brightness.min = 0; brightness.max = 200; brightness.value = 100; brightness.setAttribute('aria-label', '亮度');
    controls.append(rotation, flip, brightness); content.append(controls);
    const source = new Image(); const url = createUrl(bytes, name); this.urls.push(url); source.src = url;
    const draw = () => {
      if (!source.naturalWidth) return;
      const angle = Number(rotation.value); const quarter = angle % 180 !== 0; const width = quarter ? source.naturalHeight : source.naturalWidth; const height = quarter ? source.naturalWidth : source.naturalHeight;
      canvas.width = Math.min(900, width); canvas.height = Math.min(650, height); const context = canvas.getContext('2d'); context.save(); context.translate(canvas.width / 2, canvas.height / 2); context.rotate(angle * Math.PI / 180); const scale = Math.min(canvas.width / source.naturalWidth, canvas.height / source.naturalHeight); context.scale((flip.value === 'x' ? -1 : 1) * scale, (flip.value === 'y' ? -1 : 1) * scale); context.filter = `brightness(${brightness.value}%)`; context.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2); context.restore();
    };
    source.onload = draw; rotation.onchange = draw; flip.onchange = draw; brightness.oninput = draw;
    const apply = document.querySelector('#modal-apply'); apply.hidden = false; apply.onclick = async () => {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) { document.querySelector('#modal-error').textContent = '图片导出失败'; return; }
      const editedName = /\.png$/i.test(name) ? name : name.replace(/\.[^.]+$/, '') + '.png';
      const updated = new Uint8Array(await blob.arrayBuffer());
      await this.mutate((next, folders) => { next.delete(name); next.set(editedName, updated); this.selected = editedName; this.collectFolders(editedName, folders); this.onTexture(name, editedName); }, '图片编辑已应用');
      document.querySelector('#modal').close();
    };
  }

  boundLines(name) {
    const context = this.getContext(); const normalized = imageName(name).toLowerCase(); const base = normalized.split('/').at(-1);
    return (context.chart?.judgeLineList ?? []).flatMap((line, index) => {
      const texture = imageName(line.Texture ?? '').toLowerCase();
      return texture === normalized || texture.split('/').at(-1) === base ? [String(index)] : [];
    });
  }

  render() {
    const context = this.getContext(); if (!context) return; this.disposeUrls(); this.host.replaceChildren();
    const title = document.createElement('div'); title.className = 'panel-title'; const count = document.createElement('small'); count.textContent = `${imageEntries(context.assets).length} 张图片`; title.append('素材库', count); this.host.append(title);
    const actions = document.createElement('div'); actions.className = 'asset-library-actions';
    const add = document.createElement('button'); add.type = 'button'; add.textContent = '添加图片'; const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.hidden = true; input.onchange = () => this.addFiles(input.files); add.onclick = () => input.click();
    const scan = document.createElement('button'); scan.type = 'button'; scan.textContent = '扫描文件夹'; const directory = document.createElement('input'); directory.type = 'file'; directory.multiple = true; directory.webkitdirectory = true; directory.hidden = true; directory.onchange = () => this.addFiles(directory.files); scan.onclick = () => directory.click();
    const folder = document.createElement('button'); folder.type = 'button'; folder.textContent = '新建文件夹'; folder.onclick = () => this.createFolder(); actions.append(add, scan, folder); this.host.append(actions); this.host.append(input, directory);
    const tree = document.createElement('div'); tree.className = 'asset-tree'; const entries = imageEntries(context.assets).sort(([left], [right]) => left.localeCompare(right));
    const root = { folders: new Map(), files: [] }; const ensureFolder = (node, parts) => { for (const part of parts) { if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] }); node = node.folders.get(part); } return node; };
    for (const folderPath of context.folders ?? []) ensureFolder(root, imageName(folderPath).split('/').filter(Boolean));
    for (const [name, bytes] of entries) { const parts = imageName(name).split('/'); const file = parts.pop(); ensureFolder(root, parts).files.push([name, file, bytes]); }
    const createRow = ([name, file, bytes]) => {
      const row = document.createElement('button'); row.type = 'button'; row.className = `asset-row${this.selected === name ? ' selected' : ''}`; const url = createUrl(bytes, name); this.urls.push(url); const thumb = document.createElement('img'); thumb.src = url; thumb.alt = file; const label = document.createElement('span'); label.textContent = file; const bindings = this.boundLines(name); const usage = document.createElement('small'); usage.textContent = bindings.length ? `绑定：${bindings.join('、')}` : '未绑定'; row.append(thumb, label, usage); row.title = bindings.length ? bindings.join('、') : '未绑定判定线'; row.onclick = () => { this.selected = name; this.onTexture(name); this.render(); }; return row;
    };
    const countFiles = node => node.files.length + [...node.folders.values()].reduce((sum, child) => sum + countFiles(child), 0);
    const renderNode = (node, label, rootNode = false) => {
      const group = document.createElement('details'); group.open = true; group.className = 'asset-folder'; const summary = document.createElement('summary'); summary.textContent = `${label} · ${countFiles(node)} 张`; group.append(summary);
      if (node.files.length) { const rows = document.createElement('div'); rows.className = 'asset-folder-items'; node.files.forEach(file => rows.append(createRow(file))); group.append(rows); }
      for (const [childName, child] of [...node.folders.entries()].sort(([left], [right]) => left.localeCompare(right))) group.append(renderNode(child, childName));
      return group;
    };
    if (entries.length || (context.folders ?? []).length) tree.append(renderNode(root, '根目录', true));
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = '暂无图片素材。可以添加图片或扫描一个文件夹。'; tree.append(empty); }
    this.host.append(tree);
    if (this.selected && context.assets.has(this.selected)) this.renderDetails(this.selected, context.assets.get(this.selected));
  }

  renderDetails(name, bytes) {
    const details = document.createElement('div'); details.className = 'asset-details'; const image = document.createElement('img'); const url = createUrl(bytes, name); this.urls.push(url); image.src = url; image.alt = name; const heading = document.createElement('strong'); heading.textContent = name; const usage = document.createElement('p'); usage.textContent = this.boundLines(name).length ? `绑定判定线：${this.boundLines(name).join('、')}` : '当前没有判定线使用此素材'; const actions = document.createElement('div'); actions.className = 'asset-detail-actions'; for (const [label, callback] of [['重命名', () => this.renameImage(name)], ['编辑图片', () => this.editImage(name)], ['删除', () => this.mutate((next) => { next.delete(name); this.selected = null; }, '图片素材已删除')]]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = callback; actions.append(button); } details.append(heading, image, usage, actions); this.host.append(details);
  }
}

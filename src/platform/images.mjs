import { assetBytes, resourceReferences, mediaType } from './files.mjs';

export class ProjectImages {
  constructor(invalidate, report = () => {}) { this.invalidate = invalidate; this.report = report; this.images = new Map(); this.generation = 0; this.background = null; }

  async load(chart, assets, chartName, info) {
    const generation = ++this.generation;
    this.images.clear(); this.background = null;
    const references = resourceReferences(chart, assets, chartName, info);
    const names = new Set([references.background, ...(chart.judgeLineList ?? []).map(line => line.Texture)].filter(Boolean));
    await Promise.all([...names].map(async name => {
      const bytes = assetBytes(assets, name, chartName);
      if (!bytes) { if (name !== 'line.png') this.report(`未找到图片：${name}`); return; }
      const url = URL.createObjectURL(new Blob([bytes], { type: mediaType(name) }));
      try {
        const image = new Image(); image.src = url; await image.decode();
        if (generation !== this.generation) return;
        this.images.set(name, image);
        if (name === references.background) this.background = image;
      } catch { if (generation === this.generation) this.report(`图片无法解码：${name}，请检查文件内容或改用 PNG/JPEG/WebP`); }
      finally { URL.revokeObjectURL(url); }
    }));
    if (generation === this.generation) this.invalidate();
  }

  clear() { this.generation++; this.images.clear(); this.background = null; }
}

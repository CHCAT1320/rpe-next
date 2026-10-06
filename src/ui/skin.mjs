import { assetUrl } from '../core/asset-url.mjs';

const names = { 1: 'Tap2', 2: 'HoldHead', 3: 'Flick2', 4: 'Drag2' };
const highlights = { 1: 'Tap2HL', 2: 'HoldHeadHL', 3: 'Flick2HL', 4: 'DragHL' };

export class RpeSkin {
  constructor(invalidate) { this.images = new Map(); this.tints = new Map(); this.sourceIds = new WeakMap(); this.nextSourceId = 1; this.invalidate = invalidate; }

  async load() {
    await Promise.all([...new Set([...Object.values(names), ...Object.values(highlights), 'Hold', 'Hold3', 'HoldHL', 'HoldEnd', 'line', 'Pause', 'Arrow2', ...Array.from({ length: 31 }, (unused, index) => `img-${index + 1}`)])].map(async name => {
      const picture = new Image(); picture.src = assetUrl(`rpe/Texture/${name}.png`);
      try { await picture.decode(); this.images.set(name, picture); } catch { return; }
    }));
    this.invalidate();
  }

  tinted(name, color) {
    const picture = this.images.get(name);
    if (!picture) return null;
    const rgb = color.map(value => Math.round(Math.max(0, Math.min(255, value))));
    const key = `${name}:${rgb.join(',')}`;
    if (!this.tints.has(key)) {
      if (this.tints.size >= 192) this.tints.delete(this.tints.keys().next().value);
      const canvas = document.createElement('canvas'); canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(picture, 0, 0);
      context.globalCompositeOperation = 'multiply'; context.fillStyle = `rgb(${rgb.join(',')})`; context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = 'destination-in'; context.drawImage(picture, 0, 0);
      this.tints.set(key, canvas);
    }
    return this.tints.get(key);
  }

  tintedSource(name, source, color) {
    if (!source) return null;
    const rgb = color.map(value => Math.round(Math.max(0, Math.min(255, value))));
    if (rgb.every(value => value === 255)) return source;
    if (!this.sourceIds.has(source)) this.sourceIds.set(source, this.nextSourceId++);
    const key = `source:${name}:${this.sourceIds.get(source)}:${rgb.join(',')}`;
    if (!this.tints.has(key)) {
      if (this.tints.size >= 192) this.tints.delete(this.tints.keys().next().value);
      const width = source.naturalWidth ?? source.width; const height = source.naturalHeight ?? source.height;
      if (!width || !height) return source;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); context.drawImage(source, 0, 0);
      context.globalCompositeOperation = 'multiply'; context.fillStyle = `rgb(${rgb.join(',')})`; context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = 'destination-in'; context.drawImage(source, 0, 0);
      this.tints.set(key, canvas);
    }
    return this.tints.get(key);
  }

  head(context, type, horizontal, vertical, width, highlight = false, color) {
    const name = (highlight ? highlights : names)[type];
    const picture = this.images.get(name);
    if (!picture) return false;
    const height = Math.max(5, width * picture.naturalHeight / picture.naturalWidth);
    const customTint = Array.isArray(color) && color.length === 3 && color.every(Number.isFinite) && color.some(value => value !== 255);
    context.drawImage(customTint ? this.tinted(name, color) : picture, horizontal - width / 2, vertical - height / 2, width, height);
    return true;
  }

  hold(context, horizontal, head, tail, width, highlight = false, showHead = true, color) {
    const bodyName = highlight ? 'HoldHL' : this.images.has('Hold3') ? 'Hold3' : 'Hold';
    const body = this.images.get(bodyName);
    const end = this.images.get('HoldEnd');
    if (!body) return false;
    const direction = tail <= head ? 1 : -1;
    const headPicture = this.images.get(highlight ? 'HoldHeadHL' : 'HoldHead');
    const customTint = Array.isArray(color) && color.length === 3 && color.every(Number.isFinite) && color.some(value => value !== 255);
    const texture = name => customTint ? this.tinted(name, color) : this.images.get(name);
    const unit = width / body.naturalWidth;
    context.save(); context.translate(horizontal, head); context.scale(1, direction);
    context.drawImage(texture(bodyName), -width / 2, -Math.abs(tail - head), width, Math.max(1, Math.abs(tail - head)));
    if (end) context.drawImage(texture('HoldEnd'), -end.naturalWidth * unit / 2, -Math.abs(tail - head) - end.naturalHeight * unit, end.naturalWidth * unit, end.naturalHeight * unit);
    if (showHead && headPicture) context.drawImage(texture(highlight ? 'HoldHeadHL' : 'HoldHead'), -headPicture.naturalWidth * unit / 2, 0, headPicture.naturalWidth * unit, headPicture.naturalHeight * unit);
    context.restore();
    return true;
  }
}

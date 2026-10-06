import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const root = new URL('../', import.meta.url).pathname.replace(/^\//, '').replace(/\//g, '\\');
const textureRoot = join(root, 'assets', 'rpe', 'Texture');
const soundRoot = join(root, 'assets', 'rpe', 'SE');
const clamp = value => Math.max(0, Math.min(1, value));
const blend = (pixels, index, red, green, blue, alpha) => {
  const sourceAlpha = clamp(alpha); if (!sourceAlpha) return;
  const destinationAlpha = pixels[index + 3] / 255; const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (!outputAlpha) return;
  pixels[index] = Math.round((red * sourceAlpha + pixels[index] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 1] = Math.round((green * sourceAlpha + pixels[index + 1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 2] = Math.round((blue * sourceAlpha + pixels[index + 2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 3] = Math.round(outputAlpha * 255);
};
const canvas = (width, height, draw) => { const pixels = Buffer.alloc(width * height * 4); draw(pixels, width, height); return { width, height, pixels }; };
const rounded = (pixels, width, height, left, top, right, bottom, radius, color, alpha = 1) => {
  const centerX = (left + right) / 2; const centerY = (top + bottom) / 2; const halfX = Math.max(0, (right - left) / 2 - radius); const halfY = Math.max(0, (bottom - top) / 2 - radius);
  const startX = Math.max(0, Math.floor(left - 2)); const endX = Math.min(width, Math.ceil(right + 2)); const startY = Math.max(0, Math.floor(top - 2)); const endY = Math.min(height, Math.ceil(bottom + 2));
  for (let y = startY; y < endY; y++) for (let x = startX; x < endX; x++) {
    const qx = Math.abs(x - centerX) - halfX; const qy = Math.abs(y - centerY) - halfY; const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    const coverage = clamp(0.5 - outside); if (coverage > 0) blend(pixels, (y * width + x) * 4, ...color, alpha * coverage);
  }
};
const diamond = (pixels, width, height, centerX, centerY, radius, color, alpha = 1) => {
  const left = Math.max(0, Math.floor(centerX - radius)); const right = Math.min(width, Math.ceil(centerX + radius)); const top = Math.max(0, Math.floor(centerY - radius)); const bottom = Math.min(height, Math.ceil(centerY + radius));
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) { const coverage = clamp(1 - (Math.abs(x - centerX) + Math.abs(y - centerY)) / radius); if (coverage > 0) blend(pixels, (y * width + x) * 4, ...color, alpha * coverage); }
};
const writePng = (file, image) => {
  const crcTable = writePng.crcTable ??= Array.from({ length: 256 }, (unused, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
  const crc = data => { let value = 0xffffffff; for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const result = Buffer.alloc(12 + data.length); result.writeUInt32BE(data.length, 0); body.copy(result, 4); result.writeUInt32BE(crc(body), data.length + 8); return result; };
  const rows = Buffer.alloc((image.width * 4 + 1) * image.height); for (let y = 0; y < image.height; y++) { rows[(image.width * 4 + 1) * y] = 0; image.pixels.copy(rows, (image.width * 4 + 1) * y + 1, image.width * 4 * y, image.width * 4 * (y + 1)); }
  const header = Buffer.alloc(13); header.writeUInt32BE(image.width, 0); header.writeUInt32BE(image.height, 4); header[8] = 8; header[9] = 6;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
};
const head = (width, height, color, highlight = false) => canvas(width, height, (pixels, w, h) => { rounded(pixels, w, h, w * 0.08, h * 0.22, w * 0.92, h * 0.78, h * 0.28, [255, 255, 255], highlight ? 0.72 : 0.9); rounded(pixels, w, h, w * 0.12, h * 0.3, w * 0.88, h * 0.7, h * 0.2, color, 1); if (highlight) rounded(pixels, w, h, w * 0.2, h * 0.38, w * 0.8, h * 0.62, h * 0.12, [255, 247, 196], 0.8); });
const holdBody = (width, height, color, highlight = false) => canvas(width, height, (pixels, w, h) => { rounded(pixels, w, h, w * 0.12, 0, w * 0.88, h, w * 0.2, [255, 255, 255], highlight ? 0.3 : 0.2); for (let y = 0; y < h; y++) { const mix = 0.5 + 0.5 * Math.sin(y / h * Math.PI * 5); const tint = color.map((value, index) => Math.round(value * (0.82 + mix * 0.18) + (index === 0 ? 255 : 0) * mix * 0.08)); rounded(pixels, w, h, w * 0.18, y, w * 0.82, y + 2, 1, tint, 0.85); } rounded(pixels, w, h, w * 0.24, h * 0.02, w * 0.76, h * 0.98, w * 0.12, color, 0.42); });
const noteAssets = {
  Tap2: head(1089, 100, [35, 194, 235]), Tap2HL: head(1089, 200, [255, 218, 92], true),
  Drag2: head(1089, 60, [60, 218, 133]), DragHL: head(1089, 160, [151, 255, 194], true),
  Flick2: head(1089, 200, [239, 93, 194]), Flick2HL: head(1089, 300, [255, 175, 239], true),
  Hold: holdBody(989, 1900, [38, 192, 235]), Hold3: holdBody(1089, 1900, [33, 215, 203]), HoldHL: holdBody(1086, 1900, [255, 207, 83], true),
  HoldHead: head(1089, 50, [38, 192, 235]), HoldHeadHL: head(1086, 99, [255, 207, 83], true), HoldEnd: head(1089, 50, [38, 192, 235]),
};
for (const [name, image] of Object.entries(noteAssets)) writePng(join(textureRoot, `${name}.png`), image);
const effectSizes = [24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24];
for (let frame = 1; frame <= 31; frame++) {
  const width = frame >= 25 && frame <= 30 ? 259 : frame === 31 ? 169 : 255; const height = frame === 31 ? 169 : 256; const progress = (frame - 1) / 30; const image = canvas(width, height, (pixels, w, h) => {
    const centerX = w / 2; const centerY = h / 2; const radius = 14 + progress * Math.min(w, h) * 0.42; const ringWidth = Math.max(3, 18 * (1 - progress));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const distance = Math.hypot(x - centerX, y - centerY); const ring = clamp(1 - Math.abs(distance - radius) / ringWidth); const glow = clamp(1 - distance / (radius + 36)) * 0.16; if (ring > 0 || glow > 0) blend(pixels, (y * w + x) * 4, 255, 220 - Math.round(progress * 50), 120 + Math.round(progress * 90), Math.max(ring * (0.85 - progress * 0.35), glow)); }
    for (let ray = 0; ray < 12; ray++) { const angle = ray * Math.PI / 6 + progress * 0.5; const distance = 24 + progress * 72; diamond(pixels, w, h, centerX + Math.cos(angle) * distance, centerY + Math.sin(angle) * distance, 10 * (1 - progress * 0.5), [255, 239, 172], 0.55 * (1 - progress * 0.6)); }
  });
  writePng(join(textureRoot, `img-${frame}.png`), image);
}
const wav = (name, duration, tone) => { const sampleRate = 44100; const count = Math.round(sampleRate * duration); const samples = new Int16Array(count); for (let index = 0; index < count; index++) { const time = index / sampleRate; const value = tone(time, duration); samples[index] = Math.max(-32767, Math.min(32767, Math.round(value * 28000))); } const data = Buffer.alloc(44 + samples.byteLength); data.write('RIFF', 0); data.writeUInt32LE(36 + samples.byteLength, 4); data.write('WAVE', 8); data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples.byteLength, 40); for (let index = 0; index < samples.length; index++) data.writeInt16LE(samples[index], 44 + index * 2); const folder = mkdtempSync(join(tmpdir(), 'rpe-safe-')); const input = join(folder, `${name}.wav`); const output = join(soundRoot, `${name}.ogg`); writeFileSync(input, data); execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', input, '-c:a', 'libvorbis', '-q:a', '4', output]); };
wav('tap', 0.09, (time, duration) => Math.sin(2 * Math.PI * (920 - 280 * time / duration) * time) * Math.exp(-time * 34));
wav('drag', 0.14, (time, duration) => (Math.sin(2 * Math.PI * (340 + 520 * time / duration) * time) * 0.7 + Math.sin(2 * Math.PI * 1170 * time) * 0.18) * Math.exp(-time * 17));
wav('flick', 0.13, (time, duration) => (Math.sin(2 * Math.PI * (1250 - 650 * time / duration) * time) + Math.sin(2 * Math.PI * 2100 * time) * 0.22) * Math.exp(-time * 23));
const manifestFile = join(root, 'assets', 'rpe', 'manifest.json'); const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); manifest.source = 'Generated replacement assets for public distribution; local builds may use the original RPE resources.'; const replaced = new Set([...Object.keys(noteAssets).map(name => `Texture/${name}.png`), ...Array.from({ length: 31 }, (unused, index) => `Texture/img-${index + 1}.png`), 'SE/tap.ogg', 'SE/drag.ogg', 'SE/flick.ogg']); for (const entry of manifest.files) if (replaced.has(entry.path)) { const bytes = readFileSync(join(root, 'assets', 'rpe', entry.path)); entry.bytes = bytes.length; entry.sha256 = createHash('sha256').update(bytes).digest('hex'); } writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

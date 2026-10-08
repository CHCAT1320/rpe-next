import { assetBytes, resourceReferences, mediaType } from './files.mjs';

export async function projectThumbnail(project) {
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
  const assets = new Map(project.assets); const reference = resourceReferences(project.chart, assets, project.chartName, project.info).background;
  const bytes = assetBytes(assets, reference, project.chartName); if (!bytes) return null;
  const blob = new Blob([bytes], { type: mediaType(reference) });
  let url; let image;
  try {
    if (typeof document === 'undefined') image = await createImageBitmap(blob);
    else { url = URL.createObjectURL(blob); image = new Image(); image.src = url; await image.decode(); }
    const canvas = typeof document === 'undefined' ? new OffscreenCanvas(480, 270) : document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
    const width = image.naturalWidth ?? image.width; const height = image.naturalHeight ?? image.height;
    const ratio = Math.max(canvas.width / width, canvas.height / height);
    canvas.getContext('2d').drawImage(image, (480 - width * ratio) / 2, (270 - height * ratio) / 2, width * ratio, height * ratio);
    if (canvas.convertToBlob) return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  } catch { return null; } finally { if (url) URL.revokeObjectURL(url); image?.close?.(); }
}

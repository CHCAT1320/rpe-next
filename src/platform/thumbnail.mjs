import { assetBytes, resourceReferences, mediaType } from './files.mjs';

export async function projectThumbnail(project) {
  if (typeof document === 'undefined') return null;
  const assets = new Map(project.assets); const reference = resourceReferences(project.chart, assets, project.chartName, project.info).background;
  const bytes = assetBytes(assets, reference, project.chartName); if (!bytes) return null;
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType(reference) }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
    const ratio = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    canvas.getContext('2d').drawImage(image, (480 - image.naturalWidth * ratio) / 2, (270 - image.naturalHeight * ratio) / 2, image.naturalWidth * ratio, image.naturalHeight * ratio);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

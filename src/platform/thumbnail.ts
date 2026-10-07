import { assetBytes, resourceReferences, mediaType } from './files.ts';
import type { ArchiveEntries } from './archive.ts';
import type { StoredProject } from './library.ts';

/**
 * Renders a project's illustration into a small JPEG for the chart library.
 *
 * The image is centre-cropped to 16:9 rather than letterboxed, so every card in the library grid
 * has the same composition. Any failure — no illustration, undecodable bytes, no canvas — yields
 * `null`, because a missing thumbnail is a normal state and not an error worth surfacing.
 */
export async function projectThumbnail(project: StoredProject): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const assets: ArchiveEntries = new Map(project.assets);
  const reference = resourceReferences(project.chart, assets, project.chartName, project.info).background;
  const bytes = assetBytes(assets, reference, project.chartName); if (!bytes) return null;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType(reference) }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
    const ratio = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    canvas.getContext('2d')!.drawImage(image, (480 - image.naturalWidth * ratio) / 2, (270 - image.naturalHeight * ratio) / 2, image.naturalWidth * ratio, image.naturalHeight * ratio);
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

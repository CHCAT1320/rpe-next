import { parseChart } from './chart.mjs';
import { parseLegacyChart } from './legacy-chart.mjs';
import { parsePecChart } from './pec-chart.mjs';
import { parseOfficialChart } from './official-chart.mjs';

export function parseDocument(text) {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  if (trimmed.startsWith('{')) {
    const candidate = JSON.parse(trimmed);
    return candidate.formatVersion && !candidate.META ? parseOfficialChart(candidate) : parseChart(trimmed);
  }
  const bpm = trimmed.split(/\r?\n/).find(row => /^bp\s/.test(row.trim()));
  return bpm?.trim().split(/\s+/).length === 5 ? parseLegacyChart(trimmed) : parsePecChart(trimmed);
}

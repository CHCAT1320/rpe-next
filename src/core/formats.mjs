import { parseChart } from './chart.mjs';
import { integerChartAlpha } from './alpha-values.mjs';
import { parseLegacyChart } from './legacy-chart.mjs';
import { parsePecChart } from './pec-chart.mjs';
import { parseOfficialChart } from './official-chart.mjs';

export function parseDocument(text) {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  if (trimmed.startsWith('{')) {
    const candidate = JSON.parse(trimmed);
    return candidate.formatVersion && !candidate.META ? integerChartAlpha(parseOfficialChart(candidate)) : parseChart(trimmed);
  }
  const bpm = trimmed.split(/\r?\n/).find(row => /^bp\s/.test(row.trim()));
  return integerChartAlpha(bpm?.trim().split(/\s+/).length === 5 ? parseLegacyChart(trimmed) : parsePecChart(trimmed));
}

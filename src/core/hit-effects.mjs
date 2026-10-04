import { upperBound } from './beat.mjs';

export const HOLD_HIT_INTERVAL = 20 / 120;

export function recentHits(runtime, seconds, since, lifetime = 2 / 3) {
  const first = upperBound(runtime.hitTimes, Math.max(seconds - lifetime, since), entry => entry.start);
  const last = upperBound(runtime.hitTimes, seconds, entry => entry.start);
  const hits = runtime.hitTimes.slice(first, last).filter(entry => entry.note.type !== 2 && !entry.note.isFake).map((entry, index) => ({ entry, time: entry.start, seed: first + index }));
  for (const { item: entry, index } of runtime.holdIndex.query(seconds - lifetime, seconds)) {
    if (entry.note.isFake) continue;
    const firstPulse = Math.max(0, Math.floor((Math.max(seconds - lifetime, since) - entry.start) / HOLD_HIT_INTERVAL) + 1);
    const lastPulse = Math.min(Math.floor((seconds - entry.start) / HOLD_HIT_INTERVAL), Math.ceil((entry.end - entry.start) / HOLD_HIT_INTERVAL) - 1);
    for (let pulse = firstPulse; pulse <= lastPulse; pulse++) hits.push({ entry, time: entry.start + pulse * HOLD_HIT_INTERVAL, seed: index * 65537 + pulse });
  }
  return hits;
}

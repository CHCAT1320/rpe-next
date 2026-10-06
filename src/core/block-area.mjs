import { easing } from './easing.mjs';

// BlockArea runtime — a faithful port of Phigros 4.0.1 `PreviewBlockControl`.
//
// Two things deliberately do NOT follow the rest of rpe-next:
//
//  1. Times are SECONDS, not beat tuples. In the game a block's four times are compared
//     directly against `nowTime`, so block timing is independent of BPM. Converting to beats
//     would make blocks drift whenever the BPM list is edited (measured: a 120→150 BPM change
//     moves a block by −11.7 s), which the game never does. `tempo.beat()` is used only for UI.
//  2. The transform maths runs in the game's own screen space, not the editor's 1350x900 note
//     field. Blocks are defined by screen percentages and there is no defined relationship to
//     the note field, so `blockGeometry()` takes the aspect ratio and everything downstream
//     stays in that space. Renderers map it to pixels.

/** World height of the block screen space: `2 * orthographicSize`, and all block cameras use 5.0. */
export const BLOCK_SCREEN_HEIGHT = 10;

/** `disabledBlockShowDuration` / `disabledBlockReadyDuration` — both 0.5 s in the shipped level. */
export const BLOCK_READY_LEAD = 0.5;

/** Number of block easing curves (easeType 0..14). */
export const BLOCK_EASE_TYPES = 15;

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

// Nine of the fifteen block curves are already in rpe-next's easing table, so they are mapped
// instead of duplicated. Indices are rpe-next's `easing(progress, type)` types.
const EASE_MAP = { 0: 1, 1: 5, 2: 4, 4: 9, 5: 8, 7: 11, 8: 10, 10: 15, 11: 14 };

// These four lookup tables are never written by the game, so they stay at their zero initialiser
// and the eased progress is always 0: the segment holds its start value and snaps at the next
// event. Real charts rely on this — 3, 6 and 13 all appear in the only traceable block corpus.
const CONSTANT_ZERO = new Set([3, 6, 9, 13]);

/** easeType 14 is a table of ones: the segment jumps straight to the next value. */
const CONSTANT_ONE = 14;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

// easeType 12 is a downsampled hybrid, not a normal curve: samples 50..57 are never written (they
// stay 0, between two ~0.5 shelves) and samples 47..49 read source indices 102/104/106, i.e. past
// the end of the source table, so the real values are uninitialised heap. Only the shipped
// formulas are reproducible; the three out-of-range samples are clamped to the last valid source
// sample and marked approximate. easeType 12 does not occur in the only traceable block corpus.
const EASE_12 = buildEase12();

function buildEase12() {
  const table = new Array(101).fill(0);
  const inQuint = (index) => (index / 100) ** 5;
  const outQuint = (index) => 1 - (1 - index / 100) ** 5;
  const source = (index) => inQuint(Math.min(index, 100)); // index 102/104/106 clamped, see above
  for (let offset = 0; offset <= 49; offset++) table[offset] = source(8 + 2 * offset) * 0.5;
  for (let offset = 0; 58 + offset <= 100; offset++) table[58 + offset] = outQuint(8 + 2 * offset) * 0.5 + 0.5;
  table[100] = 1;
  return table;
}

function ease12(progress) {
  const position = clamp01(progress) * 100;
  const index = Math.min(99, Math.floor(position));
  return EASE_12[index] + (EASE_12[index + 1] - EASE_12[index]) * (position - index);
}

/**
 * The game's eased progress for a block curve.
 *
 * `behavior.md` says the block system calls `GetEaseWithProgress` (the entry that linearly
 * interpolates the 101-point table), while the decompiled `CalculateEasedProgress` names
 * `GetEaseWithIndex` (an int-indexed, non-interpolating entry). Taken literally the latter would
 * truncate progress to 0 or 1 and reduce every block motion to a binary snap, which contradicts
 * the decompiled table walk; the call site is assumed mislabelled. This port implements the
 * interpolating semantics. See the plan's §3.5 / §9-R1.
 */
export function blockEase(easeType, progress) {
  // The game casts the serialised easeType to int, so a fractional value floors rather than fails.
  const type = Math.floor(easeType);
  if (CONSTANT_ZERO.has(type)) return 0;
  if (type === CONSTANT_ONE) return 1;
  if (type === 12) return ease12(progress);
  const mapped = EASE_MAP[type];
  if (mapped === undefined) throw new Error(`blockEase: easeType ${easeType} 不在 0..14 内`);
  return easing(progress, mapped);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Port of `FindCurrentEventIndex`: the last index whose `time <= now`, clamped to `[-1, Count-2]`.
 * The comparison is strictly greater, so runs of equal timestamps select the last one. `-1` means
 * `now` precedes the first event and every caller must skip that list.
 */
export function findCurrentEventIndex(events, now) {
  if (!events?.length) return -1;
  let index = -1;
  for (;;) {
    if (events[index + 1].time > now) return index;
    index += 1;
    if (index + 2 >= events.length) return index;
  }
}

/** `CalculateEasedProgress` plus the callers' `Clamp01`. */
function easedProgress(cur, next, easeType, now) {
  // The game divides raw: equal timestamps would give ±Inf/NaN. Shipped data has none, and
  // validation only warns, so guard here instead of propagating NaN into the canvas.
  if (next.time === cur.time) return 1;
  return clamp01(blockEase(easeType, (now - cur.time) / (next.time - cur.time)));
}

const lerp = (from, to, amount) => from + (to - from) * amount;

/** Port of `SafeDiv`: a magnitude-degenerate denominator yields 1. */
function safeDiv(numerator, denominator) {
  const epsilon = Math.max(Math.abs(denominator) * 1e-6, 8 * Number.EPSILON);
  return Math.abs(denominator) < epsilon ? 1 : numerator / denominator;
}

// ---------------------------------------------------------------------------
// Geometry and transform
// ---------------------------------------------------------------------------

/** World-space viewport used by every block camera: `2 * orthographicSize` tall, `aspect` wide. */
export function blockScreen(aspect) {
  return { x: BLOCK_SCREEN_HEIGHT * aspect, y: BLOCK_SCREEN_HEIGHT };
}

/**
 * Port of `GetBlockGeometry` with the game's `anchor = (0.5, 0.5)`.
 * `size` is intentionally NOT absolute — `Mathf.Abs` is only applied when writing `localScale`.
 */
export function blockGeometry(block, aspect) {
  const screen = blockScreen(aspect);
  const toWorld = (percentage) => ({ x: (percentage.x - 0.5) * screen.x, y: (percentage.y - 0.5) * screen.y });
  const topRight = toWorld(block.topRightPercentage);
  const bottomLeft = toWorld(block.bottomLeftPercentage);
  return {
    screen,
    size: { x: topRight.x - bottomLeft.x, y: topRight.y - bottomLeft.y },
    center: { x: (bottomLeft.x + topRight.x) * 0.5, y: (bottomLeft.y + topRight.y) * 0.5 },
  };
}

const anchorWorld = (anchor, screen) => ({ x: (anchor.x - 0.5) * screen.x, y: (anchor.y - 0.5) * screen.y });

const scaleAround = (point, anchor, stepX, stepY) => ({
  x: anchor.x + (point.x - anchor.x) * stepX,
  y: anchor.y + (point.y - anchor.y) * stepY,
});

/** Port of `RotateAroundAnchor`: standard counter-clockwise, degrees. */
function rotateAround(point, anchor, deltaDegrees) {
  const epsilon = Math.max(Math.abs(deltaDegrees) * 1e-6, 8 * Number.EPSILON);
  if (Math.abs(deltaDegrees) < epsilon) return point;
  const radians = deltaDegrees * (Math.PI / 180);
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  return { x: anchor.x + (dx * cos - dy * sin), y: anchor.y + (dx * sin + dy * cos) };
}

/** Port of `InterpolateMoveEvent`: per-axis easing, then converted to world space. */
function interpolateMove(events, index, now, screen) {
  const last = events.length - 1;
  if (last <= index) return anchorWorld(events[index].endPosition, screen);
  const cur = events[index];
  const next = events[index + 1];
  const tx = easedProgress(cur, next, cur.easeTypeX, now);
  const ty = easedProgress(cur, next, cur.easeTypeY, now);
  return anchorWorld({
    x: lerp(cur.endPosition.x, next.endPosition.x, tx),
    y: lerp(cur.endPosition.y, next.endPosition.y, ty),
  }, screen);
}

/**
 * Port of `UpdateBlockAnimations`, i.e. `UpdateScale` → `UpdateRotation` → `UpdateMovement`.
 *
 * Each of the first two runs in two phases: a discrete, un-eased catch-up that walks every event
 * *before* the current one applying the full ratio/rotation delta around that event's anchor, then
 * the eased current segment. `size` is always `interpolated scale × originalSize` (absolute, never
 * accumulated), while `center` is pushed around by those anchor pivots. Movement is then a delta
 * from the *untransformed* rectangle centre, added on top of the transformed centre.
 *
 * Returns `{ center, size, rotation }` in block screen space; `size` may be negative.
 */
export function blockTransform(block, now, aspect) {
  const geo = blockGeometry(block, aspect);
  const { screen } = geo;
  let size = { ...geo.size };
  let center = { ...geo.center };
  let rotation = 0;

  // ---- SCALE ----
  const scales = block.scaleEvents ?? [];
  const scaleIndex = findCurrentEventIndex(scales, now);
  if (scaleIndex !== -1) {
    for (let i = 0; i < scaleIndex; i++) {
      center = scaleAround(center, anchorWorld(scales[i].anchor, screen),
        safeDiv(scales[i + 1].scale.x, scales[i].scale.x),
        safeDiv(scales[i + 1].scale.y, scales[i].scale.y));
    }
    if (scaleIndex >= scales.length - 1) {
      size = { x: scales[scaleIndex].scale.x * geo.size.x, y: scales[scaleIndex].scale.y * geo.size.y };
    } else {
      const cur = scales[scaleIndex];
      const next = scales[scaleIndex + 1];
      const tx = easedProgress(cur, next, cur.easeTypeX, now);
      const ty = easedProgress(cur, next, cur.easeTypeY, now);
      const interp = { x: lerp(cur.scale.x, next.scale.x, tx), y: lerp(cur.scale.y, next.scale.y, ty) };
      center = scaleAround(center, anchorWorld(cur.anchor, screen),
        safeDiv(interp.x, cur.scale.x), safeDiv(interp.y, cur.scale.y));
      size = { x: interp.x * geo.size.x, y: interp.y * geo.size.y };
    }
  }

  // ---- ROTATION ----
  const rotations = block.rotateEvents ?? [];
  const rotateIndex = findCurrentEventIndex(rotations, now);
  if (rotateIndex !== -1) {
    for (let i = 0; i < rotateIndex; i++) {
      center = rotateAround(center, anchorWorld(rotations[i].anchor, screen),
        rotations[i + 1].rotation - rotations[i].rotation);
    }
    if (rotateIndex >= rotations.length - 1) {
      rotation = rotations[rotateIndex].rotation;
    } else {
      const cur = rotations[rotateIndex];
      const next = rotations[rotateIndex + 1];
      rotation = lerp(cur.rotation, next.rotation, easedProgress(cur, next, cur.easeType, now));
      center = rotateAround(center, anchorWorld(cur.anchor, screen), rotation - cur.rotation);
    }
  }

  // ---- MOVEMENT ----
  const moves = block.moveEvents ?? [];
  const moveIndex = findCurrentEventIndex(moves, now);
  if (moves.length >= 1 && moveIndex !== -1) {
    const target = interpolateMove(moves, moveIndex, now, screen);
    center = { x: center.x + (target.x - geo.center.x), y: center.y + (target.y - geo.center.y) };
  }

  return { center, size, rotation, screen };
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/**
 * Which visual state a block is in, or `null` when it is hidden.
 *
 * The game only ever distinguishes two materials: `Active` uses the active one and every other
 * visible state falls back to `disabledLayer` — including the residual window between
 * `disableTime` and `disappearTime`. `Ready` adds a breathing overlay on top of the disabled look.
 */
export function blockState(block, now) {
  if (!(block.appearTime <= now && now < block.disappearTime)) return null;
  return {
    active: block.enableTime <= now && now < block.disableTime,
    ready: block.enableTime - BLOCK_READY_LEAD <= now && now < block.enableTime,
  };
}

/** `IsActive` — the only state that participates in hit testing. */
export function blockIsActive(block, time) {
  return block.enableTime <= time && block.disableTime > time;
}

/** Linear colour fade-in over `disabledBlockShowDuration`, expressed as 0..1 coverage. */
export function blockShowCoverage(block, now) {
  return clamp01((now - block.appearTime) / BLOCK_READY_LEAD);
}

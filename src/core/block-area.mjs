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

/**
 * `disabledBlockReadyDuration` (`0x5C`) — the width of the `Ready` window, and also how long
 * `DisabledBlockReady` waits before switching `readyLayer` → `enabledLayer`.
 */
export const BLOCK_READY_DURATION = 0.5;

/**
 * `disabledBlockShowDuration` (`0x58`) — the width of `DisabledBlockShow`'s colour fade-in, and
 * **nothing else**. It is a separate field from `BLOCK_READY_DURATION`; the shipped level happens to
 * set both to `0.5`, which is why they were once collapsed into one constant. Keeping them apart
 * matters as soon as a chart or level overrides either: with them merged, changing the show duration
 * would silently move the ready boundary too.
 */
export const BLOCK_SHOW_DURATION = 0.5;

/** Number of block easing curves (easeType 0..14). */
export const BLOCK_EASE_TYPES = 15;

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

// Nine of the fifteen block curves are already in rpe-next's easing table, so they are mapped
// instead of duplicated. Indices are rpe-next's `easing(progress, type)` types.
const EASE_MAP = { 0: 1, 1: 5, 2: 4, 4: 9, 5: 8, 7: 11, 8: 10, 10: 15, 11: 14 };

// `behavior.md` §2.1.1 records TWO definitions for the same 0..14 enum and says which one this
// repository implements:
//
//   A — APK fact (`GetEase.Instantiation`): the main loop runs for t = 1, 4, 7, 10 and downsamples
//       `t + 2` *inside that loop*, so 3/6/9/12 are all "composite" tables (halved decimation with a
//       50..57 zero break and three samples read out of bounds at 47..49). Only 13 is a dead table.
//   B — the community table, which the dump explicitly adopts for preview/reproduction because A is
//       an engine-bug artefact: 3/6/9/12 are the symmetric in-out curves.
//
// This port follows B. Types 3/6/9 reuse rpe-next's in-out curves; 12 has no equivalent in
// `easing.mjs`, so `inOutQuint` below supplies it. A's composite tables are deliberately NOT built:
// three of their samples are uninitialised heap and therefore not reproducible at all.
const EASE_MAP_IN_OUT = { 3: 7, 6: 12, 9: 13 };

/** easeType 12 under B: in-out-quint, the one in-out curve `easing.mjs` does not already carry. */
const inOutQuint = (progress) => (progress < 0.5
  ? 16 * progress ** 5
  : 1 - ((-2 * progress + 2) ** 5) / 2);

/**
 * The one table that really is constant. `behavior.md` v20 corrected an earlier reading that put
 * 3/6/9 here: the downsample runs for every `t`, not just `t = 10`, so those three are composite
 * tables in the APK and in-out curves under B. Only `13` is genuinely zero-initialised and never
 * written; `14` is the table of ones.
 */
const CONSTANT_ZERO = new Set([13]);

/** easeType 14 is a table of ones: the segment jumps straight to the next value. */
const CONSTANT_ONE = 14;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

/**
 * The game's eased progress for a block curve.
 *
 * The APK calls `GetEaseWithProgress`, which linearly interpolates a 101-point table built once at
 * startup; `behavior.md` §2.2 notes a formula is "almost equivalent" on `u ∈ [0, 1]` (max deviation
 * ~1e-4, from the table's per-0.01 interpolation) and that three behaviours must still be copied:
 * `13` stays 0, `14` stays 1, and the composite tables' break/out-of-range samples are not
 * reproducible. Following §2.1.1 this port uses the community curves for `3/6/9/12` rather than
 * those composite tables, so only the `13`/`14` rules carry over.
 */
export function blockEase(easeType, progress) {
  // The game casts the serialised easeType to int, so a fractional value floors rather than fails.
  const type = Math.floor(easeType);
  if (CONSTANT_ZERO.has(type)) return 0;
  if (type === CONSTANT_ONE) return 1;
  // `GetEaseWithProgress` clamps by index rather than by value: `i = (int)(progress * 100)`, then
  // `i < 0` reads `table[0]` and `i >= 100` reads `table[100]`. Since every table starts at 0 and
  // ends at 1, that is the same as clamping `progress` to [0, 1] before evaluating — and it is
  // reachable here, because `assertBlockAreas` deliberately does not require the four times (or the
  // event times) to be ordered, so a reversed segment yields a negative ratio. `easedProgress` also
  // clamps its *output*, which would not have caught this.
  const clamped = clamp01(progress);
  // NaN survives `clamp01`, and the game's cast turns it into `INT_MIN`, i.e. `table[0]`.
  if (Number.isNaN(clamped)) return 0;
  if (type === 12) return inOutQuint(clamped);
  const mapped = EASE_MAP[type] ?? EASE_MAP_IN_OUT[type];
  if (mapped === undefined) throw new Error(`blockEase: easeType ${easeType} 不在 0..14 内`);
  return easing(clamped, mapped);
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
 *
 * `null` also stands in for the game's "park it off-screen" case: the two hidden phases move
 * `localPosition` to `BLOCK_HIDDEN_POSITION` rather than changing the layer, so the block is still
 * alive and still drawn, just outside the viewport. Skipping it here is the same picture and skips
 * the transform work; `blockIsDestroyed` covers the point where the game stops tracking it at all.
 */
export function blockState(block, now) {
  if (!(block.appearTime <= now && now < block.disappearTime)) return null;
  return {
    active: block.enableTime <= now && now < block.disableTime,
    ready: block.enableTime - BLOCK_READY_DURATION <= now && now < block.enableTime,
  };
}

/** `IsActive` — the only state that participates in hit testing. */
export function blockIsActive(block, time) {
  return block.enableTime <= time && block.disableTime > time;
}

/**
 * `τ > max(disableTime, disappearTime) + destroyInterval`.
 *
 * The game destroys the block's GameObject after this, so the object is gone rather than hidden. Where
 * `BlockPhase` is used as a five-value enum this is `HiddenAfter`; here the caller simply stops
 * considering the block, which is the same visible result.
 */
export const BLOCK_DESTROY_INTERVAL = 5;
export function blockIsDestroyed(block, time) {
  return time > Math.max(block.disableTime, block.disappearTime) + BLOCK_DESTROY_INTERVAL;
}

/**
 * Where a block is parked while it is hidden.
 *
 * `UpdateBlocksTransform` puts `localPosition` at `x = 1000` when the block is outside
 * `[appearTime, disappearTime)` instead of switching its layer off, which parks it far outside the
 * orthographic viewport (world width ≈ 17.8 units). This port returns `null` from `blockState` for
 * exactly that window and its renderers skip the block, so the drawn result is identical; this
 * constant records the value the game uses so the equivalence is explicit rather than accidental.
 */
export const BLOCK_HIDDEN_POSITION = 1000;

/**
 * Linear colour fade-in over `disabledBlockShowDuration`, expressed as 0..1 coverage.
 *
 * The game drives this from the `DisabledBlockShow` coroutine, which only starts when a block *becomes
 * visible while already inside its enabled window*:
 * `visible && !wasVisible && !notInWindow`, i.e. `enableTime <= appearTime && appearTime < disableTime`.
 * Two consequences follow, and the frame-driven model has to reproduce both:
 *
 * - A block that appears **before** `enableTime` — every block in the shipped corpus — never runs the
 *   coroutine, so there is no fade at all: `UpdateBlockActivation` writes the alpha on that same frame.
 *   This used to return 0 for the first `disabledBlockShowDuration` of such a block, which made the
 *   whole `Disabled` phase invisible.
 * - A block that appears **inside** its own enabled window does fade, starting from the coroutine's
 *   first write.
 *
 * So the first case is a step rather than a ramp. The one situation this cannot express is a block that
 * appears, then leaves and re-enters its window: `!wasVisible` would fire again and the game would
 * re-run the coroutine, which needs per-frame history a pure function does not have. `isSubtract`
 * affects only the colour the caller interpolates towards, not the coverage itself.
 */
export function blockShowCoverage(block, now) {
  const appearsInsideWindow = block.appearTime >= block.enableTime && block.appearTime < block.disableTime;
  if (!appearsInsideWindow) return 1;
  return clamp01((now - block.appearTime) / BLOCK_SHOW_DURATION);
}

/**
 * Port of `GameInformation.BlockArea.Mirror()` (VA `0x1CA32A8`): a **horizontal** mirror that flips
 * `x` only and leaves every `y` alone.
 *
 * The corner assignment is the part that is easy to get wrong. It is a **crossed** complement, not an
 * independent per-corner flip:
 *
 * ```
 * tr.x' = 1 - bl.x        bl.x' = 1 - tr.x        // both read the ORIGINAL values
 * ```
 *
 * With the shipped `tr.x = 0.8, bl.x = 0.6` that gives `tr.x' = 0.4, bl.x' = 0.2` — the rectangle
 * keeps its width and flips about `x = 0.5`. Writing `tr.x' = 1 - tr.x, bl.x' = 1 - bl.x` instead
 * would give `0.2 / 0.4`, i.e. an *inverted* rectangle, and `blockGeometry` deliberately does not
 * take `Mathf.Abs`, so that would render as a negative-size block rather than failing loudly.
 *
 * The three event lists follow the same "complement about 0.5" rule, except that rotation is
 * **negated** rather than complemented, because an angle is not a coordinate:
 *
 * - `rotateEvents`: `anchor.x ← 1 - anchor.x` (self-complement) and `rotation ← -rotation`
 * - `moveEvents`: `endPosition.x ← 1 - endPosition.x` (self-complement)
 * - `scaleEvents`: `anchor.x ← 1 - anchor.x` (self-complement)
 *
 * Note "self-complement" only for the *events*: those read and write the same field, unlike the
 * corners above, which read each other's. Each list is null-checked before iteration, so a missing
 * list is skipped rather than throwing.
 *
 * Returns a new block; the input is not modified (the game mutates in place, but the editor's undo
 * history needs the pre-mirror document to stay intact).
 */
export function mirrorBlockArea(block) {
  const complement = (value) => 1 - value;
  const mirrorAnchor = (anchor) => (anchor ? { ...anchor, x: complement(anchor.x) } : anchor);
  return {
    ...block,
    topRightPercentage: { ...block.topRightPercentage, x: complement(block.bottomLeftPercentage.x) },
    bottomLeftPercentage: { ...block.bottomLeftPercentage, x: complement(block.topRightPercentage.x) },
    rotateEvents: block.rotateEvents?.map((event) => ({
      ...event,
      anchor: mirrorAnchor(event.anchor),
      rotation: -event.rotation,
    })),
    moveEvents: block.moveEvents?.map((event) => ({
      ...event,
      endPosition: { ...event.endPosition, x: complement(event.endPosition.x) },
    })),
    scaleEvents: block.scaleEvents?.map((event) => ({ ...event, anchor: mirrorAnchor(event.anchor) })),
  };
}

/** `Mirror()` over a whole `blockAreaList`. A missing or non-array list is passed through as-is. */
export function mirrorBlockAreas(blocks) {
  return Array.isArray(blocks) ? blocks.map(mirrorBlockArea) : blocks;
}

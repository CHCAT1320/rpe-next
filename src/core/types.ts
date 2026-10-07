// Shared domain types for the RPE chart format.
//
// These describe the on-disk document as faithfully as the RPE specification allows, which is
// deliberately loose in places: real charts in the wild omit optional fields, carry unknown
// `extended` sub-tracks from newer RPE builds, and store numbers as either integers or strings.
// The types therefore mark genuinely optional members optional and index the open-ended extension
// bags, rather than pretending the format is closed.
//
// Conversion and validation stay in `chart.ts` (`assertChart`); these types describe what the rest
// of the application may assume once a document has passed it.

/** A beat position, stored as `[whole, numerator, denominator]`. */
export type Beat = [whole: number, numerator: number, denominator: number];

/** An RGB colour, 0-255 per channel. */
export type Color = [red: number, green: number, blue: number];

/** The five event tracks every RPE judge line carries. */
export type EventType = 'moveXEvents' | 'moveYEvents' | 'rotateEvents' | 'alphaEvents' | 'speedEvents';

/** The extra tracks RPE stores under `extended`. */
export type ExtendedType =
  | 'scaleXEvents' | 'scaleYEvents' | 'colorEvents' | 'paintEvents'
  | 'textEvents' | 'inclineEvents' | 'gifEvents';

/** Every event track name the editor understands. */
export type AnyEventType = EventType | ExtendedType;

/** Note kinds, matching the RPE numeric codes. */
export type NoteType = 1 | 2 | 3 | 4;

/**
 * A value carried by an event. Scalar tracks store numbers, `colorEvents` stores a colour and
 * `textEvents` stores (or references) a string.
 */
export type EventValue = number | Color | string;

/**
 * A single easing event.
 *
 * `start`/`end` hold the track's values; `startTime`/`endTime` hold the beat range. The shader
 * extension stores non-numeric payloads in `start`/`end`, which is why they stay loosely typed.
 */
export interface ChartEvent {
  startTime: Beat;
  endTime: Beat;
  start: EventValue;
  end: EventValue;
  easingType: number;
  easingLeft: number;
  easingRight: number;
  bezier: number;
  bezierPoints: number[];
  linkgroup: number;
  /** Marks an instantaneous ("hooked") event, tolerated as either a boolean or 0/1. */
  inst?: boolean | number;
  /** Shader events identify their target and parameters through these. */
  shader?: string;
  shaderName?: string;
  order?: number;
  params?: unknown;
  [key: string]: unknown;
}

/** A note on a judge line. */
export interface Note {
  type: NoteType;
  startTime: Beat;
  endTime: Beat;
  positionX: number;
  /** 1 for above the line, 0 for below. */
  above?: number | boolean;
  isFake?: number | boolean;
  speed?: number;
  size?: number;
  yOffset?: number;
  visibleTime?: number;
  alpha?: number;
  /** Per-note tint, present on charts that blend a texture with a colour. */
  color?: Color;
  [key: string]: unknown;
}

/** A layer of event tracks. */
export type EventLayer = Partial<Record<AnyEventType, ChartEvent[]>>;

/** A control point on one of the line's interpolation curves. */
export interface ControlPoint {
  x: number;
  [property: string]: number;
}

/** A judge line, including the properties RPE adds beyond the base format. */
export interface JudgeLine {
  Name: string;
  Group: number;
  Texture: string;
  bpmfactor: number;
  father: number;
  rotateWithFather: boolean;
  isCover: number;
  zOrder: number;
  anchor: number[];
  isGif: boolean;
  eventLayers: EventLayer[];
  extended: EventLayer;
  notes: Note[];
  numOfNotes: number;
  /** UI element this line drives, when bound. */
  attachUI?: string;
  alphaControl?: ControlPoint[];
  posControl?: ControlPoint[];
  sizeControl?: ControlPoint[];
  skewControl?: ControlPoint[];
  yControl?: ControlPoint[];
  [key: string]: unknown;
}

/** Chart metadata. `RPEVersion` drives the compatibility notes shown in the editor. */
export interface ChartMeta {
  RPEVersion: number;
  name: string;
  composer: string;
  charter: string;
  illustration: string;
  level: string;
  song: string;
  background: string;
  /** Offset in milliseconds. */
  offset: number;
  [key: string]: unknown;
}

/** One tempo entry. */
export interface BpmEntry {
  bpm: number;
  startTime: Beat;
  [key: string]: unknown;
}

/** A complete RPE chart document. */
export interface Chart {
  META: ChartMeta;
  BPMList: BpmEntry[];
  judgeLineGroup: string[];
  judgeLineList: JudgeLine[];
  /**
   * Present when the document was imported from another format, so re-export can preserve it.
   *
   * Nothing is required beyond the open-ended bag: the JSON-derived formats keep their original
   * bytes in `text`, while the official v3 converter stores the parsed document in `document`, and
   * consumers only test for presence. Requiring `text` here would misdescribe those documents.
   */
  rpeNextLegacySource?: { [key: string]: unknown };
  [key: string]: unknown;
}

/** A point in time, in both beats and seconds, as used by the editor's cursor readouts. */
export interface TimePoint {
  beat: number;
  seconds: number;
}

/** A selection of notes, keyed by owning line then note index. */
export type NoteSelection = Map<number, Set<number>>;

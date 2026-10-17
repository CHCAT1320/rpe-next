import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNoteSkin } from '../src/core/note-skin.mjs';
import { ResourceNoteSkin } from '../src/ui/resource-note-skin.mjs';
import { RpeSkin } from '../src/ui/skin.mjs';
import { Timeline } from '../src/ui/timeline.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { createChart, createNote } from '../src/core/chart.mjs';
import { noteSkinFixture, pngHeader } from './fixtures/note-skin.mjs';

function skin(ratio = 1.5) {
  const files = noteSkinFixture();
  for (const [name, width, height] of [['click.png', 160, 40], ['click_mh.png', 160 * ratio, 40 * ratio],
    ['drag.png', 80, 20], ['drag_mh.png', 200, 50], ['flick.png', 192, 40], ['flick_mh.png', 256, 80], ['hold_mh.png', 240, 450]]) files.set(name, pngHeader(width, height));
  const record = parseNoteSkin(files);
  record.info.holdAtlasMH = [18, 27];
  const images = new Map(Object.entries(record.images).map(([name, size]) => [name, { naturalWidth: size.width, naturalHeight: size.height }]));
  const pack = new ResourceNoteSkin(record, images, (_name, source) => source), result = new RpeSkin(() => {});
  result.setResourcePack(pack); return result;
}
function context() { return new Proxy({ calls: [] }, { get(target, key) { return key in target ? target[key] : (...args) => target.calls.push([key, ...args]); } }); }
const drawn = context => context.calls.filter(call => call[0] === 'drawImage').map(call => call.slice(-4));

test('resource highlight scale uses the shared Tap width ratio for Tap, Drag, Flick and Hold rather than normalizing away padding', () => {
  const runtime = skin();
  assert.equal(runtime.noteScale(false), 1); assert.equal(runtime.noteScale(true), 1.5);
  for (const type of [1, 2, 3, 4]) {
    const normal = context(), highlighted = context();
    runtime.head(normal, type, 0, 0, 80, false, undefined, 0, 160);
    runtime.head(highlighted, type, 0, 0, 80, true, undefined, 0, 160);
    assert.equal(drawn(normal)[0][2], 80); assert.equal(drawn(highlighted)[0][2], 120);
  }
  const a = context(), b = context();
  runtime.head(a, 1, 0, 0, 80, false, undefined, 0, 160); runtime.head(b, 1, 0, 0, 80, true, undefined, 0, 160);
  assert.equal(drawn(a)[0][3], 40); assert.equal(drawn(b)[0][3], 60);
  runtime.setResourcePack(null); assert.equal(runtime.noteScale(true), 1);
});

test('highlight Hold scales its body width and both caps together while preserving duration, compact placement and width-only note size', () => {
  const runtime = skin();
  for (const compact of [false, true]) {
    runtime.resourcePack.info.holdCompact = compact;
    const normal = context(), highlighted = context(), wide = context();
    runtime.hold(normal, 0, 200, 20, 80, false, true, undefined, 80);
    runtime.hold(highlighted, 0, 200, 20, 80, true, true, undefined, 80);
    runtime.hold(wide, 0, 200, 20, 240, true, true, undefined, 80);
    const a = drawn(normal), b = drawn(highlighted), c = drawn(wide);
    assert.ok(b.every(rect => rect[2] === 120)); assert.ok(c.every(rect => rect[2] === 360));
    assert.equal(a[0][3], 180); assert.equal(b[0][3], 180);
    assert.equal(b[1][3], a[1][3] * 1.5); assert.equal(b[2][3], a[2][3] * 1.5);
    assert.deepEqual(c.map(rect => rect[3]), b.map(rect => rect[3]));
    assert.deepEqual(c.map(rect => rect[1]), b.map(rect => rect[1]));
  }
});

test('timeline hit testing and drag width follow highlighted texture bounds and the highlight display switch', () => {
  const canvas = () => ({ clientWidth: 600, clientHeight: 600, addEventListener() {}, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) });
  const chart = createChart(); chart.judgeLineList[0].notes = [createNote(1, 4, 0), createNote(4, 4, 500)];
  const session = new EditorSession(chart), timeline = new Timeline(canvas(), canvas(), () => session, () => {}, () => {});
  timeline.skin = skin(); timeline.origin = 4; timeline.simultaneous = new Set(session.notes);
  const note = session.notes[0], base = timeline.noteBaseWidth(note), x = timeline.noteHorizontal(0) + base * 0.65, y = timeline.vertical(4);
  assert.equal(timeline.noteWidth(note), base * 1.5);
  assert.equal(timeline.hit({ x, y })?.item, note);
  assert.equal(timeline.noteWidth({ ...note }, true), base * 1.5);
  timeline.highlight = false;
  assert.equal(timeline.noteWidth(note), base); assert.equal(timeline.hit({ x, y }), undefined);
});

test('equal-sized and smaller highlight textures retain their declared relative scale and switching packs resets it', () => {
  const same = skin(1), small = skin(0.75), large = skin();
  assert.equal(same.noteScale(true), 1); assert.equal(small.noteScale(true), 0.75);
  large.setResourcePack(same.resourcePack); assert.equal(large.noteScale(true), 1);
  large.setResourcePack(null); assert.equal(large.noteScale(true), 1);
});

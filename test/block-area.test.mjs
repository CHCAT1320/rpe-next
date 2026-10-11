import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  blockEase, findCurrentEventIndex, blockGeometry, blockTransform, blockState,
  blockIsActive, blockShowCoverage, blockScreen, BLOCK_SCREEN_HEIGHT, BLOCK_EASE_TYPES,
  blockIsDestroyed, BLOCK_HIDDEN_POSITION, mirrorBlockArea, mirrorBlockAreas,
} from '../src/core/block-area.mjs';
import { easing } from '../src/core/easing.mjs';
import { createChart, parseChart, serializeChart, assertChart } from '../src/core/chart.mjs';
import { parseDocument } from '../src/core/formats.mjs';
import { Preview } from '../src/ui/preview.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/block-area.json', import.meta.url), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const closeTo = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''}: ${actual} != ${expected}`);

function plainBlock(overrides = {}) {
  return {
    topRightPercentage: { x: 0.8, y: 0.8 },
    bottomLeftPercentage: { x: 0.6, y: 0.6 },
    appearTime: 0, enableTime: 1, disableTime: 2, disappearTime: 3,
    isSubtract: false,
    rotateEvents: [{ anchor: { x: 0.7, y: 0.7 }, time: 0, easeType: 0, rotation: 0 }],
    moveEvents: [{ endPosition: { x: 0.7, y: 0.7 }, time: 0, easeTypeX: 0, easeTypeY: 0 }],
    scaleEvents: [{ anchor: { x: 0.7, y: 0.7 }, time: 0, easeTypeX: 0, easeTypeY: 0, scale: { x: 1, y: 1 } }],
    ...overrides,
  };
}

function officialDocument(blockAreaList) {
  const line = { bpm: 120, notesAbove: [], notesBelow: [], speedEvents: [], judgeLineMoveEvents: [], judgeLineDisappearEvents: [], judgeLineRotateEvents: [] };
  return { formatVersion: 3, offset: 0, judgeLineList: [line], ...(blockAreaList ? { blockAreaList } : {}) };
}

// ---------------------------------------------------------------------------

test('块缓动：9 种对应 rpe-next 曲线，3/6/9/12 按文档 B 的对称 in-out，13 恒 0、14 恒 1', () => {
  const mapped = { 0: 1, 1: 5, 2: 4, 4: 9, 5: 8, 7: 11, 8: 10, 10: 15, 11: 14 };
  for (const [blockType, type] of Object.entries(mapped)) {
    for (const progress of [0, 0.01, 0.17, 0.5, 0.83, 0.99, 1]) {
      assert.equal(blockEase(Number(blockType), progress), easing(progress, type), `easeType ${blockType} @ ${progress}`);
    }
  }
  // behavior.md §2.1.1: the APK's 3/6/9/12 are downsample+halve composite tables, but this
  // repository implements the community in-out curves instead. 3/6/9 map onto rpe-next's own
  // in-out curves; 12 (in-out-quint) has none, so blockEase supplies it directly.
  for (const [blockType, type] of Object.entries({ 3: 7, 6: 12, 9: 13 })) {
    for (const progress of [0, 0.01, 0.17, 0.5, 0.83, 0.99, 1]) {
      assert.equal(blockEase(Number(blockType), progress), easing(progress, type), `easeType ${blockType} @ ${progress}`);
    }
  }
  const inOutQuint = (progress) => (progress < 0.5 ? 16 * progress ** 5 : 1 - ((-2 * progress + 2) ** 5) / 2);
  for (const progress of [0, 0.01, 0.17, 0.25, 0.5, 0.75, 0.83, 0.99, 1]) {
    assert.ok(Math.abs(blockEase(12, progress) - inOutQuint(progress)) < 1e-12, `easeType 12 @ ${progress}`);
  }
  // The composite tables are non-monotonic; the in-out ones are not, so the midpoints must differ
  // from the old "dead table" reading and sit at ~0.5 rather than 0.
  for (const type of [3, 6, 9, 12]) assert.ok(Math.abs(blockEase(type, 0.5) - 0.5) < 1e-12, `easeType ${type} 中点`);
  for (const progress of [0, 0.3, 0.7, 1]) assert.equal(blockEase(13, progress), 0, '只有 13 是死表');
  for (const progress of [0, 0.3, 0.7, 1]) assert.equal(blockEase(14, progress), 1);
  assert.equal(BLOCK_EASE_TYPES, 15);
  assert.throws(() => blockEase(15, 0.5));
  assert.throws(() => blockEase(-1, 0.5));
  // `GetEaseWithProgress` clamps by index (`i < 0` -> `table[0]`, `i >= 100` -> `table[100]`), which
  // is equivalent to clamping the progress itself. This is reachable: the validator deliberately
  // allows unordered times, so a reversed segment produces a negative or > 1 ratio.
  for (const type of [0, 1, 2, 3, 6, 9, 12, 13, 14]) {
    assert.equal(blockEase(type, -0.5), blockEase(type, 0), `easeType ${type} 低于 0 取端点`);
    assert.equal(blockEase(type, 1.5), blockEase(type, 1), `easeType ${type} 高于 1 取端点`);
  }
  // NaN becomes `INT_MIN` in the game's cast, i.e. `table[0]`.
  for (const type of [0, 3, 12, 13, 14]) assert.equal(blockEase(type, NaN), blockEase(type, 0), `easeType ${type} 遇 NaN 取 table[0]`);
});

test('type 12 是 in-out-quint：端点、中点与单调性', () => {
  // behavior.md §2.1.1: 12 is the community in-out-quint here, not the APK's composite table. The
  // composite construction (50..57 zero break, 47..49 reading source indices 102/104/106) is
  // deliberately not built — three of its samples are uninitialised heap.
  assert.equal(blockEase(12, 0), 0);
  assert.equal(blockEase(12, 1), 1);
  assert.equal(blockEase(12, 0.5), 0.5);
  // Symmetric about the midpoint, unlike the composite table which dropped to 0 at u = 0.5.
  for (const progress of [0.1, 0.2, 0.3, 0.4]) {
    assert.ok(Math.abs(blockEase(12, progress) + blockEase(12, 1 - progress) - 1) < 1e-12, `对称 @ ${progress}`);
  }
  // Monotonic, and the first half is the steeper one.
  let previous = -Infinity;
  for (let step = 0; step <= 100; step++) {
    const value = blockEase(12, step / 100);
    assert.ok(value >= previous, `单调 @ ${step}`);
    previous = value;
  }
  assert.ok(blockEase(12, 0.25) < 0.25, '前半慢于线性');
  assert.ok(blockEase(12, 0.75) > 0.75, '后半快于线性');
});

test('FindCurrentEventIndex：严格大于、范围 [-1, Count-2]、等时刻取最后一个', () => {
  const events = [{ time: 1 }, { time: 2 }, { time: 3 }, { time: 4 }];
  assert.equal(findCurrentEventIndex(events, 0), -1, 'now 早于首事件');
  assert.equal(findCurrentEventIndex(events, 1), 0);
  assert.equal(findCurrentEventIndex(events, 1.5), 0);
  assert.equal(findCurrentEventIndex(events, 4), 2, '上限是 Count-2');
  assert.equal(findCurrentEventIndex(events, 99), 2);
  assert.equal(findCurrentEventIndex([{ time: 5 }], 1), -1, '单元素且未到时刻');
  assert.equal(findCurrentEventIndex([{ time: 5 }], 5), 0);
  assert.equal(findCurrentEventIndex([], 1), -1);
  assert.equal(findCurrentEventIndex(undefined, 1), -1);
  assert.equal(findCurrentEventIndex([{ time: 1 }, { time: 2 }, { time: 2 }, { time: 3 }], 2), 2, '等时刻取最后');
});

test('相位：四个时间点前后；enableTime == disableTime 的块永不生效', () => {
  const block = plainBlock({ appearTime: 1, enableTime: 2, disableTime: 3, disappearTime: 4 });
  assert.equal(blockState(block, 0.5), null, '出现前隐藏');
  assert.deepEqual(blockState(block, 1), { active: false, ready: false }, 'Disabled');
  assert.deepEqual(blockState(block, 1.5), { active: false, ready: true }, 'Ready');
  assert.deepEqual(blockState(block, 2), { active: true, ready: false }, 'Active');
  assert.deepEqual(blockState(block, 2.9), { active: true, ready: false });
  assert.deepEqual(blockState(block, 3), { active: false, ready: false }, '残留退回禁用外观');
  assert.deepEqual(blockState(block, 3.9), { active: false, ready: false });
  assert.equal(blockState(block, 4), null, '消失后隐藏');

  // `null` stands in for the game's two hidden phases, which park the block at x = 1000 rather than
  // changing its layer: same picture, and the box the game only stops tracking after the interval.
  assert.equal(blockState(plainBlock(), -1), null, 'appearTime 之前隐藏');
  assert.equal(blockIsDestroyed(plainBlock(), 3.0), false, '恰好 max(disable, disappear) 时还活着');
  assert.equal(blockIsDestroyed(plainBlock(), 8.1), true, '超过 destroyInterval 才销毁');
  assert.equal(BLOCK_HIDDEN_POSITION, 1000, '游戏把隐藏块停在 x = 1000');

  // 7 of the 48 shipped blocks do this on purpose and must stay legal.
  const inert = plainBlock({ appearTime: 1, enableTime: 3, disableTime: 3, disappearTime: 4 });
  for (const time of [1, 2.9, 3, 3.5, 3.99]) assert.equal(blockIsActive(inert, time), false);
  assert.notEqual(blockState(inert, 3), null, '仍然可见');
  // `DisabledBlockShow` only starts when a block becomes visible *inside* its enabled window, so a
  // block that appears before `enableTime` never fades — the `Disabled` phase is visible from its
  // first frame. Returning a ramp here made every shipped block invisible for 0.5 s.
  assert.equal(blockShowCoverage(plainBlock({ appearTime: 10 }), 10), 1, 'appear 早于 enable：不淡入');
  assert.equal(blockShowCoverage(plainBlock({ appearTime: 10 }), 10.25), 1);
  // The corpus shape: appear 0, enable 1, so `notInWindow` is already false at appearTime.
  assert.equal(blockShowCoverage(plainBlock(), 0), 1, '语料里的块一出现就是满 alpha');
  // A block that appears while already enabled is the case the coroutine does cover.
  const late = plainBlock({ appearTime: 10, enableTime: 8, disableTime: 12, disappearTime: 13 });
  assert.equal(blockShowCoverage(late, 10), 0, '窗口内出现的块从 0 淡入');
  assert.equal(blockShowCoverage(late, 10.25), 0.5);
  assert.equal(blockShowCoverage(late, 11), 1);
});

test('几何：百分比→世界；反转矩形不取绝对值；超出 [0,1] 合法', () => {
  const aspect = 16 / 9;
  const screen = blockScreen(aspect);
  assert.equal(screen.y, BLOCK_SCREEN_HEIGHT);
  assert.ok(Math.abs(screen.x - BLOCK_SCREEN_HEIGHT * aspect) < 1e-12);

  const full = blockGeometry({ topRightPercentage: { x: 1, y: 1 }, bottomLeftPercentage: { x: 0, y: 0 } }, aspect);
  assert.ok(Math.abs(full.size.x - screen.x) < 1e-12);
  assert.ok(Math.abs(full.size.y - screen.y) < 1e-12);
  assert.equal(full.center.x, 0);
  assert.equal(full.center.y, 0);

  // Shipped block 28 has topRightPercentage.x < bottomLeftPercentage.x and the renderer tolerates
  // it via Mathf.Abs, so the raw size must stay negative here.
  const block28 = fixture[28];
  assert.ok(block28.topRightPercentage.x < block28.bottomLeftPercentage.x);
  assert.ok(blockGeometry(block28, aspect).size.x < 0);

  const outside = blockGeometry({ topRightPercentage: { x: 1.5, y: 1.2 }, bottomLeftPercentage: { x: -0.2, y: -0.1 } }, aspect);
  assert.ok(outside.size.x > screen.x);
});

test('变换合成：size 取插值缩放×原尺寸，center 按事件比率绕锚点累乘（两段式）', () => {
  const aspect = 1;
  const anchor = { x: 0.5, y: 0.5 };                       // 世界原点
  const block = plainBlock({
    topRightPercentage: { x: 0.9, y: 0.6 },
    bottomLeftPercentage: { x: 0.7, y: 0.4 },              // 中心世界坐标 (3, 0)
    rotateEvents: [], moveEvents: [],
    scaleEvents: [
      { anchor, time: 0, easeTypeX: 0, easeTypeY: 0, scale: { x: 1, y: 1 } },
      { anchor, time: 1, easeTypeX: 0, easeTypeY: 0, scale: { x: 2, y: 2 } },
      { anchor, time: 2, easeTypeX: 0, easeTypeY: 0, scale: { x: 4, y: 4 } },
    ],
  });
  const geo = blockGeometry(block, aspect);
  closeTo(geo.size.x, 2, 'geo.size.x');
  closeTo(geo.center.x, 3, 'geo.center.x');

  // now = 2 lands on index 1 (Count-2), so the interpolating branch runs to completion.
  // Catch-up i=0 pushes center by ratio 2/1 => 6; the current segment pushes by 4/2 => 12.
  // size is absolute (interp x originalSize), never accumulated.
  const at2 = blockTransform(block, 2, aspect);
  closeTo(at2.center.x, 12, 'center');
  closeTo(at2.size.x, 8, 'size');

  // Past the last event the same index is selected and Clamp01 saturates, so it equals the last
  // event's scale rather than taking an early "last event" return.
  assert.deepEqual(blockTransform(block, 8, aspect), at2);

  // Before the first event the whole list is skipped and the raw geometry is used.
  const early = blockTransform({ ...block, scaleEvents: [{ anchor, time: 5, easeTypeX: 0, easeTypeY: 0, scale: { x: 3, y: 3 } }] }, 1, aspect);
  assert.equal(early.center.x, geo.center.x);
  assert.equal(early.size.x, geo.size.x);
  assert.equal(early.rotation, 0);
});

test('变换：旋转是绝对值，且圆心被逐事件绕锚点带着走', () => {
  const aspect = 1;
  const anchor = { x: 0.5, y: 0.5 };
  const block = plainBlock({
    topRightPercentage: { x: 0.9, y: 0.6 },
    bottomLeftPercentage: { x: 0.7, y: 0.4 },
    moveEvents: [], scaleEvents: [],
    rotateEvents: [
      { anchor, time: 0, easeType: 0, rotation: 0 },
      { anchor, time: 1, easeType: 0, rotation: 90 },
      { anchor, time: 2, easeType: 0, rotation: 180 },
    ],
  });
  const at1 = blockTransform(block, 1, aspect);
  // At now = 1 the strict `>` comparison advances index to 1, so the segment (1 -> 2) is current
  // with progress 0: rotation is exactly events[1].rotation = 90, not 180. The catch-up loop
  // rotated (3,0) by 90-0 = 90 degrees around the origin => (0,3), and the segment delta is 0.
  assert.equal(at1.rotation, 90);
  closeTo(at1.center.x, 0, 'center.x');
  closeTo(at1.center.y, 3, 'center.y');

  const at15 = blockTransform(block, 1.5, aspect);
  // progress 0.5 => rotation = lerp(90, 180, 0.5) = 135; the centre is then pushed by 135-90 = 45
  // around the origin, so (0,3) becomes (-3*sin45, 3*cos45).
  assert.equal(at15.rotation, 135);
  closeTo(at15.center.x, -3 * Math.SQRT1_2, 'center.x');
  closeTo(at15.center.y, 3 * Math.SQRT1_2, 'center.y');
});

test('变换：移动是相对未变换中心的增量，叠加在已缩放/旋转的中心上', () => {
  const aspect = 1;
  const anchor = { x: 0.5, y: 0.5 };
  const block = plainBlock({
    topRightPercentage: { x: 0.9, y: 0.6 },
    bottomLeftPercentage: { x: 0.7, y: 0.4 },              // 原始中心 (3, 0)
    rotateEvents: [],
    scaleEvents: [{ anchor, time: 0, easeTypeX: 0, easeTypeY: 0, scale: { x: 1, y: 1 } }],
    moveEvents: [
      { endPosition: { x: 0.5, y: 0.5 }, time: 0, easeTypeX: 0, easeTypeY: 0 },   // 世界 (0,0)
      { endPosition: { x: 0.8, y: 0.5 }, time: 2, easeTypeX: 0, easeTypeY: 0 },   // 世界 (3,0)
    ],
  });
  // now = 1: index 0, tx = 0.5 => target world (1.5, 0); delta = 1.5 - 3 = -1.5; center 3 - 1.5 = 1.5
  closeTo(blockTransform(block, 1, aspect).center.x, 1.5, 'movement delta from the raw centre');
});

test('官方导入把 blockAreaList 提升为 blockAreas，并且不污染原文快照', () => {
  const original = officialDocument(clone(fixture.slice(0, 3)));
  const chart = parseDocument(JSON.stringify(original));

  assert.equal(chart.blockAreas.length, 3);
  assert.deepEqual(chart.blockAreas, fixture.slice(0, 3), '逐字段等于官方数据');
  assert.notEqual(chart.blockAreas, chart.rpeNextLegacySource.document.blockAreaList, '必须是深拷贝');
  assert.deepEqual(chart.rpeNextLegacySource.document.blockAreaList, fixture.slice(0, 3));

  chart.blockAreas[0].appearTime = 999;
  chart.blockAreas.push(plainBlock());
  assert.equal(chart.rpeNextLegacySource.document.blockAreaList.length, 3, '快照长度未变');
  assert.equal(chart.rpeNextLegacySource.document.blockAreaList[0].appearTime, fixture[0].appearTime, '快照内容未变');

  const bare = parseDocument(JSON.stringify(officialDocument()));
  assert.deepEqual(bare.blockAreas, [], '官方谱面无该键时为空数组');
});

test('校验：只拒绝游戏本身会崩或产生 NaN 的数据；真实谱面的病态块一律放过', () => {
  const rejected = (mutate, pattern) => {
    const chart = createChart();
    chart.blockAreas = [plainBlock()];
    mutate(chart.blockAreas[0]);
    assert.throws(() => assertChart(chart), pattern);
  };
  rejected(block => { block.moveEvents[0].easeTypeX = 15; }, /easeTypeX/);
  rejected(block => { block.rotateEvents[0].easeType = -1; }, /easeType/);
  rejected(block => { block.topRightPercentage = { x: Number.NaN, y: 0 }; }, /坐标/);
  rejected(block => { block.disappearTime = Number.POSITIVE_INFINITY; }, /disappearTime/);
  rejected(block => { block.scaleEvents[0].scale = { x: Number.NaN, y: 1 }; }, /scale/);

  // Real charts contain every one of these, and the game renders them.
  const accepted = (mutate, why) => {
    const chart = createChart();
    chart.blockAreas = [plainBlock()];
    mutate(chart.blockAreas[0]);
    assert.doesNotThrow(() => assertChart(chart), why);
  };
  // A shipped chart (Chart.AT.json) really does carry a zero scale component: `SafeDiv` turns the
  // degenerate denominator into a ratio of 1, so it renders rather than failing.
  accepted(block => {
    block.scaleEvents = [
      { anchor: { x: 0.5, y: 0.5 }, time: 0, easeTypeX: 0, easeTypeY: 0, scale: { x: 1, y: 1 } },
      { anchor: { x: 0.5, y: 0.5 }, time: 1, easeTypeX: 0, easeTypeY: 0, scale: { x: 0, y: 1 } },
    ];
  }, '零缩放分量');
  accepted(block => { block.scaleEvents[0].scale = { x: -0, y: 1 }; }, '负零');
  accepted(block => { block.scaleEvents[0].easeTypeX = 3.7; }, '小数缓动类型');
  accepted(block => { block.enableTime = block.disableTime; }, '永不生效（32/34/35/36/38/41/43）');
  accepted(block => { block.topRightPercentage = { x: 0.5, y: 1 }; block.bottomLeftPercentage = { x: 0.51, y: 0 }; }, '反转矩形（28）');
  accepted(block => { block.scaleEvents = [{ anchor: { x: 0.5, y: 0.5 }, time: 0, easeTypeX: 3, easeTypeY: 6, scale: { x: -50, y: 1 } }]; }, '负缩放');
  accepted(block => { block.moveEvents[0].endPosition = { x: -0.2, y: 1.3 }; }, 'endPosition 越界');
  accepted(block => { block.scaleEvents[0].time = 9; }, '单元素事件晚于 appearTime');
  accepted(block => { block.appearTime = 5; }, '时间逆序');
  accepted(block => { block.rotateEvents = []; block.moveEvents = []; block.scaleEvents = []; }, '三个事件列表全空');
  for (const block of fixture) {
    const chart = createChart();
    chart.blockAreas = [clone(block)];
    assert.doesNotThrow(() => assertChart(chart), `夹具第 ${fixture.indexOf(block)} 块应可解析`);
  }
});

test('零缩放不产生 NaN，且块在该轴上塌缩', () => {
  const aspect = 16 / 9;
  const anchor = { x: 0.5, y: 0.5 };
  // The shape a shipped chart uses: the pivot ratio hits a zero denominator mid-list.
  const block = plainBlock({
    rotateEvents: [], moveEvents: [],
    scaleEvents: [
      { anchor, time: 0, easeTypeX: 0, easeTypeY: 0, scale: { x: 1, y: 1 } },
      { anchor, time: 1, easeTypeX: 0, easeTypeY: 0, scale: { x: 0, y: 1 } },
      { anchor, time: 2, easeTypeX: 0, easeTypeY: 0, scale: { x: 1, y: 1 } },
    ],
  });
  for (let step = 0; step <= 40; step++) {
    const now = -0.5 + step * 0.075;
    const transform = blockTransform(block, now, aspect);
    for (const value of [transform.center.x, transform.center.y, transform.size.x, transform.size.y, transform.rotation]) {
      assert.ok(Number.isFinite(value), `now=${now} 出现非有限值`);
    }
  }
  // At the zero event the width collapses to nothing rather than becoming NaN.
  assert.equal(blockTransform(block, 1, aspect).size.x, 0);
  // Both components zero is the degenerate `SafeDiv(0, 0)` case, which also yields 1.
  const both = plainBlock({
    rotateEvents: [], moveEvents: [],
    scaleEvents: [{ anchor, time: 0, easeTypeX: 0, easeTypeY: 0, scale: { x: 0, y: 0 } }],
  });
  const collapsed = blockTransform(both, 0.5, aspect);
  assert.equal(collapsed.size.x, 0);
  assert.equal(collapsed.size.y, 0);
  assert.ok(Number.isFinite(collapsed.center.x) && Number.isFinite(collapsed.center.y));
});

test('Mirror()：角点交叉取补、旋转取负、anchor/endPosition 自身取补，y 全部不变', () => {
  // data.md §BlockArea.Mirror() (VA 0x1CA32A8). The corners are a CROSSED complement — both read the
  // original values — which flips the rectangle about x = 0.5 while keeping its width. Writing
  // "each corner complements itself" instead inverts the rectangle, and `blockGeometry` does not take
  // Mathf.Abs, so that would render as a negative-size block rather than failing loudly.
  const block = plainBlock({
    topRightPercentage: { x: 0.8, y: 0.7 },
    bottomLeftPercentage: { x: 0.6, y: 0.2 },
    rotateEvents: [{ anchor: { x: 0.25, y: 0.9 }, time: 0, easeType: 0, rotation: 30 }],
    moveEvents: [{ endPosition: { x: 0.3, y: 0.4 }, time: 0, easeTypeX: 0, easeTypeY: 0 }],
    scaleEvents: [{ anchor: { x: 0.75, y: 0.1 }, time: 0, easeTypeX: 0, easeTypeY: 0, scale: { x: 2, y: 3 } }],
  });
  const mirrored = mirrorBlockArea(block);
  // `1 - 0.8` is 0.19999999999999996 in binary floating point, so the corners are compared
  // approximately; the game has the same rounding.
  assert.ok(Math.abs(mirrored.topRightPercentage.x - 0.4) < 1e-12, 'tr.x ← 1 − bl.x');
  assert.equal(mirrored.topRightPercentage.y, 0.7, 'tr.y 不变');
  assert.ok(Math.abs(mirrored.bottomLeftPercentage.x - 0.2) < 1e-12, 'bl.x ← 1 − tr.x');
  assert.equal(mirrored.bottomLeftPercentage.y, 0.2, 'bl.y 不变');
  assert.deepEqual(mirrored.rotateEvents[0].anchor, { x: 0.75, y: 0.9 }, 'anchor.x 自身取补');
  assert.equal(mirrored.rotateEvents[0].rotation, -30, 'rotation 取负');
  assert.deepEqual(mirrored.moveEvents[0].endPosition, { x: 0.7, y: 0.4 }, 'endPosition.x 自身取补');
  assert.deepEqual(mirrored.scaleEvents[0].anchor, { x: 0.25, y: 0.1 }, 'scale anchor.x 自身取补');
  assert.deepEqual(mirrored.scaleEvents[0].scale, { x: 2, y: 3 }, 'scale 值不动');
  // The four times and `isSubtract` ride along untouched.
  for (const key of ['appearTime', 'enableTime', 'disableTime', 'disappearTime', 'isSubtract']) {
    assert.equal(mirrored[key], block[key], `${key} 不应改变`);
  }
  // The input is not mutated (the game mutates in place; this port returns a new block so the
  // editor's undo history keeps the pre-mirror document intact).
  assert.equal(block.topRightPercentage.x, 0.8, '入参不应被修改');

  // Width and height are preserved, and the centre flips about x = 0.5.
  const aspect = 16 / 9;
  const before = blockGeometry(block, aspect);
  const after = blockGeometry(mirrored, aspect);
  assert.ok(Math.abs(before.size.x - after.size.x) < 1e-12, '宽度不变');
  assert.ok(Math.abs(before.size.y - after.size.y) < 1e-12, '高度不变');
  assert.ok(Math.abs(before.center.x + after.center.x) < 1e-12, '中心 x 取反');
  assert.ok(Math.abs(before.center.y - after.center.y) < 1e-12, '中心 y 不变');

  // Mirroring twice is the identity, which is the cheapest check that the crossed assignment is
  // symmetric rather than accidentally one-way.
  const twice = mirrorBlockArea(mirrored);
  assert.ok(Math.abs(twice.topRightPercentage.x - block.topRightPercentage.x) < 1e-12, '镜像两次回到原状');
  assert.equal(twice.rotateEvents[0].rotation, 30);
  assert.ok(Math.abs(twice.moveEvents[0].endPosition.x - 0.3) < 1e-12);

  // Missing event lists are skipped rather than throwing, matching the null checks in the game.
  const bare = mirrorBlockArea({ topRightPercentage: { x: 1, y: 1 }, bottomLeftPercentage: { x: 0, y: 0 } });
  assert.equal(bare.rotateEvents, undefined);
  assert.equal(bare.moveEvents, undefined);
  assert.equal(bare.scaleEvents, undefined);
  // An empty list stays empty.
  assert.deepEqual(mirrorBlockArea(plainBlock({ rotateEvents: [] })).rotateEvents, []);

  // The list-level wrapper maps every block and tolerates a missing list.
  const many = mirrorBlockAreas([block, block]);
  assert.equal(many.length, 2);
  assert.ok(Math.abs(many[0].topRightPercentage.x - mirrored.topRightPercentage.x) < 1e-12);
  assert.equal(mirrorBlockAreas(undefined), undefined);
});

test('Mirror() 后块的绘制结果左右翻转，但仍在同一 y 带上', () => {
  // End-to-end: mirroring a real corpus block must move its rendered rectangle to the mirrored
  // pixel column without changing its row. This catches a y-axis regression that the field-level
  // assertions above could miss if the transform consumed the corners differently.
  const aspect = 16 / 9;
  const block = fixture[0];
  const mirrored = mirrorBlockArea(block);
  const before = blockTransform(block, block.enableTime, aspect);
  const after = blockTransform(mirrored, block.enableTime, aspect);
  assert.ok(Math.abs(before.center.x + after.center.x) < 1e-9, '中心 x 取反');
  assert.ok(Math.abs(before.center.y - after.center.y) < 1e-9, '中心 y 不变');
  assert.ok(Math.abs(before.size.x - after.size.x) < 1e-9, '宽度不变');
  assert.ok(Math.abs(before.rotation + after.rotation) < 1e-9, '旋转取负');
});

test('序列化往返保留 blockAreas', () => {
  const chart = createChart();
  chart.blockAreas = clone(fixture.slice(0, 4));
  const again = parseChart(serializeChart(chart));
  assert.deepEqual(again.blockAreas, chart.blockAreas);
});

test('真实语料全量扫描：48 个块在任意时刻都不产生 NaN', () => {
  const aspect = 16 / 9;
  let samples = 0;
  for (const [index, block] of fixture.entries()) {
    const times = [...block.rotateEvents, ...block.moveEvents, ...block.scaleEvents].map(event => event.time);
    const start = Math.min(block.appearTime, ...times);
    const end = Math.max(block.disappearTime, ...times);
    for (let step = 0; step <= 40; step++) {
      const now = start + (end - start) * (step / 40);
      const transform = blockTransform(block, now, aspect);
      for (const value of [transform.center.x, transform.center.y, transform.size.x, transform.size.y, transform.rotation]) {
        assert.ok(Number.isFinite(value), `第 ${index} 块 @ ${now.toFixed(3)}s 出现非有限值`);
      }
      const coverage = blockShowCoverage(block, now);
      assert.ok(coverage >= 0 && coverage <= 1, `第 ${index} 块 @ ${now.toFixed(3)}s 淡入系数越界`);
      samples++;
    }
  }
  assert.ok(samples >= 48 * 41);
});

test('预览绘制：尺寸为零的块不产生绘制调用（第 28 块的 scale 会穿过 0）', () => {
  const block28 = clone(fixture[28]);
  // Drive the scale to exactly zero width and confirm the pass skips it rather than drawing a
  // degenerate rectangle.
  block28.scaleEvents = [
    { anchor: { x: 0.5, y: 0.5 }, time: 0, easeTypeX: 0, easeTypeY: 0, scale: { x: 0, y: 1 } },
  ];
  const context = drawBlocks([block28], 0.5);
  assert.equal(context.calls.length, 0);
});

// ---------------------------------------------------------------------------

function stubContext() {
  const calls = [];
  const record = (name) => (...args) => calls.push({ name, args });
  const property = (name) => ({
    set(value) { calls.push({ name, args: [value] }); },
    get() { return undefined; },
  });
  return Object.defineProperties({
    calls, save: record('save'), restore: record('restore'), translate: record('translate'),
    rotate: record('rotate'), fillRect: record('fillRect'), strokeRect: record('strokeRect'),
    setLineDash: record('setLineDash'),
    styles: (name) => calls.filter(call => call.name === name).map(call => call.args[0]),
  }, Object.fromEntries(['fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'globalCompositeOperation', 'shadowColor', 'shadowBlur'].map(name => [name, property(name)])));
}

const viewport = { left: 0, top: 0, width: 1600, height: 900 };

function drawBlocks(blocks, seconds, scale = 1) {
  const context = stubContext();
  // `blockView` is taken from the prototype so the stub cannot drift from the real layout maths.
  const host = { chart: { blockAreas: blocks }, drawBlockBody: Preview.prototype.drawBlockBody, blockView: Preview.prototype.blockView };
  Preview.prototype.drawBlocks.call(host, context, seconds, viewport, scale);
  return context;
}

test('预览绘制：块的矩形随编辑器「缩放」一起收缩，而不是铺满视口', () => {
  // `缩放` (`viewDivisor`) shrinks the content inside a fixed viewport by handing the notes and judge
  // lines `viewport.scale / divisor`. Blocks are screen percentages, so they have to shrink with it —
  // otherwise at divisor 4 the notes are a quarter size while the blocks still fill the window.
  const block = plainBlock({ appearTime: 0, enableTime: 0, disableTime: 5, disappearTime: 5 });
  const full = drawBlocks([block], 1, 1);
  const half = drawBlocks([block], 1, 0.5);
  const centre = (context) => context.calls.find((call) => call.name === 'translate').args;
  const size = (context) => context.calls.find((call) => call.name === 'fillRect').args;
  const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual} != ${expected}`);
  // `plainBlock` spans 0.6–0.8 in both axes, so its centre is 0.7 / 0.7 and it covers 20 % of the play
  // field: 320 × 180 px of the 1600 × 900 viewport at scale 1, half that at scale 0.5. The rect handed
  // to `fillRect` is relative to the block centre, so it is scale-invariant by construction — the
  // centre is what moves.
  near(size(full)[2], 320, 'scale 1 块宽');
  near(size(full)[3], 180, 'scale 1 块高');
  near(size(half)[2], 160, 'scale 0.5 块宽');
  near(size(half)[3], 90, 'scale 0.5 块高');
  // Centre: 800 + (0.7 − 0.5) × 1600 = 1120 at scale 1; 800 + 0.2 × 800 = 960 at scale 0.5.
  // Vertically 450 − 0.2 × 900 = 270 → 450 − 0.2 × 450 = 360, i.e. it contracts towards the middle.
  near(centre(full)[0], 1120, 'scale 1 块心 x');
  near(centre(full)[1], 270, 'scale 1 块心 y');
  near(centre(half)[0], 960, 'scale 0.5 块心 x');
  near(centre(half)[1], 360, 'scale 0.5 块心 y');
  // The ring is one effect texel plus the block's own extent, and it is a fraction of the screen
  // height, so it shrinks with the content.
  const ringWidth = (context) => context.calls.filter((call) => call.name === 'strokeRect')[0].args[2];
  near(ringWidth(full) - size(full)[2], 0.0037 * 900, '整倍时环宽');
  near(ringWidth(half) - size(half)[2], 0.0037 * 450, '半倍时环宽');
});

test('预览绘制：生效块画填充并加法描边+光晕，禁用块加法填充无描边', () => {
  const active = drawBlocks([plainBlock({ appearTime: 0, enableTime: 0, disableTime: 5, disappearTime: 5 })], 1);
  assert.equal(active.calls.filter(call => call.name === 'fillRect').length, 1);
  assert.equal(active.calls.filter(call => call.name === 'strokeRect').length, 2, '描边 + 光晕各一次');
  assert.ok(active.styles('fillStyle').includes('rgba(182,60,60,0.667)'));
  assert.ok(active.styles('strokeStyle').includes('rgba(255,84,84,0.8)'));
  assert.ok(active.styles('globalCompositeOperation').includes('lighter'));

  const disabled = drawBlocks([plainBlock({ appearTime: 0, enableTime: 5, disableTime: 6, disappearTime: 7 })], 1);
  assert.equal(disabled.calls.filter(call => call.name === 'strokeRect').length, 0, '禁用态没有描边/光晕');
  assert.ok(disabled.styles('globalCompositeOperation').includes('lighter'));
  assert.ok(disabled.styles('fillStyle').includes('rgba(127,35,35,0.4)'));

  const ready = drawBlocks([plainBlock({ appearTime: 0, enableTime: 1, disableTime: 2, disappearTime: 3 })], 0.75);
  assert.equal(ready.calls.filter(call => call.name === 'fillRect').length, 2, '禁用底色 + 呼吸叠加');
});

test('预览绘制：隐藏时不画；减块 alpha 0.1 且额外画虚线提示', () => {
  const hidden = drawBlocks([plainBlock({ appearTime: 10, enableTime: 11, disableTime: 12, disappearTime: 13 })], 1);
  assert.equal(hidden.calls.length, 0);

  const subtract = drawBlocks([plainBlock({ isSubtract: true, appearTime: 0, enableTime: 0, disableTime: 5, disappearTime: 5 })], 1);
  assert.ok(subtract.styles('globalAlpha').includes(0.1), '减块整体 alpha 0.1');
  assert.ok(subtract.calls.some(call => call.name === 'setLineDash'), '有虚线提示');
  assert.ok(subtract.styles('strokeStyle').includes('rgba(255,120,255,0.85)'));
});

test('预览绘制：视口映射把矩形放在预期的像素位置', () => {
  const block = plainBlock({
    topRightPercentage: { x: 0.75, y: 0.75 }, bottomLeftPercentage: { x: 0.25, y: 0.25 },
    appearTime: 0, enableTime: 0, disableTime: 5, disappearTime: 5,
    rotateEvents: [], moveEvents: [], scaleEvents: [],
  });
  const context = drawBlocks([block], 1);
  const translate = context.calls.find(call => call.name === 'translate');
  assert.deepEqual(translate.args, [viewport.width / 2, viewport.height / 2]);
  const fill = context.calls.find(call => call.name === 'fillRect');
  assert.deepEqual(fill.args, [-viewport.width / 4, -viewport.height / 4, viewport.width / 2, viewport.height / 2]);
});

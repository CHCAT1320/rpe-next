import { compileExpression } from './batch-script.mjs';
import { easing } from './easing.mjs';

export const TRAJECTORY_VERSION = 210;
export const TRAJECTORY_DEFAULTS = Object.freeze({ mode: 'parametric', xExpression: '200*cos(2*pi*t)', yExpression: '200*sin(2*pi*t)', radiusExpression: '200', rotationExpression: '', tangentRotation: false, parameterStart: '0', parameterEnd: '1', angleStart: '0', angleEnd: '2*pi', trimStart: 0, trimEnd: 1, rotation: 0, scaleX: 1, scaleY: 1, alignStart: false, startX: 0, startY: 0, easingX: 1, easingY: 1, seed: 1, randomness: 0, parameters: {} });
export const trajectoryHasRotation = options => Boolean(options.tangentRotation || options.rotationExpression?.trim());
const radiusParameter = { key: 'radius', label: '半径', value: 200, min: 1, max: 2000, step: 1 };
const parameter = (key, label, value, min = 1, max = 1000, step = 1) => ({ key, label, value, min, max, step });
const polygon = sides => ({ mode: 'polar', radiusExpression: `radius*cos(pi/${sides})/cos(theta-round(theta/(2*pi/${sides}))*(2*pi/${sides}))` });
export const CURVE_PRESETS = [
  { id: 'line', category: '基本图形', name: '直线', xExpression: 'length*t', yExpression: '0', parameters: [parameter('length', '长度', 400)] },
  { id: 'circle', category: '基本图形', name: '圆形', mode: 'polar', radiusExpression: 'radius', parameters: [radiusParameter] },
  ...[[3, '三角形'], [4, '四边形'], [5, '五边形'], [6, '六边形'], [8, '八边形'], [12, '十二边形']].map(([sides, name]) => ({ id: `polygon-${sides}`, category: '基本图形', name, ...polygon(sides), parameters: [radiusParameter] })),
  { id: 'arc', category: '基本图形', name: '圆弧', mode: 'polar', radiusExpression: 'radius', angleEnd: 'sweep*pi/180', parameters: [radiusParameter, parameter('sweep', '圆心角（度）', 180, -720, 720)] },
  { id: 'rectangle', category: '基本图形', name: '矩形', mode: 'polar', radiusExpression: 'min(width/max(abs(cos(theta)),0.000001),height/max(abs(sin(theta)),0.000001))', parameters: [parameter('width', '半宽', 250), parameter('height', '半高', 150)] },
  { id: 'diamond', category: '基本图形', name: '菱形', mode: 'polar', radiusExpression: '1/(abs(cos(theta))/width+abs(sin(theta))/height)', parameters: [parameter('width', '横半轴', 260), parameter('height', '纵半轴', 160)] },
  { id: 'star', category: '基本图形', name: '星形', shape: 'star', parameters: [radiusParameter, parameter('points', '角数', 5, 3, 20), parameter('inner', '内半径比例', 0.4, 0.05, 1, 0.01)] },
  { id: 'ellipse', category: '进阶图形', name: '椭圆', xExpression: 'width*cos(2*pi*t)', yExpression: 'height*sin(2*pi*t)', parameters: [parameter('width', '横半轴', 280), parameter('height', '纵半轴', 140)] },
  { id: 'heart', category: '进阶图形', name: '心形', xExpression: 'radius*sin(2*pi*t)^3', yExpression: 'radius*(13*cos(2*pi*t)-5*cos(4*pi*t)-2*cos(6*pi*t)-cos(8*pi*t))/16', parameters: [radiusParameter] },
  { id: 'spiral', category: '进阶图形', name: '螺线', mode: 'polar', radiusExpression: 'radius*t', angleEnd: '2*pi*turns', parameters: [radiusParameter, parameter('turns', '圈数', 3, 0.1, 20, 0.1)] },
  { id: 'rose', category: '进阶图形', name: '玫瑰线', mode: 'polar', radiusExpression: 'radius*cos(petals*theta)', parameters: [radiusParameter, parameter('petals', '花瓣参数', 5, 1, 20)] },
  { id: 'infinity', category: '进阶图形', name: '八字形', xExpression: 'radius*cos(2*pi*t)', yExpression: 'radius*sin(4*pi*t)/2', parameters: [radiusParameter] },
  { id: 'lissajous', category: '进阶图形', name: '李萨如曲线', xExpression: 'radius*sin(a*2*pi*t)', yExpression: 'radius*sin(b*2*pi*t+phase)', parameters: [radiusParameter, parameter('a', '横频率', 3, 1, 20), parameter('b', '纵频率', 2, 1, 20), parameter('phase', '相位（弧度）', 0, -6.3, 6.3, 0.1)] },
  { id: 'parabola', category: '进阶图形', name: '抛物线', xExpression: 'width*(2*t-1)', yExpression: 'height*(2*t-1)^2', parameters: [parameter('width', '半宽', 250), parameter('height', '高度', 200)] },
  { id: 'sine', category: '进阶图形', name: '正弦波', xExpression: 'length*(t-0.5)', yExpression: 'amplitude*sin(2*pi*waves*t+phase)', parameters: [parameter('length', '长度', 600), parameter('amplitude', '振幅', 100), parameter('waves', '波数', 2, 0.1, 20, 0.1), parameter('phase', '相位', 0, -6.3, 6.3, 0.1)] },
  { id: 'damped-wave', category: '进阶图形', name: '衰减波', xExpression: 'length*(t-0.5)', yExpression: 'amplitude*(1-t)^decay*sin(2*pi*waves*t)', parameters: [parameter('length', '长度', 600), parameter('amplitude', '振幅', 180), parameter('waves', '波数', 4, 1, 20), parameter('decay', '衰减指数', 2, 0.1, 8, 0.1)] },
  { id: 'cycloid', category: '进阶图形', name: '摆线', xExpression: 'radius*(2*pi*t-sin(2*pi*t)-pi)', yExpression: 'radius*(1-cos(2*pi*t))', parameters: [parameter('radius', '滚动半径', 90)] },
  { id: 'astroid', category: '进阶图形', name: '星状线', xExpression: 'radius*cos(2*pi*t)^3', yExpression: 'radius*sin(2*pi*t)^3', parameters: [radiusParameter] },
  { id: 'cardioid', category: '进阶图形', name: '心脏线', mode: 'polar', radiusExpression: 'radius*(1-cos(theta))', parameters: [parameter('radius', '基准半径', 130)] },
  { id: 'limacon', category: '进阶图形', name: '蚶线', mode: 'polar', radiusExpression: 'radius*(ratio+cos(theta))', parameters: [parameter('radius', '基准半径', 150), parameter('ratio', '内外环比例', 0.5, 0.1, 3, 0.1)] },
  { id: 'log-spiral', category: '进阶图形', name: '对数螺线', mode: 'polar', radiusExpression: 'radius*growth^t', angleEnd: '2*pi*turns', parameters: [parameter('radius', '起始半径', 30), parameter('growth', '半径增长倍数', 8, 0.1, 30, 0.1), parameter('turns', '圈数', 2, 0.1, 20, 0.1)] },
  { id: 'hypotrochoid', category: '进阶图形', name: '内旋轮线', xExpression: '(outer-inner)*cos(2*pi*turns*t)+pen*cos((outer-inner)/inner*2*pi*turns*t)', yExpression: '(outer-inner)*sin(2*pi*turns*t)-pen*sin((outer-inner)/inner*2*pi*turns*t)', parameters: [parameter('outer', '外圆半径', 240), parameter('inner', '滚动圆半径', 90), parameter('pen', '笔尖距离', 120), parameter('turns', '圈数', 3, 1, 20)] },
  { id: 'epitrochoid', category: '进阶图形', name: '外旋轮线', xExpression: '(outer+inner)*cos(2*pi*turns*t)-pen*cos((outer+inner)/inner*2*pi*turns*t)', yExpression: '(outer+inner)*sin(2*pi*turns*t)-pen*sin((outer+inner)/inner*2*pi*turns*t)', parameters: [parameter('outer', '固定圆半径', 120), parameter('inner', '滚动圆半径', 40), parameter('pen', '笔尖距离', 70), parameter('turns', '圈数', 1, 1, 20)] },
  { id: 'superellipse', category: '进阶图形', name: '超椭圆', mode: 'polar', radiusExpression: '1/((abs(cos(theta))/width)^power+(abs(sin(theta))/height)^power)^(1/power)', parameters: [parameter('width', '半宽', 240), parameter('height', '半高', 150), parameter('power', '圆角指数', 4, 0.5, 12, 0.1)] },
  { id: 'random-wave', category: '其他', name: '随机波形', xExpression: 'length*(t-0.5)', yExpression: 'amplitude*(sin(2*pi*waves*t)+randomness*(0.5*sin(13*pi*t+seed)+0.3*cos(23*pi*t+2*seed)))', randomness: 0.5, parameters: [parameter('length', '长度', 600), parameter('amplitude', '振幅', 100), parameter('waves', '主波数', 2, 1, 20)] },
  { id: 'random-polygon', category: '其他', name: '随机多边形', shape: 'random-polygon', randomness: 0.5, parameters: [radiusParameter, parameter('points', '顶点数', 7, 3, 40)] },
  { id: 'random-loop', category: '其他', name: '随机闭合曲线', mode: 'polar', radiusExpression: 'radius*(1+randomness*(0.5*sin(3*theta+seed)+0.3*cos(5*theta+seed*2)+0.2*sin(7*theta+seed*3)))', randomness: 0.5, parameters: [radiusParameter] },
];

export function normalizeCurveExpression(source) {
  return String(source ?? '').trim().replaceAll('$t$', 't').replaceAll('θ', 'theta').replace(/\bPi\b/g, 'pi').replaceAll('π', 'pi').replaceAll('，', ',').replaceAll('（', '(').replaceAll('）', ')');
}

export function presetOptions(preset) {
  return { ...TRAJECTORY_DEFAULTS, ...preset, parameters: Object.fromEntries((preset.parameters ?? []).map(entry => [entry.key, entry.value])) };
}

export function compileTrajectory(input = {}) {
  const options = { ...TRAJECTORY_DEFAULTS, ...input };
  const parameters = options.parameters ?? {};
  if (Array.isArray(parameters) || typeof parameters !== 'object' || Object.keys(parameters).length > 32) throw new Error('参数必须是至多 32 项的数值字典');
  for (const [key, value] of Object.entries(parameters)) if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) || !Number.isFinite(value)) throw new Error('自定义参数名或值无效');
  for (const key of ['trimStart', 'trimEnd', 'rotation', 'scaleX', 'scaleY', 'startX', 'startY', 'seed', 'randomness']) if (!Number.isFinite(Number(options[key]))) throw new Error(`${key} 必须为有限数字`);
  if (options.trimStart < 0 || options.trimEnd > 1 || options.trimEnd <= options.trimStart) throw new Error('截取范围须满足 0 ≤ 起点 < 终点 ≤ 1');
  for (const key of ['easingX', 'easingY']) if (!Number.isInteger(Number(options[key])) || options[key] < 1 || options[key] > 29) throw new Error('缓动编号须为 1–29');
  const scope = { ...parameters, seed: Number(options.seed), randomness: Number(options.randomness) };
  const expression = source => compileExpression(normalizeCurveExpression(source));
  const begin = expression(options.mode === 'polar' ? options.angleStart : options.parameterStart)(scope);
  const finish = expression(options.mode === 'polar' ? options.angleEnd : options.parameterEnd)(scope);
  const horizontal = options.mode === 'polar' || options.shape ? null : expression(options.xExpression);
  const vertical = options.mode === 'polar' || options.shape ? null : expression(options.yExpression);
  const radial = options.mode === 'polar' ? expression(options.radiusExpression) : null;
  const direction = !options.tangentRotation && options.rotationExpression?.trim() ? expression(options.rotationExpression) : null;
  const random = index => { const value = Math.sin(index * 127.1 + scope.seed * 311.7) * 43758.5453; return value - Math.floor(value); };
  const raw = progress => {
    const unit = Number(options.trimStart) + (Number(options.trimEnd) - Number(options.trimStart)) * progress;
    const coordinate = axis => begin + (finish - begin) * easing(unit, Number(options[axis === 'x' ? 'easingX' : 'easingY']));
    let point;
    if (options.shape) {
      const sides = Math.max(3, Math.min(40, Math.round(parameters.points ?? 5))) * (options.shape === 'star' ? 2 : 1);
      const amount = ((unit % 1) + 1) % 1 * sides; const index = Math.floor(amount); const fraction = amount - index;
      const vertex = step => { const wrapped = step % sides; const radius = (parameters.radius ?? 200) * (options.shape === 'star' ? (wrapped % 2 ? parameters.inner ?? 0.4 : 1) : 1 - scope.randomness * random(wrapped)); const angle = 2 * Math.PI * wrapped / sides; return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) }; };
      const first = vertex(index); const second = vertex(index + 1);
      point = { x: first.x + (second.x - first.x) * fraction, y: first.y + (second.y - first.y) * fraction };
    } else if (radial) {
      const theta = coordinate('x'); const radius = radial({ ...scope, theta, t: unit, u: progress });
      point = { x: radius * Math.cos(theta), y: radius * Math.sin(theta) };
    } else point = { x: horizontal({ ...scope, t: coordinate('x'), u: progress }), y: vertical({ ...scope, t: coordinate('y'), u: progress }) };
    const angle = Number(options.rotation) * Math.PI / 180;
    const horizontalValue = point.x * Number(options.scaleX); const verticalValue = point.y * Number(options.scaleY);
    return { x: horizontalValue * Math.cos(angle) - verticalValue * Math.sin(angle), y: horizontalValue * Math.sin(angle) + verticalValue * Math.cos(angle), rotation: direction ? direction({ ...scope, t: options.mode === 'polar' ? unit : coordinate('x'), theta: coordinate('x'), u: progress }) : 0 };
  };
  const first = raw(0);
  const tangent = progress => {
    for (const delta of [0.00001, 0.0001, 0.001, 0.01]) {
      const before = raw(Math.max(0, progress - delta)); const after = raw(Math.min(1, progress + delta));
      const horizontal = after.x - before.x; const vertical = after.y - before.y;
      if (Math.hypot(horizontal, vertical) > 1e-9) return -Math.atan2(vertical, horizontal) * 180 / Math.PI;
    }
    return null;
  };
  const angles = [];
  if (options.tangentRotation) {
    for (let index = 0; index <= 1024; index++) {
      const previous = angles.at(-1) ?? 0; const angle = tangent(index / 1024) ?? previous;
      angles.push(index ? angle + 360 * Math.round((previous - angle) / 360) : angle);
    }
  }
  return progress => {
    progress = Math.max(0, Math.min(1, progress));
    const point = raw(progress);
    if (options.tangentRotation) {
      const reference = angles[Math.round(progress * 1024)]; const angle = tangent(progress) ?? reference;
      point.rotation = angle + 360 * Math.round((reference - angle) / 360);
    }
    const result = { x: point.x + (options.alignStart ? Number(options.startX) - first.x : 0), y: point.y + (options.alignStart ? Number(options.startY) - first.y : 0), rotation: point.rotation };
    if (!Object.values(result).every(Number.isFinite)) throw new Error('曲线计算结果不是有限数字');
    return result;
  };
}

export function sampleCurveTrajectory(options = {}, count = 257) {
  if (!Number.isFinite(count) || count < 2 || count > 8193) throw new Error('轨迹采样数须为 2–8193');
  const evaluate = compileTrajectory(options); const length = Math.trunc(count);
  return Array.from({ length }, (unused, index) => ({ t: index / (length - 1), ...evaluate(index / (length - 1)) }));
}

export function validateCurvePreset(preset) {
  if (!preset || typeof preset !== 'object' || typeof preset.name !== 'string' || !preset.name.trim() || preset.name.length > 80) throw new Error('预设需要 1–80 字的名称');
  if (!Array.isArray(preset.parameters) || preset.parameters.length > 32) throw new Error('预设参数声明必须是数组，至多 32 项');
  const keys = new Set();
  for (const entry of preset.parameters) {
    if (!entry || keys.has(entry.key) || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(entry.key) || ['t', 'u', 'theta', 'pi', 'seed', 'randomness'].includes(entry.key) || !Number.isFinite(entry.value)) throw new Error('预设参数名重复、保留或默认值无效');
    keys.add(entry.key);
  }
  const clean = { name: preset.name.trim(), parameters: structuredClone(preset.parameters), category: '自定义' };
  for (const key of Object.keys(TRAJECTORY_DEFAULTS)) if (key !== 'parameters' && Object.hasOwn(preset, key)) clean[key] = structuredClone(preset[key]);
  if (['star', 'random-polygon'].includes(preset.shape)) clean.shape = preset.shape;
  sampleCurveTrajectory(presetOptions(clean), 257);
  return clean;
}

const compiledEvents = new WeakMap();
export function trajectoryEventValue(event, progress, axis = event.trajectoryAxis ?? 'x') {
  let evaluate = compiledEvents.get(event);
  if (!evaluate) { evaluate = compileTrajectory(event.trajectory.options); compiledEvents.set(event, evaluate); }
  return evaluate(progress)[axis];
}

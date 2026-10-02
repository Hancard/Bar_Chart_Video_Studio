/**
 * 帧序列构建与插值算法 —— 技术方案 §5.2 / §6.1 实现必读
 *
 * 抖动规避的本质（方案原文）：
 * 「长度插值」产生平滑增长，而「Y 由插值后的值实时排序决定」；
 * 条数变化瞬间的整组跳变，靠"相邻两步取并集 + 0 值补位"解决。
 *
 * 排名位置平滑（§6.1 增强）：
 * 每个 BarState 同时携带 prevRank / nextRank（前 / 后两步在各自 top-N 中的位置）
 * 和 opacity（入场淡入 / 出场淡出）。引擎层按 (progress) 在 prev→next 上做线性插值，
 * 当两个实体在两步之间发生排名反转、跨多位的进/出时，画面表现为"互相穿过"而不是
 * "瞬间跳位"，观感更柔顺。
 */
import type { SeriesPoint } from '@barstudio/shared';

export interface TimePoint {
  order: number;
  label: string;
}

export interface Dataset {
  /** 按 order 升序 */
  times: TimePoint[];
  /** order -> (entity -> value) */
  values: Map<number, Map<string, number>>;
  /** 实体（按首次出现顺序，用于稳定配色分配） */
  entities: string[];
  /** 全部 time_key 是否均为数值（决定 continuous 时间标签可用性） */
  numericTimes: boolean;
  /** 整个数据集所有 value 的最大绝对值（用于按 axisStep 算全局比例尺，避免刻度跳动） */
  maxAbs: number;
}

export interface BarState {
  entity: string;
  value: number;
  /** 显示用的 rank（按当前帧插值后值在并集中降序，1-based） */
  rank: number;
  /** 该实体在「前一步」top-N 中的位置；不在榜时 = maxBars + 1（虚拟榜外位置） */
  prevRank: number;
  /** 该实体在「后一步」top-N 中的位置；不在榜时 = maxBars + 1 */
  nextRank: number;
  /** 综合淡入淡出后的不透明度（0..1）：
   *  - 仅入场（prev 不在榜）→ opacity = t（线性从 0 增到 1）
   *  - 仅出场（next 不在榜）→ opacity = 1 - t（线性从 1 减到 0）
   *  - 同时进出（不可能；union 取并集保证至少一端在榜） → min(t, 1 - t)
   *  - 普通 → 1 */
  opacity: number;
}

export interface InterpFrame {
  /** 当前步标签（step 模式用，过渡中点切换） */
  timeLabel: string;
  /** 数值插值标签（continuous 模式用；时间点非数值时为 null） */
  timeLabelCont: string | null;
  bars: BarState[];
  /** 当前帧在「两端」之间的已缓动进度（0..1），供引擎复用避免重复计算 */
  progress: number;
}

export function buildDataset(points: SeriesPoint[]): Dataset {
  const values = new Map<number, Map<string, number>>();
  const times = new Map<number, string>();
  const entitySet = new Set<string>();
  let maxAbs = 0;

  for (const p of points) {
    if (!times.has(p.time_order)) times.set(p.time_order, p.time_key);
    if (!values.has(p.time_order)) values.set(p.time_order, new Map());
    values.get(p.time_order)!.set(p.entity, p.value);
    entitySet.add(p.entity);
    if (Number.isFinite(p.value)) {
      const av = Math.abs(p.value);
      if (av > maxAbs) maxAbs = av;
    }
  }

  // entities 的**顺序**决定配色（makeColorOf 按下标取色）。
  // 喂进来的 series 是按「time_order ASC, value DESC, entity ASC」排好的，
  // 若直接用出现顺序，切换值列会让后端重新排序 → 整套配色跟着重排，
  // 用户看到同一实体突然换了个颜色。这里按实体名做确定性排序，与值列彻底解耦。
  const entities = [...entitySet].sort((a, b) => a.localeCompare(b, 'zh'));

  const timeList = [...times.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([order, label]) => ({ order, label }));

  const numericTimes = timeList.length > 0 && timeList.every(t => Number.isFinite(Number(t.label)));

  return { times: timeList, values, entities, numericTimes, maxAbs };
}

/** 温和缓动：多步连播时平滑、单步内略有节奏（easeInOutSine） */
export function ease(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** time_order 总数 */
export function timeCount(ds: Dataset): number {
  return ds.times.length;
}

/**
 * 求任意（可为小数的）orderF 处的帧。
 * - k = floor(orderF)，t = orderF - k（步内原始进度 0..1），eased = ease(t)
 * - prevRank/nextRank：前/后两端各自 top-N 中的位置（不在榜时 = maxBars + 1）
 * - value = lerp(vA, vB, eased)，缺失端按 0 补位
 * - opacity：入场时 t 淡入、出场时 1-t 淡出，否则 1
 * - 显示 rank = 按 union 当前值降序后的 i + 1（用于文本；位置由 prev/next 插值决定）
 * - 绘制条数 = 取前 maxBars 名
 */
export function interpolate(ds: Dataset, orderF: number, maxBars: number): InterpFrame {
  const N = ds.times.length;
  if (N === 0) return { timeLabel: '', timeLabelCont: null, bars: [], progress: 0 };
  if (N === 1) {
    const m = ds.values.get(ds.times[0].order)!;
    const sorted = [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .slice(0, maxBars);
    // 只有一帧，不存在"入场/出场"过渡：prevRank / nextRank 必须落在本帧真实位置上。
    // 若填 maxBars+1（榜外），引擎的 y 插值会把条形算到 plotBottom 之下 → 整屏空白。
    const bars: BarState[] = sorted.map(([entity, value], i) => ({
      entity,
      value,
      rank: i + 1,
      prevRank: i + 1,
      nextRank: i + 1,
      opacity: 1,
    }));
    return { timeLabel: ds.times[0].label, timeLabelCont: null, bars, progress: 0 };
  }

  const k = Math.min(Math.max(Math.floor(orderF), 0), N - 2);
  const t = Math.min(Math.max(orderF - k, 0), 1);
  const eased = ease(t);

  const mapA = ds.values.get(ds.times[k].order)!;
  const mapB = ds.values.get(ds.times[k + 1].order)!;

  const rankedOf = (m: Map<string, number>): string[] =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .slice(0, maxBars)
      .map(([e]) => e);

  const rankedA = rankedOf(mapA);
  const rankedB = rankedOf(mapB);
  const union: string[] = [];
  const unionSet = new Set<string>();
  for (const e of rankedA) {
    if (!unionSet.has(e)) { unionSet.add(e); union.push(e); }
  }
  for (const e of rankedB) {
    if (!unionSet.has(e)) { unionSet.add(e); union.push(e); }
  }

  const OFF = maxBars + 1; // 虚拟"榜外"位置（用于入场 / 出场滑入滑出）

  // prev/next rank 快速查找（O(1) per entity）
  const rankOf = (arr: string[], e: string): number => {
    const i = arr.indexOf(e);
    return i >= 0 ? i + 1 : OFF;
  };

  const bars: BarState[] = [];
  for (const entity of union) {
    const vA = mapA.get(entity) ?? 0;
    const vB = mapB.get(entity) ?? 0;
    const prevRank = rankOf(rankedA, entity);
    const nextRank = rankOf(rankedB, entity);

    // opacity：入场用 t（线性淡入到 1）、出场用 1 - t（线性淡出）。两端任一在榜内另一端在榜外时互斥生效。
    let opacity = 1;
    if (prevRank === OFF && nextRank !== OFF) {
      opacity = t; // 新晋
    } else if (nextRank === OFF && prevRank !== OFF) {
      opacity = 1 - t; // 离场
    } else if (prevRank === OFF && nextRank === OFF) {
      // 理论上 union 取并集保证至少一端在榜，不会发生；防御性归 0
      opacity = 0;
    }

    bars.push({
      entity,
      value: lerp(vA, vB, eased),
      rank: 0,
      prevRank,
      nextRank,
      opacity,
    });
  }
  bars.sort((a, b) => b.value - a.value || a.entity.localeCompare(b.entity, 'zh'));
  const shown = bars.slice(0, maxBars);
  shown.forEach((b, i) => { b.rank = i + 1; });

  // 时间标签（方案 §6.2）：
  let timeLabel: string;
  let timeLabelCont: string | null = null;
  if (ds.numericTimes) {
    const a = Number(ds.times[k].label);
    const b = Number(ds.times[k + 1].label);
    timeLabelCont = String(Math.round(lerp(a, b, t) * 10) / 10);
    timeLabel = t >= 0.5 ? ds.times[k + 1].label : ds.times[k].label;
  } else {
    timeLabel = t >= 0.5 ? ds.times[k + 1].label : ds.times[k].label;
  }
  return { timeLabel, timeLabelCont, bars: shown, progress: eased };
}

/** 总时长（秒）：headHold + (N-1)*secondsPerStep + tailHold（方案 §6.2） */
export function totalDuration(ds: Dataset, secondsPerStep: number, headHold: number, tailHold: number): number {
  const N = ds.times.length;
  if (N === 0) return 0;
  return headHold + Math.max(N - 1, 0) * secondsPerStep + tailHold;
}

/** 播放进度 p ∈ [0,1] → orderF */
export function progressToOrderF(ds: Dataset, p: number, secondsPerStep: number, headHold: number, tailHold: number): number {
  const N = ds.times.length;
  if (N === 0) return 0;
  const total = totalDuration(ds, secondsPerStep, headHold, tailHold);
  const elapsed = Math.min(Math.max(p, 0), 1) * total;
  const segStart = headHold;
  const segLen = Math.max(N - 1, 0) * secondsPerStep;
  if (elapsed <= segStart) return 0;
  if (elapsed >= segStart + segLen) return N - 1;
  return (elapsed - segStart) / secondsPerStep;
}

/**
 * 计算"漂亮"的刻度步幅 — 当 axisStep 为 auto 时（即未指定或 ≤ 0）使用。
 * 目标：总刻度数控制在 3..7 之间；取整到 1 / 2 / 5 × 10^k 的形式。
 *  - 算出 rawStep ≈ maxAbs / 5
 *  - 选最接近 rawStep 的 1 / 2 / 5 幂倍数，作为 niceStep
 *  - 返回 niceStep；同时 ticks = ceil(maxAbs / niceStep)（最少 3）
 */
export function niceStepFromMax(maxAbs: number, targetTicks = 5): number {
  if (!Number.isFinite(maxAbs) || maxAbs <= 0) return 1;
  const raw = maxAbs / Math.max(targetTicks, 1);
  // 1 / 2 / 5 系数
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const ratio = raw / base; // ∈ [1, 10)
  let coef = 1;
  if (ratio >= 5) coef = 5;
  else if (ratio >= 2) coef = 2;
  return coef * base;
}

/** 1 / 2 / 5 × 10^k 阶梯上的下一档（用于放大 step 以压缩刻度数） */
export function nextNiceStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 1;
  const exp = Math.floor(Math.log10(step));
  const base = Math.pow(10, exp);
  const ratio = step / base;
  if (ratio < 1.5) return 2 * base;
  if (ratio < 3.5) return 5 * base;
  return 10 * base;
}

/** auto 模式下允许的最大"格数"（刻度点 = n + 1，含 0） */
const MAX_AUTO_STEPS = 8;

/**
 * 根据 axisStep 与全局 maxAbs 计算最终 scaleMax 与可见 ticks 列表。
 * - axisStep <= 0：自动 nice step（1/2/5 × 10^k），刻度落在 step 的整数倍上
 * - axisStep > 0：scaleMax = ceil(maxAbs / axisStep) × axisStep；刻度 = 0、step、2·step…（严格整数倍）
 *
 * 返回 { scaleMax, ticks, step }；ticks 至少含 0。
 */
export interface ScaleResult { scaleMax: number; ticks: number[]; step: number; }
export function computeScale(maxAbs: number, axisStep: number | undefined, targetTicks = 5): ScaleResult {
  const m = Number.isFinite(maxAbs) && maxAbs > 0 ? maxAbs : 1;

  if (axisStep && axisStep > 0) {
    const step = axisStep;
    // 步幅过小导致刻度爆炸（>40 格）时放弃用户步幅，退回 auto，避免画满整排刻度
    if (Math.ceil(m / step) <= 40) {
      const scaleMax = Math.max(Math.ceil(m / step) * step, step);
      const n = Math.round(scaleMax / step);
      const ticks: number[] = [];
      for (let i = 0; i <= n; i++) ticks.push(step * i);
      return { scaleMax, ticks, step };
    }
  }

  // auto：先按 nice step 试算；格数过多时把 step 放大到下一档，直到格数 ≤ MAX_AUTO_STEPS。
  //
  // 注意：**不能**用 min(MAX, n) 去截断 ticks —— 那样 ticks 的末位会小于 scaleMax，
  // 表现为轴顶没有刻度、而且柱会画到最后一根网格线之外（maxAbs=950、1900、4900… 都会命中）。
  let step = niceStepFromMax(m, targetTicks);
  let scaleMax = Math.max(Math.ceil((m * 1.05) / step) * step, step);
  for (let guard = 0; Math.round(scaleMax / step) > MAX_AUTO_STEPS && guard < 10; guard++) {
    step = nextNiceStep(step);
    scaleMax = Math.max(Math.ceil((m * 1.05) / step) * step, step);
  }
  const n = Math.max(1, Math.round(scaleMax / step));
  const ticks: number[] = [];
  for (let i = 0; i <= n; i++) ticks.push(step * i);
  return { scaleMax, ticks, step };
}

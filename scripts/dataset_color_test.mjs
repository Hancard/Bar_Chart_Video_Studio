#!/usr/bin/env node
/**
 * 配色稳定性回归
 *
 * 运行：node --import tsx scripts/dataset_color_test.mjs
 *
 * 背景：颜色是按 `dataset.entities` 的**数组下标**分配的（makeColorOf）。
 * 而 entities 的顺序原来取自「输入行的出现顺序」，输入又是后端按
 * `time_order ASC, value DESC, entity ASC` 排好的 series ——
 * 于是用户切换值列后（后端重新排序）整套配色跟着重排，同一实体突然换了颜色。
 * 修复：buildDataset 里按实体名做确定性排序，与值列 / 时间点顺序解耦。
 */
import { buildDataset } from '../packages/frontend/src/renderer/frames.ts';
import { makeColorOf, getPalette } from '../packages/frontend/src/renderer/palettes.ts';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

const pal = getPalette('flat');
const ENTITIES = ['北京', '上海', '广州', '深圳'];

function rows(times, valueOf) {
  const out = [];
  times.forEach((t, o) => {
    // 后端返回顺序：值降序，同分按 entity
    const items = ENTITIES.map(e => ({ e, v: valueOf(e, t) }))
      .sort((a, b) => b.v - a.v || a.e.localeCompare(b.e, 'zh'));
    for (const it of items) out.push({ time_key: t, time_order: o, entity: it.e, value: it.v });
  });
  return out;
}

// 1) 单时间点：两个"值列"给出完全相反的排名
{
  const A = buildDataset(rows(['2020'], e => ({ 北京: 30, 上海: 20, 广州: 10, 深圳: 5 }[e])));
  const B = buildDataset(rows(['2020'], e => ({ 北京: 5, 上海: 10, 广州: 20, 深圳: 30 }[e])));
  assert(A.entities.join(',') === B.entities.join(','),
    'entities 顺序与取值无关（不再随值降序变化）',
    `${A.entities.join(',')} vs ${B.entities.join(',')}`);
  const cA = makeColorOf(A.entities, pal), cB = makeColorOf(B.entities, pal);
  const changed = ENTITIES.filter(e => cA(e) !== cB(e));
  assert(changed.length === 0, '切换值列后同一实体颜色不变', changed.map(e => `${e}: ${cA(e)}→${cB(e)}`).join('; '));
}

// 2) 多时间点：第一个时间点的排名不同也不能影响顺序
{
  const A = buildDataset(rows(['2019', '2020', '2021'], (e, t) => ({ 北京: 9, 上海: 8, 广州: 7, 深圳: 6 }[e])));
  const B = buildDataset(rows(['2019', '2020', '2021'], (e) => ({ 北京: 1, 上海: 2, 广州: 3, 深圳: 4 }[e])));
  assert(A.entities.join(',') === B.entities.join(','), '多时间点下顺序同样稳定');
  const cA = makeColorOf(A.entities, pal), cB = makeColorOf(B.entities, pal);
  assert(ENTITIES.every(e => cA(e) === cB(e)), '多时间点下颜色映射一致');
}

// 3) 顺序应是确定性的（同一输入多次构建结果相同），且与传入顺序无关
{
  const r = rows(['2020'], e => ({ 北京: 1, 上海: 2, 广州: 3, 深圳: 4 }[e]));
  const d1 = buildDataset(r);
  const d2 = buildDataset([...r].reverse());
  assert(d1.entities.join(',') === d2.entities.join(','),
    '打乱输入行顺序不影响 entities 顺序',
    `${d1.entities.join(',')} vs ${d2.entities.join(',')}`);
}

// 4) 颜色分配本身仍要覆盖所有实体、且互不重复（回调了调色板容量逻辑）
{
  const many = Array.from({ length: 30 }, (_, i) => `实体${i}`);
  const d = buildDataset(many.flatMap((e, i) => [{ time_key: '2020', time_order: 0, entity: e, value: i + 1 }]));
  const c = makeColorOf(d.entities, pal);
  const colors = d.entities.map(e => c(e));
  assert(new Set(colors).size === colors.length,
    '30 个实体（超出 18 色调色板）颜色互不重复',
    `重复 ${colors.length - new Set(colors).size} 个`);
  assert(d.entities.length === 30, '实体数量正确', String(d.entities.length));
}

// 5) 未知实体回落到首个颜色，不应抛错
{
  const d = buildDataset(rows(['2020'], () => 1));
  const c = makeColorOf(d.entities, pal);
  let err = null;
  try { c('不存在的实体'); } catch (e) { err = e; }
  assert(err === null && typeof c('不存在的实体') === 'string',
    '查询未知实体不抛错，回落为字符串颜色', String(err?.message ?? ''));
}

console.log(`\n配色稳定性回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

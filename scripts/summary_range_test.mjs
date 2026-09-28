#!/usr/bin/env node
/**
 * summary 的时间范围回归
 *
 * 运行：node scripts/summary_range_test.mjs（需后端在跑）
 *
 * 背景：getSummary 原来用 SQL 的 MIN(time_key) / MAX(time_key) 取时间范围，
 * 而 time_key 是 TEXT —— 比较走**字典序**：
 *   月份 1..12        → max = "9"
 *   2024-1..2024-12   → max = "2024-2"
 * 前端摘要因此会显示「2024-1 ~ 2024-2」这种明显错误的区间。
 * 修复后改为按 time_order（入库时算好的时间顺序）取首尾。
 */
import { apiBase, installAutoCleanup } from './lib-test-utils.mjs';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

const BASE = apiBase();
const cleanup = await installAutoCleanup(BASE);

const { data: proj } = await (await fetch(`${BASE}/projects`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: '时间范围回归' }),
})).json();
const pid = proj.id;

async function importTimes(times) {
  const rows = times.map((t, i) => ({ time_key: t, entity: 'E', value: i + 1 }));
  const r = await fetch(`${BASE}/projects/${pid}/datasets/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  if (r.status !== 201) throw new Error(`import 失败 ${r.status}: ${(await r.text()).slice(0, 120)}`);
}
async function summary() {
  return (await (await fetch(`${BASE}/projects/${pid}/datasets/summary`)).json()).data;
}

// 1) 月份标签 1..12 —— 字典序 MAX 会得到 "9"
{
  await importTimes(Array.from({ length: 12 }, (_, i) => String(i + 1)));
  const s = await summary();
  assert(s.timeMin === '1' && s.timeMax === '12',
    '月份 1..12：timeMin=1 / timeMax=12（不是字典序的 9）',
    `实际 ${s.timeMin} ~ ${s.timeMax}`);
}

// 2) 年月标签 2024-1 .. 2024-12 —— 字典序 MAX 会得到 "2024-2"
{
  await importTimes(Array.from({ length: 12 }, (_, i) => `2024-${i + 1}`));
  const s = await summary();
  assert(s.timeMin === '2024-1' && s.timeMax === '2024-12',
    '年月 2024-1..2024-12：timeMax=2024-12（不是字典序的 2024-2）',
    `实际 ${s.timeMin} ~ ${s.timeMax}`);
}

// 3) 等宽年份（字典序恰好正确）—— 作为对照，确保改动没有把原本正确的搞坏
{
  await importTimes(['1990', '2000', '2010', '2020']);
  const s = await summary();
  assert(s.timeMin === '1990' && s.timeMax === '2020',
    '等宽年份 1990..2020：范围仍然正确（对照组）',
    `实际 ${s.timeMin} ~ ${s.timeMax}`);
}

// 4) 非数值标签（按首现顺序）—— 首尾应等于导入顺序的首尾
{
  await importTimes(['第一季度', '第二季度', '第三季度', '第四季度']);
  const s = await summary();
  assert(s.timeMin === '第一季度' && s.timeMax === '第四季度',
    '中文标签按首现顺序取首尾',
    `实际 ${s.timeMin} ~ ${s.timeMax}`);
}

// 5) 空数据集不能报错
{
  await fetch(`${BASE}/projects/${pid}/datasets`, { method: 'DELETE' });
  const s = await summary();
  assert(s.timeMin === null && s.timeMax === null && s.timeCount === 0,
    '空数据集：timeMin/timeMax 为 null，不抛错',
    JSON.stringify({ min: s.timeMin, max: s.timeMax, n: s.timeCount }));
}

await cleanup();
console.log(`\n时间范围回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

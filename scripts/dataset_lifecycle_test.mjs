#!/usr/bin/env node
/**
 * 数据集生命周期回归：导入 → 清空 → 重新导入
 *
 * 运行：node scripts/dataset_lifecycle_test.mjs（需后端在跑）
 *
 * 覆盖两处修复：
 *  1) DELETE /projects/:id/datasets 以前只删 time_series，不清 datasets_meta ——
 *     清空数据后 GET /datasets 仍返回上一次的多值列清单，前端「值列」下拉里留着
 *     已经不存在的数据列。现在 meta（和预留的 entities）一起清。
 *  2) 该端点原来不校验项目是否存在，删不存在的项目返回 200 + deleted:0，
 *     与同文件其它端点（404）不一致。
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
  body: JSON.stringify({ title: '数据集生命周期' }),
})).json();
const pid = proj.id;

const getDatasets = async () => (await (await fetch(`${BASE}/projects/${pid}/datasets`)).json()).data;
const getSummary = async () => (await (await fetch(`${BASE}/projects/${pid}/datasets/summary`)).json()).data;
const delDatasets = async () => fetch(`${BASE}/projects/${pid}/datasets`, { method: 'DELETE' });

// 1) 多值导入 → 值列清单应是多值
{
  const r = await fetch(`${BASE}/projects/${pid}/datasets/import-multi`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rows: [
        { time_key: '2020', entity: 'A', values: { 原始: 10, 插值: 11, 填补: 12 } },
        { time_key: '2020', entity: 'B', values: { 原始: 20, 插值: 21, 填补: 22 } },
      ],
      valueColumns: ['原始', '插值', '填补'],
      defaultValueColumn: '原始',
    }),
  });
  assert(r.status === 201, '多值导入成功', `status=${r.status}`);
  const d = await getDatasets();
  assert(d.valueColumns.length === 3 && d.effectiveValueColumn === '原始',
    '导入后值列清单 = [原始,插值,填补]', JSON.stringify(d.valueColumns));
}

// 2) 清空数据 → 值列清单必须回到默认，不能残留旧列
{
  const dr = await delDatasets();
  assert(dr.status === 200, '清空数据集成功', `status=${dr.status}`);
  const d = await getDatasets();
  assert(Array.isArray(d.valueColumns) && d.valueColumns.length === 1 && d.valueColumns[0] === 'value',
    '清空后值列清单回到默认 [value]（不残留已删除的多值列）', JSON.stringify(d.valueColumns));
  const s = await getSummary();
  assert(s.rowCount === 0 && s.timeCount === 0 && s.entityCount === 0 && s.timeMin === null,
    '清空后 summary 全零', JSON.stringify({ r: s.rowCount, t: s.timeCount, e: s.entityCount }));
  assert(s.valueColumns.length === 1 && s.valueColumns[0] === 'value',
    '清空后 summary 的值列也回到默认', JSON.stringify(s.valueColumns));
}

// 3) 清空后可重新导入单值
{
  const r = await fetch(`${BASE}/projects/${pid}/datasets/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows: [
      { time_key: '2021', entity: 'X', value: 5 },
      { time_key: '2022', entity: 'X', value: 9 },
    ] }),
  });
  assert(r.status === 201, '清空后可重新导入', `status=${r.status}`);
  const d = await getDatasets();
  assert(d.valueColumns[0] === 'value' && d.series.length === 2,
    '重新导入后是单值数据集', JSON.stringify({ cols: d.valueColumns, n: d.series.length }));
}

// 4) 对不存在的项目清空 → 404（以前是 200 + deleted:0）
{
  const r = await fetch(`${BASE}/projects/999999/datasets`, { method: 'DELETE' });
  assert(r.status === 404, '清空不存在的项目 → 404（与其它端点一致）', `status=${r.status}`);
  const r2 = await fetch(`${BASE}/projects/abc/datasets`, { method: 'DELETE' });
  assert(r2.status === 404, '非数字 id 清空 → 404', `status=${r2.status}`);
}

await cleanup();
console.log(`\n数据集生命周期回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

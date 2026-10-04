#!/usr/bin/env node
/**
 * 项目列表的查询次数回归（N+1 守卫）
 *
 * 运行：S:\nodejs\node.exe --import tsx scripts/projects_query_test.mjs
 *      （import 了后端模块，必须 Node 24）
 *
 * 背景：GET /projects 曾对每个项目单独跑 COUNT，项目一多就是 N+1：
 *   - recordCount：每个项目一次 SELECT COUNT(*) FROM records（已在上一轮修成 GROUP BY）
 *   - hasData：每个项目一次 SELECT COUNT(*) FROM time_series（本轮才修）
 * 这里用 Fastify 的 inject 在同进程打真实路由，并劫持 db.prepare 统计查询条数 ——
 * 查询次数必须是个与项目数无关的小常数，否则说明 N+1 又回来了。
 */
import Fastify from 'fastify';
import db from '../packages/backend/src/db.ts';
import { projectRoutes } from '../packages/backend/src/routes/projects.ts';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

const app = Fastify();
await app.register(projectRoutes);

// 劫持 db.prepare 计数（路由用的是同一个 db 实例，所以能统计到）
let queryCount = 0;
const origPrepare = db.prepare.bind(db);
db.prepare = (sql) => { queryCount++; return origPrepare(sql); };

const res = await app.inject({ method: 'GET', url: '/projects' });
const body = res.json();
const list = body.data ?? [];
const n = list.length;
const used = queryCount;

console.log(`项目数：${n}，GET /projects 共执行 ${used} 条查询\n`);

// 修复前是 3 + N（list + 每个项目一次 records COUNT + 每个项目一次 hasData COUNT），
// 修复后是固定 4 条：projects / records GROUP BY / time_series DISTINCT （+ toInfo 里偶尔的按需查询）
assert(used <= 6,
  '查询次数是与项目数无关的小常数（N+1 已消除）',
  `项目 ${n} 个却用了 ${used} 条查询；修复前约为 ${3 + n * 2} 条`);
// 样本量只为证明"次数不随项目数增长"，2 个就够（历史上库里有过 49 个测试项目，
// 后来被清掉了，所以这里的下限不能定太高）
assert(n >= 2, `样本量足够（当前 ${n} 个项目）`, `只有 ${n} 个`);

// hasData 的正确性：列表里的值必须和单条详情一致
const sample = list.slice(0, 8);
let mismatched = [];
for (const p of sample) {
  const one = (await app.inject({ method: 'GET', url: `/projects/${p.id}` })).json().data;
  if (Boolean(one.hasData) !== Boolean(p.hasData) || one.recordCount !== p.recordCount) {
    mismatched.push(`#${p.id} list(${p.hasData}/${p.recordCount}) vs detail(${one.hasData}/${one.recordCount})`);
  }
}
assert(mismatched.length === 0, '列表里的 hasData / recordCount 与单条详情一致', mismatched.join('; '));

const withData = list.filter((p) => p.hasData);
assert(withData.length > 0, '至少有一个项目被判定为「有数据」（说明批量查询真的查到了）',
  `hasData=true 的有 ${withData.length} 个`);
console.log(`  （${withData.length}/${n} 个项目有数据）`);

// 空库/无数据时的边界：全部 hasData=false 也不能报错
{
  const only = await app.inject({ method: 'GET', url: '/projects/999999' });
  assert(only.statusCode === 404, '不存在的项目仍返回 404', `status=${only.statusCode}`);
}

await app.close();
db.prepare = origPrepare;

console.log(`\n项目列表查询回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * 加载项目失败的错误态回归
 *
 * 运行：node --import tsx scripts/store_load_error_test.mjs
 *
 * 背景：store.loadProject 原来没有 catch —— 项目不存在、或后端根本没启动时，
 * 异常会直接冒到页面 onMounted 的 async 函数里（Vue 只打一条 warn），
 * 页面停在半初始化状态（配置面板空白、图表不渲染），用户完全不知道发生了什么。
 */
import { createPinia, setActivePinia } from 'pinia';
import { useProjectStore } from '../packages/frontend/src/stores/project.ts';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

setActivePinia(createPinia());
const store = useProjectStore();

// 1) 项目不存在：后端 404 + 业务错误体
globalThis.fetch = async () => new Response(
  JSON.stringify({ error: { code: 'E_NOT_FOUND', message: '资源不存在' } }),
  { status: 404, headers: { 'content-type': 'application/json' } },
);
let threw = null;
try {
  await store.loadProject(99999);
} catch (e) {
  threw = e;
}
assert(threw === null, 'loadProject 失败不再把异常抛给组件 onMounted（避免半初始化白屏）',
  threw ? String(threw.message ?? threw) : '');
assert(typeof store.loadError === 'string' && store.loadError.includes('资源不存在'),
  '失败原因记录到 store.loadError（供 App 层提示）', `loadError="${store.loadError}"`);
assert(store.project === null && store.series.length === 0 && store.summary === null,
  '失败后清空半成品状态（project / series / summary）',
  `project=${store.project} series=${store.series.length} summary=${store.summary}`);

// 2) 后端没启动：/api 代理返回前端页面（HTML）
globalThis.fetch = async () => new Response('<!DOCTYPE html><html></html>', {
  status: 200, headers: { 'content-type': 'text/html' },
});
await store.loadProject(1);
assert(/后端|JSON|代理/.test(store.loadError),
  '后端未启动时给出可定位的提示（不是 undefined / whatwg）', `loadError="${store.loadError}"`);

// 3) 成功路径不应残留错误
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/\/datasets\/summary/.test(u)) {
    return new Response(JSON.stringify({ data: { rowCount: 0, timeCount: 0, entityCount: 0, timeMin: null, timeMax: null, missingValues: 0, valueColumns: ['value'], activeValueColumn: 'value' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (/\/datasets/.test(u)) {
    return new Response(JSON.stringify({ data: { series: [], valueColumns: ['value'], effectiveValueColumn: 'value' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (/\/records/.test(u)) {
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ data: { id: 1, title: 'ok', description: null, config: {}, dataset_hash: null, hasData: false, recordCount: 0, created_at: '', updated_at: '' } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
await store.loadProject(1);
assert(store.loadError === '', '成功加载后 loadError 为空（不残留上一次的失败信息）', `loadError="${store.loadError}"`);
assert(store.project !== null, '成功后 project 正常赋值', `project=${JSON.stringify(store.project)}`);

// 4) closeProject 必须清掉错误态，否则返回列表后错误卡片还在
globalThis.fetch = async () => new Response('', { status: 500, headers: { 'content-type': 'text/html' } });
await store.loadProject(2);
const hadError = store.loadError !== '';
store.closeProject();
assert(hadError && store.loadError === '', 'closeProject 清空 loadError（返回列表后不再显示错误卡片）',
  `close 后 loadError="${store.loadError}"`);

console.log(`\n加载错误态回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

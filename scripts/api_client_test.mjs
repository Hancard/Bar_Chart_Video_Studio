#!/usr/bin/env node
/**
 * 前端 REST client 响应处理回归
 *
 * 运行：node --import tsx scripts/api_client_test.mjs
 *
 * 背景：原来用 `res.json().catch(() => ({}))`，非 JSON 响应（后端没启动、
 * 或 /api 代理被指到前端页面返回 HTML）会被兜成 {}，调用方拿到的是 undefined
 * 而不是一个能定位问题的错误 —— 表现为白屏或 "Cannot read properties of undefined"。
 */
import { api, ApiError } from '../packages/frontend/src/api/client.ts';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

let nextResponse = null;
globalThis.fetch = async () => nextResponse;
const resp = (body, { status = 200, type = 'application/json' } = {}) =>
  new Response(body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body)), {
    status, headers: { 'content-type': type },
  });

async function expectError(fn, wantCode) {
  try {
    await fn();
    return { threw: false };
  } catch (e) {
    return { threw: true, code: e instanceof ApiError ? e.code : `not-ApiError(${e?.name})`, message: e?.message };
  }
}

// 1) 正常 { data } → 解出 data
nextResponse = resp({ data: { id: 7, title: 'x' } });
{
  const r = await api.get('/projects/7');
  assert(r?.id === 7, '正常响应解出 data', JSON.stringify(r));
}

// 2) 204 → undefined（不能当成错误）
nextResponse = new Response(null, { status: 204 });
{
  const r = await api.del('/records/1');
  assert(r === undefined, '204 返回 undefined 且不抛错', String(r));
}

// 3) 后端没启动/代理返回 HTML（200 + text/html）→ 明确报错，而不是 undefined
nextResponse = resp('<!DOCTYPE html><html><body>app</body></html>', { type: 'text/html' });
{
  const r = await expectError(() => api.get('/projects'), 'E_BAD_RESPONSE');
  assert(r.threw && r.code === 'E_BAD_RESPONSE', 'HTML 响应 → 抛 E_BAD_RESPONSE（不再静默返回 undefined）',
    `threw=${r.threw} code=${r.code}`);
}

// 4) 空响应体
nextResponse = resp('');
{
  const r = await expectError(() => api.get('/projects'), 'E_BAD_RESPONSE');
  assert(r.threw && r.code === 'E_BAD_RESPONSE', '空响应体 → 抛 E_BAD_RESPONSE', `threw=${r.threw} code=${r.code}`);
}

// 5) 业务错误 { error } + 4xx → 保留后端给的 code/message
nextResponse = resp({ error: { code: 'E_NOT_FOUND', message: '资源不存在' } }, { status: 404 });
{
  const r = await expectError(() => api.get('/projects/999'), 'E_NOT_FOUND');
  assert(r.threw && r.code === 'E_NOT_FOUND' && /资源不存在/.test(r.message ?? ''),
    '4xx 业务错误保留后端 code/message', `code=${r.code} msg=${r.message}`);
}

// 6) 200 但没有 data 字段 → 抛 E_BAD_RESPONSE（而不是把 undefined 交给调用方）
nextResponse = resp({ ok: true });
{
  const r = await expectError(() => api.get('/projects'), 'E_BAD_RESPONSE');
  assert(r.threw && r.code === 'E_BAD_RESPONSE', '200 缺 data 字段 → 抛 E_BAD_RESPONSE',
    `threw=${r.threw} code=${r.code}`);
}

// 7) data 显式为 null 是合法值
nextResponse = resp({ data: null });
{
  const r = await api.get('/projects/1/datasets/summary');
  assert(r === null, 'data:null 视为合法返回（不误报）', String(r));
}

// 8) uploadFile 同样受保护
nextResponse = resp('<html>oops</html>', { type: 'text/html' });
{
  const r = await expectError(() => api.uploadFile('/records/1/file', new Blob([new Uint8Array(4)]), 'a.mp4'), 'E_BAD_RESPONSE');
  assert(r.threw && r.code === 'E_BAD_RESPONSE', 'uploadFile 非 JSON 响应 → 抛 E_BAD_RESPONSE',
    `threw=${r.threw} code=${r.code}`);
}
nextResponse = resp({ data: { id: 3, size_bytes: 4 } }, { status: 201 });
{
  const r = await api.uploadFile('/records/1/file', new Blob([new Uint8Array(4)]), 'a.mp4');
  assert(r?.id === 3, 'uploadFile 正常响应解出 data', JSON.stringify(r));
}

// 9) fetch 抛网络错误（后端没启动）→ 包装成可定位的 ApiError
{
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const r = await expectError(() => api.get('/projects'), 'E_NETWORK');
  assert(r.threw && r.code === 'E_NETWORK',
    '网络层异常 → 抛 E_NETWORK（不再是裸的 Failed to fetch）', `threw=${r.threw} code=${r.code}`);
  assert(/后端/.test(r.message ?? ''), '错误信息里点明"后端可能未启动"', r.message);
  globalThis.fetch = async () => nextResponse;
}

// 10) uploadFile 的网络异常同样被包装
{
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const r = await expectError(
    () => api.uploadFile('/records/1/file', new Blob([new Uint8Array(1)]), 'a.mp4'), 'E_NETWORK');
  assert(r.threw && r.code === 'E_NETWORK', 'uploadFile 网络异常同样包成 E_NETWORK', `code=${r.code}`);
  globalThis.fetch = async () => nextResponse;
}

// 11) AbortError 必须原样抛出（调用方靠它区分"主动取消"，不能当成网络故障）
{
  globalThis.fetch = async () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  };
  let err = null;
  try { await api.get('/projects'); } catch (e) { err = e; }
  assert(err?.name === 'AbortError' && !(err instanceof ApiError),
    'AbortError 原样抛出（不被包成 E_NETWORK）',
    `name=${err?.name} isApiError=${err instanceof ApiError}`);
  globalThis.fetch = async () => nextResponse;
}

console.log(`\nAPI client 回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

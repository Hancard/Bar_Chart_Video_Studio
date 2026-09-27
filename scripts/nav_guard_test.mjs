#!/usr/bin/env node
/**
 * 路由守卫的导航决策回归
 *
 * 运行：node --import tsx scripts/nav_guard_test.mjs
 *
 * 背景：/projects/abc/edit 这类地址以前能进到页面 —— 各页会拿 Number('abc') = NaN
 * 去请求 /projects/NaN，后端 404，页面卡在错误态或白屏。
 * 决策逻辑抽到 router/guard.ts 的 decideNavigation()（纯函数），这里覆盖各种组合。
 */
import { decideNavigation } from '../packages/frontend/src/router/guard.ts';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

const fromRoute = (id) => ({ params: { id: String(id) } });
const toRoute = (id, tab) => ({ path: `/projects/${id}/${tab}`, params: { id: String(id) } });
const LIST = { path: '/', params: {} };

{
  const d = decideNavigation({ path: '/projects/abc/edit', params: { id: 'abc' } }, fromRoute(5), false);
  assert(d.action === 'redirect' && d.path === '/',
    ':id 非数字 → 重定向回项目列表（不再拿 NaN 去请求接口）', JSON.stringify(d));
}
{
  const bads = ['abc', '1.5', '-3', 'NaN', '1e3', '3a', ' '];
  const missed = bads.filter((bad) => {
    const d = decideNavigation({ path: `/projects/${bad}/data`, params: { id: bad } }, fromRoute(5), false);
    return d.action !== 'redirect';
  });
  assert(missed.length === 0, '非法 id 变体全部被拦截（abc / 1.5 / -3 / NaN / 1e3 / 3a / 空格）',
    `漏掉: ${missed.join(', ')}`);
}
{
  const d = decideNavigation({ path: '/projects/0/data', params: { id: '0' } }, fromRoute(5), false);
  assert(d.action !== 'redirect', '纯数字 id（含 0）放行，交由后端判定是否存在', JSON.stringify(d));
}
{
  const d = decideNavigation(toRoute(5, 'edit'), fromRoute(5), true);
  assert(d.action === 'allow', '同项目 tab 切换 → 放行且不问 dirty（dirty 也不弹窗）', JSON.stringify(d));
}
{
  const d = decideNavigation(toRoute(7, 'edit'), fromRoute(5), true);
  assert(d.action === 'close' && !!d.confirmMessage, '跨项目 + dirty → 关项目并弹确认', JSON.stringify(d));
}
{
  const d = decideNavigation(toRoute(7, 'edit'), fromRoute(5), false);
  assert(d.action === 'close' && !d.confirmMessage, '跨项目 + 未改动 → 直接关项目，不弹窗', JSON.stringify(d));
}
{
  const d = decideNavigation(LIST, fromRoute(5), true);
  assert(d.action === 'close' && /未保存/.test(d.confirmMessage ?? ''),
    '从项目回列表 + dirty → 关项目并弹确认', JSON.stringify(d));
}
{
  const d = decideNavigation(LIST, fromRoute(5), false);
  assert(d.action === 'close' && !d.confirmMessage, '从项目回列表 + 未改动 → 直接关', JSON.stringify(d));
}
{
  const d = decideNavigation(LIST, LIST, true);
  assert(d.action === 'allow', '未进入过项目（列表 ↔ 列表）→ 放行', JSON.stringify(d));
}

console.log(`\n导航守卫回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

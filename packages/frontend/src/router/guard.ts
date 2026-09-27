/**
 * 路由守卫的**决策部分**（纯函数，不碰 store / window，便于单测）。
 *
 * 触发 closeProject 的三种情况：
 *  1) 进入另一个不同 id 的项目页：旧项目关闭、新项目打开（各页 onMounted 自己 loadProject）
 *  2) 回到项目列表（/）
 *  3) 浏览器关窗：beforeunload，不经过这里
 */

export type GuardParams = Record<string, string | string[]>;

export type NavDecision =
  /** 放行，且不动当前项目 */
  | { action: 'allow' }
  /** 非法地址（如 /projects/abc/edit）：直接回项目列表 */
  | { action: 'redirect'; path: string }
  /** 需要关闭当前项目；confirmMessage 有值时必须先让用户确认，取消则阻止导航 */
  | { action: 'close'; confirmMessage?: string };

/**
 * @param to   目标路由（只要 path 与 params）
 * @param from 来源路由（只要 params）
 * @param dirty 当前草稿配置是否有未保存改动
 */
export function decideNavigation(
  to: { path: string; params: GuardParams },
  from: { params: GuardParams },
  dirty: boolean,
): NavDecision {
  // :id 必须是正整数。手输 /projects/abc/edit 时，各页会拿 Number('abc') = NaN 去请求
  // /projects/NaN —— 后端返回 404，页面就卡在错误态（或白屏）。
  const rawId = to.params.id;
  if (rawId !== undefined && !/^\d+$/.test(String(rawId))) {
    return { action: 'redirect', path: '/' };
  }

  const fromId = from.params.id ? Number(from.params.id) : null;
  const toId = to.params.id ? Number(to.params.id) : null;

  // 同项目内 tab 切（数据 ↔ 编辑器 ↔ 导出）—— 不关项目、不问 dirty
  if (fromId !== null && fromId === toId) return { action: 'allow' };

  // 跨项目跳转（项目 A → 项目 B）：关 A、开 B
  if (fromId !== null && toId !== null && fromId !== toId) {
    return {
      action: 'close',
      confirmMessage: dirty ? `当前项目（#${fromId}）有未保存的配置改动，确定放弃吗？` : undefined,
    };
  }

  // 离开项目回到列表
  if (fromId !== null && toId === null && to.path === '/') {
    return {
      action: 'close',
      confirmMessage: dirty ? '当前项目有未保存的配置改动。\n确定放弃并返回项目列表吗？' : undefined,
    };
  }

  return { action: 'allow' };
}

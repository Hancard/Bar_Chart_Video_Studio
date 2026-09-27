import { createRouter, createWebHistory } from 'vue-router';
import { useProjectStore } from '../stores/project';
import { decideNavigation } from './guard';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'projects', component: () => import('../pages/ProjectList.vue') },
    { path: '/projects/:id/data', name: 'data', component: () => import('../pages/DataManage.vue') },
    { path: '/projects/:id/edit', name: 'edit', component: () => import('../pages/Editor.vue') },
    { path: '/projects/:id/export', name: 'export', component: () => import('../pages/ExportPage.vue') },
    // 兜底：手输 / 点到坏链接时不该停在空白页
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

/**
 * 全局路由守门员：离开「项目内页面」前，若 draftConfig 是 dirty，弹 confirm。
 * 同时负责清空 store，并在地址非法（:id 非数字）时重定向回列表。
 *
 * 决策逻辑在 ./guard.ts 的 decideNavigation() 里（纯函数，有单测覆盖）。
 */
router.beforeEach(async (to, from) => {
  const store = useProjectStore();
  const decision = decideNavigation(to, from, store.dirty);

  if (decision.action === 'redirect') {
    return { path: decision.path, replace: true };
  }
  if (decision.action === 'close') {
    if (decision.confirmMessage && !window.confirm(decision.confirmMessage)) {
      return false; // 用户取消：留在原页面
    }
    store.closeProject(); // 各目标页 onMounted 自己 loadProject
  }
  return true;
});

export default router;

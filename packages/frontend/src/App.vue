<template>
  <div class="app-shell">
    <header class="app-header">
      <RouterLink to="/" class="brand">
        <span class="brand-mark">▊</span>
        <span class="brand-name">条形图竞赛工作室</span>
        <span class="brand-sub">Bar Chart Video Studio</span>
      </RouterLink>
      <nav class="app-nav" v-if="projectId">
        <RouterLink :to="`/projects/${projectId}/data`">数据</RouterLink>
        <RouterLink :to="`/projects/${projectId}/edit`">编辑器</RouterLink>
        <RouterLink :to="`/projects/${projectId}/export`">导出</RouterLink>
        <span class="dirty-mark" v-if="dirty" title="有未保存的配置改动">●</span>
        <button
          v-if="projectId"
          class="close-btn"
          type="button"
          @click="onClose"
          aria-label="关闭当前项目，返回项目列表"
          title="关闭当前项目"
        >
          关闭项目
        </button>
      </nav>
    </header>
    <main class="app-main">
      <!-- 加载项目失败（项目不存在 / 后端没启动 / 接口异常）：
           给出原因和出口，否则页面会停在半初始化的空白状态，用户不知道发生了什么 -->
      <div v-if="loadError" class="load-error">
        <div class="card">
          <h3>加载项目失败</h3>
          <p class="le-msg">{{ loadError }}</p>
          <p class="le-hint">常见原因：后端服务尚未启动，或该项目已被删除。</p>
          <div class="le-actions">
            <button class="primary" @click="backToList">返回项目列表</button>
          </div>
        </div>
      </div>
      <RouterView v-else />
    </main>
  </div>
</template>

<script setup lang="ts">
/**
 * App root 与导航（方案 §2.3 页面骨架）
 * 顶部 nav 显示项目内三个 tab + 「关闭项目」。
 * 关闭项目时若有未保存改动（store.dirty=true）必须弹确认；
 * 同步注册 beforeunload 防止浏览器关窗丢失草稿。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { useProjectStore } from './stores/project';

const store = useProjectStore();
const route = useRoute();
const router = useRouter();

const projectId = computed(() => (route.params.id ? Number(route.params.id) : null));
const dirty = computed(() => store.dirty);
const loadError = computed(() => store.loadError);

/** 错误页的出口：关掉当前项目（顺带清掉 loadError）再回列表 */
async function backToList() {
  store.closeProject();
  await router.push('/');
}

/** 关闭当前项目。先检查 dirty，再决定是否弹 confirm */
async function onClose() {
  if (store.dirty) {
    const ok = window.confirm(
      '当前项目有未保存的配置改动。\n\n确定要放弃这些改动并返回项目列表吗？',
    );
    if (!ok) return;
  }
  store.closeProject();
  await router.push('/');
}

/** 浏览器关窗 / 刷新页面前的全局守门员 */
function beforeUnload(e: BeforeUnloadEvent) {
  if (!store.dirty) return;
  e.preventDefault();
  e.returnValue = '有未保存的配置改动，确定离开吗？';
}

onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
</script>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: 52px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  position: sticky;
  top: 0;
  z-index: 10;
}
.brand { display: flex; align-items: baseline; gap: 10px; text-decoration: none; color: var(--text); }
.brand-mark { color: var(--accent); font-weight: 800; font-size: 22px; }
.brand-name { font-weight: 700; font-size: 16px; }
.brand-sub { font-size: 12px; color: var(--sub); }
.app-nav { display: flex; gap: 4px; align-items: center; }
.app-nav a {
  padding: 6px 14px; border-radius: 8px; text-decoration: none;
  color: var(--sub); font-size: 14px; font-weight: 500;
}
.app-nav a.router-link-active { background: var(--accent-soft); color: var(--accent); }
.dirty-mark {
  color: var(--accent, #f59e0b);
  font-size: 12px;
  margin: 0 6px 0 4px;
  animation: dirty-pulse 2s ease-in-out infinite;
}
@keyframes dirty-pulse { 0%, 100% { opacity: 0.5 } 50% { opacity: 1 } }
.close-btn {
  margin-left: 8px;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.close-btn:hover { background: var(--accent-soft, rgba(99,102,241,0.08)); border-color: var(--accent, #6366f1); }
.app-main { min-height: calc(100vh - 52px); }
.load-error { display: flex; justify-content: center; padding: 64px 24px; }
.load-error .card { width: 520px; max-width: 100%; }
.load-error h3 { margin: 0 0 12px; }
.le-msg {
  margin: 0 0 10px; padding: 10px 12px; border-radius: 8px;
  background: var(--bg); color: var(--text);
  font-size: 13px; word-break: break-all;
}
.le-hint { margin: 0; color: var(--sub); font-size: 13px; }
.le-actions { display: flex; justify-content: flex-end; margin-top: 18px; }
</style>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">我的项目</h1>
      <button class="primary" @click="createOpen = true">＋ 新建项目</button>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="loadError" class="empty card">
      加载项目列表失败：{{ loadError }}
      <div style="margin-top: 10px"><button @click="load">重试</button></div>
    </div>
    <div v-else-if="projects.length === 0" class="empty card">
      还没有项目。点击右上角「新建项目」，然后导入 CSV / Excel 或粘贴表格开始制作。
    </div>

    <div v-else class="project-grid">
      <div v-for="p in projects" :key="p.id" class="card project-card">
        <div class="pc-head">
          <RouterLink class="pc-title" :to="`/projects/${p.id}/data`">{{ p.title }}</RouterLink>
          <span v-if="p.recordCount > 0" class="tag ok">{{ p.recordCount }} 个成片</span>
          <span v-else class="tag">未出片</span>
        </div>
        <div class="pc-desc">{{ p.description || '（无描述）' }}</div>
        <div class="pc-meta">
          <span :class="['tag', p.hasData ? 'ok' : 'warn']">{{ p.hasData ? `已导入数据（${p.config.maxBars} 条上限）` : '无数据' }}</span>
          <span class="pc-time">更新于 {{ formatLocalTime(p.updated_at) }}</span>
        </div>
        <div class="pc-actions">
          <RouterLink class="pc-link" :to="`/projects/${p.id}/data`">数据</RouterLink>
          <RouterLink class="pc-link" :to="`/projects/${p.id}/edit`">编辑器</RouterLink>
          <RouterLink class="pc-link primary-link" :to="`/projects/${p.id}/export`">导出</RouterLink>
          <button class="ghost danger" @click="removeProject(p)">删除</button>
        </div>
      </div>
    </div>

    <!-- 新建项目对话框 -->
    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <div class="modal card">
        <h3>新建项目</h3>
        <label class="field">
          <span>项目标题</span>
          <input v-model="createForm.title" type="text" placeholder="如：2015-2024 中国手机厂商出货量" />
        </label>
        <label class="field" style="margin-top: 12px">
          <span>描述（可选）</span>
          <textarea v-model="createForm.description" rows="2" placeholder="备注这条视频的主题 / 数据来源"></textarea>
        </label>
        <label class="field" style="margin-top: 12px">
          <span>视频大标题（渲染配置，之后可改）</span>
          <input v-model="createForm.titleRender" type="text" placeholder="如：谁是中国手机出货量之王？" />
        </label>
        <div class="modal-actions">
          <button @click="createOpen = false">取消</button>
          <button class="primary" :disabled="!createForm.title.trim() || creating" @click="createProject">
            {{ creating ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ProjectInfo } from '@barstudio/shared';
import { formatLocalTime } from '@barstudio/shared';
import { api } from '../api/client';

const router = useRouter();
const projects = ref<ProjectInfo[]>([]);
const loading = ref(true);
const loadError = ref('');
const createOpen = ref(false);
const creating = ref(false);
const createForm = ref({ title: '', description: '', titleRender: '' });

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    projects.value = await api.get<ProjectInfo[]>('/projects');
  } catch (err: any) {
    // 不能让"请求失败"和"确实没有项目"落到同一个空列表界面上
    loadError.value = err?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

async function createProject() {
  if (creating.value) return;
  creating.value = true;
  try {
    const p = await api.post<ProjectInfo>('/projects', {
      title: createForm.value.title.trim(),
      description: createForm.value.description.trim() || undefined,
      config: createForm.value.titleRender.trim()
        ? { title: createForm.value.titleRender.trim(), sourceNote: '数据来源：' }
        : undefined,
    });
    router.push(`/projects/${p.id}/data`);
  } catch (err: any) {
    alert(`创建失败：${err?.message ?? err}`);
  } finally {
    creating.value = false;
  }
}

async function removeProject(p: ProjectInfo) {
  if (!confirm(`确定删除项目「${p.title}」？其数据与成片记录将一并删除。`)) return;
  try {
    await api.del(`/projects/${p.id}`);
  } catch (err: any) {
    alert(`删除失败：${err?.message ?? err}`);
    return;
  }
  await load();
}

onMounted(load);
</script>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.page-head .page-title { margin: 0; }
.project-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px;
}
.project-card { display: flex; flex-direction: column; gap: 10px; }
.pc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pc-title { font-size: 16px; font-weight: 700; color: var(--text); text-decoration: none; }
.pc-title:hover { color: var(--accent); }
.pc-desc { color: var(--sub); font-size: 13px; min-height: 18px; }
.pc-meta { display: flex; align-items: center; justify-content: space-between; }
.pc-time { font-size: 12px; color: var(--sub); }
.pc-actions { display: flex; gap: 6px; border-top: 1px solid var(--border); padding-top: 12px; }
.pc-link {
  padding: 5px 12px; border-radius: 7px; text-decoration: none;
  color: var(--sub); font-size: 13px; background: var(--bg);
}
.pc-link:hover { color: var(--accent); }
.pc-link.primary-link { background: var(--accent); color: #fff; }
.pc-link.primary-link:hover { color: #fff; opacity: 0.9; }
.pc-actions .ghost { margin-left: auto; font-size: 13px; }

.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.35);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal { width: 440px; }
.modal h3 { margin: 0 0 16px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
</style>

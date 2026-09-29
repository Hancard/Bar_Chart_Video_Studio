<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">{{ store.project?.title ?? '' }} · 导出</h1>
      <div class="head-actions">
        <RouterLink :to="`/projects/${projectId}/edit`"><button>← 编辑器</button></RouterLink>
      </div>
    </div>

    <div v-if="store.loading" class="empty">加载中…</div>
    <div v-else-if="!hasData" class="empty card">
      该项目还没有数据，无法导出。<RouterLink :to="`/projects/${projectId}/data`">先去导入 →</RouterLink>
    </div>

    <div v-else class="export-layout">
      <!-- 导出设置 -->
      <aside class="card export-panel">
        <h3>导出设置</h3>

        <label class="field"><span>分辨率</span>
          <select v-model="resPreset" @change="applyRes">
            <option value="1920x1080">横屏 1920×1080（推荐）</option>
            <option value="1080x1920">竖屏 1080×1920（抖音/视频号）</option>
            <option value="1280x720">横屏 1280×720</option>
            <option value="3840x2160">横屏 4K 3840×2160</option>
          </select>
        </label>

        <div class="row2">
          <label class="field"><span>帧率</span>
            <select v-model.number="cfg.fps">
              <option :value="24">24 fps</option>
              <option :value="30">30 fps</option>
              <option :value="60">60 fps</option>
            </select>
          </label>
          <label class="field"><span>码率</span>
            <select v-model.number="cfg.videoBitsPerSecond">
              <option :value="6_000_000">6 Mbps（小文件）</option>
              <option :value="8_000_000">8 Mbps（推荐）</option>
              <option :value="12_000_000">12 Mbps（高画质）</option>
              <option :value="16_000_000">16 Mbps（数值文本多）</option>
            </select>
          </label>
        </div>

        <div class="export-info">
          <div>成片时长 <b>{{ totalDur.toFixed(1) }}s</b></div>
          <div>尺寸 <b>{{ cfg.width }}×{{ cfg.height}}</b> @ {{ cfg.fps }}fps</div>
          <div>预计大小 <b>~{{ estSizeMB }} MB</b></div>
          <div>时间点 <b>{{ store.dataset.times.length }}</b> · 条数上限 <b>{{ cfg.maxBars }}</b></div>
        </div>

        <button v-if="!exporting" class="primary big" @click="startExport">开始导出视频</button>
        <button v-else class="danger big" @click="cancelExport">取消导出</button>

        <p class="export-warn">
          ⚠️ 录制期间请保持本标签页在前台（浏览器会暂停后台页面渲染）；
          导出过程约等于成片时长（{{ totalDur.toFixed(0) }}s）。若首次转码需下载 ~30MB 内核请耐心等待。
        </p>
      </aside>

      <!-- 导出进度 / 结果 -->
      <section class="card result-panel">
        <h3>导出进度</h3>

        <template v-if="!result">
          <div v-if="!exporting" class="empty">尚未开始导出</div>
          <div v-else class="progress-box">
            <div class="stage">{{ stageText }}</div>
            <div class="bar-track"><div class="bar-fill" :style="{ width: `${Math.round(progress * 100)}%` }"></div></div>
            <div class="pct">{{ (progress * 100).toFixed(0) }}%</div>
            <div class="stage-detail">{{ progressMessage }}</div>
          </div>
        </template>

        <template v-else>
          <div class="result-ok">
            ✅ 导出完成（{{ result.format.toUpperCase() }} · {{ (result.blob.size / 1024 / 1024).toFixed(1) }} MB ·
            {{ (result.durationMs / 1000).toFixed(1) }}s）
            <span v-if="result.format === 'webm'" class="tag warn">WebM 降级（ffmpeg 转码未成功，多数平台仍可上传）</span>
          </div>
          <video class="result-video" :src="resultUrl!" controls playsinline></video>
          <div class="result-actions">
            <a class="dl-btn primary" :href="resultUrl!" :download="result.fileName">下载 {{ result.format.toUpperCase() }}</a>
            <button :disabled="archiving" @click="archive">
              {{ archiving ? '存档中…' : '保存到作品记录' }}
            </button>
          </div>
        </template>

        <!-- 作品记录 -->
        <div class="records">
          <h4>作品记录</h4>
          <div v-if="store.records.length === 0" class="records-empty">暂无成片记录</div>
          <table v-else class="grid">
            <thead>
              <tr><th>#</th><th>导出时间</th><th>规格</th><th>时长</th><th>大小</th><th>存档</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="r in store.records" :key="r.id">
                <td>{{ r.id }}</td>
                <td>{{ r.created_at.slice(0, 16) }}</td>
                <td>{{ r.width }}×{{ r.height }}@{{ r.fps }}</td>
                <td>{{ (r.duration_ms / 1000).toFixed(1) }}s</td>
                <td>{{ (r.size_bytes / 1024 / 1024).toFixed(1) }} MB</td>
                <td>
                  <a v-if="r.file_path" :href="`/api/v1/records/${r.id}/file`" download>下载</a>
                  <span v-else class="tag">本地</span>
                </td>
                <td><button class="ghost danger" @click="removeRecord(r)">删除</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { RecordInfo } from '@barstudio/shared';
import { api } from '../api/client';
import { useProjectStore } from '../stores/project';
import { exportVideo, type ExportProgress, type ExportResult } from '../recorder/exporter';
import { totalDuration } from '../renderer/frames';

const route = useRoute();
const projectId = computed(() => Number(route.params.id));
const store = useProjectStore();

const hasData = computed(() => (store.summary?.rowCount ?? 0) > 0);
const cfg = store.draftConfig; // 导出以「当前配置」为唯一真源（方案 §3.4）

const resPreset = ref(`${cfg.width}x${cfg.height}`);
const exporting = ref(false);
const progress = ref(0);
const stageText = ref('');
const progressMessage = ref('');
const result = ref<ExportResult | null>(null);
const resultUrl = ref<string | null>(null);
const archiving = ref(false);

let abortController: AbortController | null = null;

const totalDur = computed(() => totalDuration(store.dataset, cfg.secondsPerStep, cfg.headHold, cfg.tailHold));
const estSizeMB = computed(() => ((cfg.videoBitsPerSecond / 8) * totalDur.value / 1024 / 1024).toFixed(0));

function applyRes() {
  const [w, h] = resPreset.value.split('x').map(Number);
  cfg.width = w;
  cfg.height = h;
}

async function startExport() {
  if (exporting.value) return;
  exporting.value = true;
  result.value = null;
  if (resultUrl.value) { URL.revokeObjectURL(resultUrl.value); resultUrl.value = null; }
  abortController = new AbortController();

  // 导出前把当前配置落库（快照语义）
  try { await store.saveConfig(); } catch { /* 保存失败不阻塞导出 */ }

  const onProgress = (p: ExportProgress) => {
    progress.value = p.progress;
    progressMessage.value = p.message;
    stageText.value =
      p.stage === 'prepare' ? '准备中' :
      p.stage === 'record' ? '录制中' :
      p.stage === 'transcode' ? '转码中（WebM → MP4）' :
      p.stage === 'done' ? '完成' : '';
  };

  try {
    const r = await exportVideo({
      config: { ...cfg },               // 冻结配置快照（方案 §6.3）
      dataset: store.dataset,
      palette: store.palette,
      colorOf: store.colorOf,
      onProgress,
      signal: abortController.signal,
    });
    result.value = r;
    resultUrl.value = URL.createObjectURL(r.blob);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      progressMessage.value = '已取消';
    } else {
      alert(`导出失败：${err?.message ?? err}`);
    }
  } finally {
    exporting.value = false;
    abortController = null;
  }
}

function cancelExport() {
  abortController?.abort();
}

/** 上报元数据 + 上传文件存档（可选，便于跨设备回看） */
async function archive() {
  if (!result.value) return;
  archiving.value = true;
  try {
    const rec = await api.post<RecordInfo>('/records', {
      project_id: projectId.value,
      config_snapshot: { ...cfg },
      duration_ms: result.value.durationMs,
      size_bytes: result.value.blob.size,
      // 传实际产出格式：不传的话后端默认 mp4，WebM 成片的下载后缀/Content-Type 都会是错的
      format: result.value.format,
    });
    await api.uploadFile(`/records/${rec.id}/file`, result.value.blob, result.value.fileName);
    await store.loadRecords();
  } catch (err: any) {
    alert(`存档失败：${err.message}`);
  } finally {
    archiving.value = false;
  }
}

async function removeRecord(r: RecordInfo) {
  if (!confirm(`删除作品记录 #${r.id}？`)) return;
  await api.del(`/records/${r.id}`);
  await store.loadRecords();
}

onMounted(async () => {
  await store.loadProject(projectId.value);
  resPreset.value = `${cfg.width}x${cfg.height}`;
});

onBeforeUnmount(() => {
  abortController?.abort();
  if (resultUrl.value) URL.revokeObjectURL(resultUrl.value);
});
</script>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.page-head .page-title { margin: 0; }
.export-layout { display: grid; grid-template-columns: 340px 1fr; gap: 16px; align-items: start; }
.export-panel h3, .result-panel h3 { margin: 0 0 12px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
.export-info {
  margin: 14px 0; padding: 12px 14px; background: var(--bg); border-radius: 8px;
  font-size: 13px; color: var(--sub); display: flex; flex-direction: column; gap: 4px;
}
.export-info b { color: var(--text); }
button.big { width: 100%; padding: 12px; font-size: 15px; margin-top: 4px; }
.export-warn { font-size: 12px; color: var(--warn); line-height: 1.7; margin: 12px 0 0; }

.progress-box { padding: 30px 0; text-align: center; }
.stage { font-size: 15px; font-weight: 700; margin-bottom: 14px; }
.bar-track { height: 12px; background: var(--bg); border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.2s; }
.pct { font-size: 26px; font-weight: 800; margin-top: 10px; font-family: 'Roboto Mono', monospace; }
.stage-detail { font-size: 13px; color: var(--sub); margin-top: 6px; min-height: 18px; }

.result-ok { font-size: 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.result-video { width: 100%; max-height: 460px; border-radius: 10px; background: #000; margin: 14px 0; }
.result-actions { display: flex; gap: 10px; }
.dl-btn {
  display: inline-flex; align-items: center; padding: 8px 18px; border-radius: 8px;
  text-decoration: none; font-size: 14px;
}

.records { margin-top: 26px; border-top: 1px solid var(--border); padding-top: 16px; }
.records h4 { margin: 0 0 10px; font-size: 14px; }
.records-empty { color: var(--sub); font-size: 13px; padding: 8px 0; }
</style>

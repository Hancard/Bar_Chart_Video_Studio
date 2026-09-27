/**
 * Pinia 项目 store：当前项目 / 时序数据 / 渲染配置草稿
 * 配置即改即生效（草稿暂存，「保存」才落库——方案 §3.2）
 *
 * 多值数据：服务端的 GET /datasets 现在返回
 *   { series: SeriesPoint[], valueColumns: string[], effectiveValueColumn: string }
 * store 把 SeriesPoint.values[] 和 valueColumn 暴露给 editor / renderer。
 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { DatasetSummary, ProjectInfo, RenderConfig, RecordInfo, SeriesPoint } from '@barstudio/shared';
import { DEFAULT_RENDER_CONFIG } from '@barstudio/shared';
import { api } from '../api/client';
import { buildDataset, type Dataset } from '../renderer/frames';
import { getPalette, makeColorOf, type Palette } from '../renderer/palettes';

export const useProjectStore = defineStore('project', () => {
  const project = ref<ProjectInfo | null>(null);
  const series = ref<SeriesPoint[]>([]);
  /** 当前数据集提供的可选"值列"（受 valueColumn 切换影响） */
  const valueColumns = ref<string[]>(['value']);
  /** 当前生效的"值列"名 */
  const activeValueColumn = ref<string>('value');
  const summary = ref<DatasetSummary | null>(null);
  const records = ref<RecordInfo[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  /** 加载项目失败的原因（项目不存在 / 后端没启动 / 接口异常），由 App 层统一提示 */
  const loadError = ref('');

  /** 渲染配置草稿（编辑器实时改，保存才写库） */
  const draftConfig = ref<RenderConfig>({ ...DEFAULT_RENDER_CONFIG });
  /** 当 cfg.valueColumn 与 activeValueColumn 不一致时是否需要持久化 */
  const dirty = ref(false);

  /**
   * dataset 始终用 cfg.valueColumn 的那条值（默认 'value'）。
   * 后端确保了不论请求哪个 valueColumn，SeriesPoint.values 字典都含所有候选值，
   * 我们按 cfg.valueColumn 抽取成单一数字列喂给渲染器。
   */
  const dataset = computed<Dataset>(() => {
    const col = draftConfig.value.valueColumn ?? activeValueColumn.value ?? 'value';
    const rows: { time_key: string; time_order: number; entity: string; value: number }[] =
      series.value.map(p => {
        let v: number;
        if (p.values && Object.prototype.hasOwnProperty.call(p.values, col)) {
          const raw = p.values[col];
          v = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
        } else if (col === 'value') {
          v = p.value;
        } else {
          v = 0;
        }
        return { time_key: p.time_key, time_order: p.time_order, entity: p.entity, value: v };
      });
    return buildDataset(rows);
  });

  const palette = computed<Palette>(() => getPalette(draftConfig.value.palette));
  const colorOf = computed(() => makeColorOf(dataset.value.entities, palette.value));

  // 加载中的程序化写入（loadProject/loadSeries 回填草稿）不计为用户改动，
  // 否则刚打开项目 dirty 就是 true，"保存配置"按钮常亮
  watch(draftConfig, () => { if (!loading.value) dirty.value = true; }, { deep: true });

  /**
   * 原地改写 draftConfig，**保持对象引用不变**。
   *
   * 为什么不能用 `draftConfig.value = {...}` 整体替换：
   * Editor.vue / ExportPage.vue 都写 `const cfg = store.draftConfig` 持有对象引用。
   * 一旦整体替换，消费方的引用会永久失联 —— 表现为：打开项目后配置面板显示默认值、
   * 编辑不回流到 store（保存无效 / 预览不更新）、dirty 恒为 false（保存按钮灰色、
   * 离开项目不提示）、导出拿到的仍是默认配置。
   * 这里先删掉 next 未覆盖的键再做 Object.assign，语义与整体替换等价。
   */
  function applyConfig(next: RenderConfig) {
    const target = draftConfig.value as unknown as Record<string, unknown>;
    for (const k of Object.keys(target)) {
      if (!(k in next)) delete target[k];
    }
    Object.assign(target, next);
  }

  async function loadProject(id: number) {
    loading.value = true;
    loadError.value = '';
    try {
      project.value = await api.get<ProjectInfo>(`/projects/${id}`);
      applyConfig({ ...DEFAULT_RENDER_CONFIG, ...project.value.config });
      dirty.value = false;
      await Promise.all([loadSeries(), loadRecords()]);
      // 把后端给的「当前默认列」回填到 draftConfig.valueColumn
      const vc = project.value.config.valueColumn;
      // 真实候选列要从 summary 拿。这里仅用于兜底（多值项目导入时会主动写过 cfg.valueColumn）
      if (vc && valueColumns.value.includes(vc)) {
        draftConfig.value.valueColumn = vc;
      }
    } catch (err: any) {
      // 不能让异常冒到组件的 onMounted —— Vue 只会打一条 warn，页面停在半初始化状态
      // （配置面板空白 / 图表不渲染），用户完全不知道发生了什么。
      loadError.value = err?.message ?? String(err);
      project.value = null;
      series.value = [];
      summary.value = null;
      records.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function loadSeries() {
    if (!project.value) return;
    const resp = await api.get<{ series: SeriesPoint[]; valueColumns: string[]; effectiveValueColumn: string }>(
      `/projects/${project.value.id}/datasets${draftConfig.value.valueColumn ? `?valueColumn=${encodeURIComponent(draftConfig.value.valueColumn)}` : ''}`
    );
    series.value = resp.series ?? (resp as unknown as SeriesPoint[]);
    valueColumns.value = resp.valueColumns ?? ['value'];
    activeValueColumn.value = resp.effectiveValueColumn ?? 'value';
    summary.value = await api.get<DatasetSummary>(`/projects/${project.value.id}/datasets/summary`);
    // 同步 summary 携带的多值信息
    if (summary.value) {
      valueColumns.value = summary.value.valueColumns ?? valueColumns.value;
      activeValueColumn.value = summary.value.activeValueColumn ?? activeValueColumn.value;
      // 把 cfg.valueColumn 在首次加载时回填为 summary 推荐的列
      if (!draftConfig.value.valueColumn) {
        draftConfig.value.valueColumn = activeValueColumn.value;
      }
    }
  }

  async function loadRecords() {
    records.value = await api.get<RecordInfo[]>(`/records?projectId=${project.value?.id ?? ''}`);
  }

  /** 单值导入 */
  async function importRows(rows: { time_key: string; entity: string; value: number }[]) {
    if (!project.value) return;
    await api.post(`/projects/${project.value.id}/datasets/import`, { rows });
    await loadSeries();
    // 单值导入：回到默认值 valueColumn='value'
    if (draftConfig.value.valueColumn && draftConfig.value.valueColumn !== 'value') {
      draftConfig.value.valueColumn = 'value';
      await saveConfig();
    }
    const fresh = await api.get<ProjectInfo>(`/projects/${project.value.id}`);
    project.value = { ...project.value, dataset_hash: fresh.dataset_hash, updated_at: fresh.updated_at, hasData: fresh.hasData };
  }

  /** 多值导入 */
  async function importMultiValue(
    rows: { time_key: string; entity: string; values: Record<string, number | null> }[],
    valueColumnsList: string[],
    defaultValueColumn: string,
  ) {
    if (!project.value) return;
    await api.post(`/projects/${project.value.id}/datasets/import-multi`, {
      rows,
      valueColumns: valueColumnsList,
      defaultValueColumn,
    });
    await loadSeries();
    // 多值导入：把 cfg.valueColumn 切到默认列
    if (draftConfig.value.valueColumn !== defaultValueColumn) {
      draftConfig.value.valueColumn = defaultValueColumn;
      await saveConfig();
    }
    const fresh = await api.get<ProjectInfo>(`/projects/${project.value.id}`);
    project.value = { ...project.value, dataset_hash: fresh.dataset_hash, updated_at: fresh.updated_at, hasData: fresh.hasData };
  }

  /** 用户在编辑界面切换"横坐标值列" → 立即重载 series 即可（其它无需变） */
  async function switchValueColumn(col: string) {
    if (!project.value) return;
    draftConfig.value.valueColumn = col;
    activeValueColumn.value = col;
    await loadSeries();
  }

  async function saveConfig() {
    if (!project.value) return;
    saving.value = true;
    try {
      project.value = await api.patch<ProjectInfo>(`/projects/${project.value.id}`, {
        title: project.value.title,
        config: draftConfig.value,
      });
      dirty.value = false;
    } finally {
      saving.value = false;
    }
  }

  async function clearData() {
    if (!project.value) return;
    await api.del(`/projects/${project.value.id}/datasets`);
    await loadSeries();
    const fresh = await api.get<ProjectInfo>(`/projects/${project.value.id}`);
    project.value = { ...project.value, dataset_hash: fresh.dataset_hash, updated_at: fresh.updated_at, hasData: fresh.hasData };
    if (draftConfig.value.valueColumn !== 'value') {
      draftConfig.value.valueColumn = 'value';
    }
  }

  /**
   * 关闭当前项目（回到项目列表前调用）。
   * dirty=true 时由 UI 层负责弹确认；这里只清 store，不动后端。
   */
  function closeProject() {
    project.value = null;
    series.value = [];
    summary.value = null;
    records.value = [];
    valueColumns.value = ['value'];
    activeValueColumn.value = 'value';
    applyConfig({ ...DEFAULT_RENDER_CONFIG });
    dirty.value = false;
    loadError.value = '';
  }

  return {
    project, series, summary, records, loading, saving, loadError,
    valueColumns, activeValueColumn,
    draftConfig, dirty, dataset, palette, colorOf,
    loadProject, loadSeries, loadRecords, importRows, importMultiValue, switchValueColumn,
    saveConfig, clearData, closeProject,
  };
});

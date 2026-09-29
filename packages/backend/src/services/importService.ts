/**
 * 数据导入服务：长表校验入库、time_order 赋值、summary 统计
 * 对应技术方案 §4.4 设计要点 / §5.1 数据流
 *
 * 支持两种导入形态：
 *  1) 单值：rows = [{time_key, entity, value}]
 *  2) 多值：rows = [{time_key, entity, values: {原始: x, 插值: y, 填补: z}}]
 *  多值时 value 字段存「当前选中列的值」，values_json 存完整列映射。
 */
import db, { contentHash } from '../db';
import Papa from 'papaparse';
import type { DatasetSummary, TimeSeriesRow } from '@barstudio/shared';
import { pickColumn, TIME_COLUMN_ALIASES, ENTITY_COLUMN_ALIASES, VALUE_COLUMN_ALIASES } from '@barstudio/shared';

export interface ImportResult {
  imported: number;
  skipped: number;
  timeCount: number;
  entityCount: number;
  dataset_hash: string;
  valueColumns: string[];
  defaultValueColumn: string;
}

/** 宽松入参：value 字段可能缺失（zod 默认 schema 不强制字段存在），由后端过滤 */
export type ImportRowInput = { time_key: unknown; entity: unknown; value?: unknown };

/** 多值入参：以 values 对象 + columns 清单承载 */
export interface ImportMultiValueInput {
  rows: { time_key: unknown; entity: unknown; values?: Record<string, unknown> }[];
  valueColumns: string[];
  defaultValueColumn?: string;
}

function assignTimeOrder(rows: TimeSeriesRow[]): Map<string, number> {
  const distinct = Array.from(new Set(rows.map(r => r.time_key)));
  const allNumeric = distinct.every(k => k.trim() !== '' && Number.isFinite(Number(k)));
  const ordered = allNumeric
    ? [...distinct].sort((a, b) => Number(a) - Number(b))
    : distinct;
  const map = new Map<string, number>();
  ordered.forEach((k, i) => map.set(k, i));
  return map;
}

function stripBOM(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}
function normalizeKey(v: unknown): string {
  return stripBOM(String(v ?? '')).trim();
}
function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  // 字符串要单独走一遍：Number('  ') === 0，只判 v === '' 会让"只含空白的单元格"
  // 被静默当成 0 导入（柱长失真，且与 parseLongCsv / 前端 toLongRows 的缺失语义不一致）。
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s === '-' || s === '—') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return Number.isFinite(v as number) ? (v as number) : null;
}

export function importSeries(projectId: number, rows: ImportRowInput[]): ImportResult {
  return importSeriesRaw(projectId, rows);
}

/** 单值导入 */
export function importSeriesRaw(projectId: number, rows: ImportRowInput[]): ImportResult {
  const valid: TimeSeriesRow[] = rows.filter(r => {
    const tk = normalizeKey(r.time_key);
    const en = normalizeKey(r.entity);
    if (!tk || !en) return false;
    return toNumOrNull(r.value) !== null;
  }).map(r => ({
    time_key: normalizeKey(r.time_key),
    entity: normalizeKey(r.entity),
    value: toNumOrNull(r.value) as number,
  }));
  const skipped = rows.length - valid.length;
  // 全部行无效时拒绝落库：否则下面的"DELETE 全量 + 插入 0 行"事务会把旧数据集清空（数据丢失）
  if (valid.length === 0) {
    return {
      imported: 0, skipped, timeCount: 0, entityCount: 0,
      dataset_hash: '', valueColumns: ['value'], defaultValueColumn: 'value',
    };
  }
  const orderMap = assignTimeOrder(valid);
  const hash = contentHash(JSON.stringify(valid.map(r => [r.time_key, r.entity, r.value])));

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM time_series WHERE project_id = ?').run(projectId);
    const stmt = db.prepare(
      `INSERT INTO time_series (project_id, time_key, time_order, entity, value, values_json) VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT (project_id, time_order, entity) DO UPDATE SET value = excluded.value, values_json = NULL`
    );
    for (const r of valid) {
      stmt.run(projectId, r.time_key, orderMap.get(r.time_key)!, r.entity, r.value);
    }
    upsertEntities(projectId, valid.map(r => r.entity));
    writeDatasetMeta(projectId, ['value'], 'value');
    db.prepare('UPDATE projects SET dataset_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, projectId);
  });
  tx();

  return {
    imported: valid.length, skipped,
    timeCount: orderMap.size,
    entityCount: new Set(valid.map(r => r.entity)).size,
    dataset_hash: hash,
    valueColumns: ['value'],
    defaultValueColumn: 'value',
  };
}

/** 多值导入 */
export function importSeriesMulti(projectId: number, payload: ImportMultiValueInput): ImportResult {
  const cols = payload.valueColumns.map(c => normalizeKey(c)).filter(Boolean);
  if (cols.length === 0) {
    return { imported: 0, skipped: payload.rows.length, timeCount: 0, entityCount: 0, dataset_hash: '', valueColumns: [], defaultValueColumn: '' };
  }
  const defaultCol = normalizeKey(payload.defaultValueColumn ?? cols[0]);
  const activeCol = cols.includes(defaultCol) ? defaultCol : cols[0];

  const valid: { time_key: string; entity: string; values: Record<string, number | null> }[] = [];
  let skipped = 0;
  for (const r of payload.rows) {
    const tk = normalizeKey(r.time_key);
    const en = normalizeKey(r.entity);
    if (!tk || !en) { skipped++; continue; }
    const src = r.values ?? {};
    const cleanedValues: Record<string, number | null> = {};
    let anyValid = false;
    for (const col of cols) {
      const n = toNumOrNull(src[col]);
      cleanedValues[col] = n;
      if (n !== null) anyValid = true;
    }
    if (!anyValid) { skipped++; continue; }
    valid.push({ time_key: tk, entity: en, values: cleanedValues });
  }

  // 全部行无效时拒绝落库：否则事务先删光旧数据、路由层才返回 400，造成"报错但数据已丢"
  if (valid.length === 0) {
    return {
      imported: 0, skipped, timeCount: 0, entityCount: 0,
      dataset_hash: '', valueColumns: cols, defaultValueColumn: activeCol,
    };
  }

  const synthetic: TimeSeriesRow[] = valid.map(r => ({
    time_key: r.time_key, entity: r.entity, value: r.values[activeCol] ?? 0,
  }));
  const orderMap = assignTimeOrder(synthetic);

  const hash = contentHash(JSON.stringify({
    cols,
    rows: valid.map(r => [r.time_key, r.entity, ...cols.map(c => r.values[c])]),
  }));

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM time_series WHERE project_id = ?').run(projectId);
    const stmt = db.prepare(
      `INSERT INTO time_series (project_id, time_key, time_order, entity, value, values_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, time_order, entity) DO UPDATE SET
         value = excluded.value,
         values_json = excluded.values_json`
    );
    for (const r of valid) {
      const primaryVal = r.values[activeCol] ?? 0;
      stmt.run(
        projectId, r.time_key, orderMap.get(r.time_key)!, r.entity, primaryVal,
        JSON.stringify(r.values)
      );
    }
    upsertEntities(projectId, valid.map(r => r.entity));
    writeDatasetMeta(projectId, cols, activeCol);
    db.prepare('UPDATE projects SET dataset_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, projectId);
  });
  tx();

  return {
    imported: valid.length, skipped,
    timeCount: orderMap.size,
    entityCount: new Set(valid.map(r => r.entity)).size,
    dataset_hash: hash,
    valueColumns: cols,
    defaultValueColumn: activeCol,
  };
}

function upsertEntities(projectId: number, entities: string[]) {
  const entStmt = db.prepare(
    `INSERT INTO entities (project_id, entity) VALUES (?, ?)
     ON CONFLICT (project_id, entity) DO NOTHING`
  );
  for (const e of entities) entStmt.run(projectId, e);
  db.prepare('DELETE FROM entities WHERE project_id = ? AND entity NOT IN (SELECT DISTINCT entity FROM time_series WHERE project_id = ?)').run(projectId, projectId);
}

function writeDatasetMeta(projectId: number, valueColumns: string[], defaultValueColumn: string) {
  db.prepare(
    `INSERT INTO datasets_meta (project_id, value_columns, default_value_column) VALUES (?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET value_columns = excluded.value_columns, default_value_column = excluded.default_value_column`
  ).run(projectId, JSON.stringify(valueColumns), defaultValueColumn);
}

export function getDatasetMeta(projectId: number): { valueColumns: string[]; defaultValueColumn: string } {
  const row = db.prepare('SELECT value_columns, default_value_column FROM datasets_meta WHERE project_id = ?').get(projectId) as { value_columns: string; default_value_column: string } | undefined;
  if (!row) return { valueColumns: ['value'], defaultValueColumn: 'value' };
  let cols: string[];
  try {
    const arr = JSON.parse(row.value_columns);
    cols = Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0) : ['value'];
  } catch {
    cols = ['value'];
  }
  if (cols.length === 0) cols = ['value'];
  return { valueColumns: cols, defaultValueColumn: row.default_value_column || cols[0] };
}

/** 取回时序数据；多值模式下同时返回 values 与 valueColumns */
export function getSeries(projectId: number, valueColumn?: string): {
  series: { time_key: string; time_order: number; entity: string; value: number; values?: Record<string, number | null> }[];
  valueColumns: string[];
  effectiveValueColumn: string;
} {
  const meta = getDatasetMeta(projectId);
  const cols = meta.valueColumns;
  const isMulti = cols.length > 1 || cols[0] !== 'value';
  const activeCol = valueColumn && cols.includes(valueColumn) ? valueColumn : meta.defaultValueColumn;

  if (!isMulti) {
    const rows = db.prepare(
      `SELECT time_key, time_order, entity, value
       FROM time_series WHERE project_id = ?
       ORDER BY time_order ASC, value DESC, entity ASC`
    ).all(projectId) as { time_key: string; time_order: number; entity: string; value: number }[];
    return { series: rows, valueColumns: cols, effectiveValueColumn: activeCol };
  }

  const rows = db.prepare(
    `SELECT time_key, time_order, entity, value, values_json
     FROM time_series WHERE project_id = ?
     ORDER BY time_order ASC, value DESC, entity ASC`
  ).all(projectId) as { time_key: string; time_order: number; entity: string; value: number; values_json: string | null }[];

  const series = rows.map(r => {
    let parsedValues: Record<string, number | null> = {};
    try {
      const obj = r.values_json ? JSON.parse(r.values_json) : {};
      parsedValues = (obj && typeof obj === 'object') ? obj : {};
    } catch { /* ignore */ }
    // 根据请求的 valueColumn 选取实际 value（缺/null 归 0）；r.value 仅作单值兼容 fallback
    let chosen: number;
    if (Object.prototype.hasOwnProperty.call(parsedValues, activeCol)) {
      const raw = parsedValues[activeCol];
      chosen = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    } else {
      chosen = r.value;
    }
    return {
      time_key: r.time_key,
      time_order: r.time_order,
      entity: r.entity,
      value: chosen,
      values: parsedValues,
    };
  });
  return { series, valueColumns: cols, effectiveValueColumn: activeCol };
}

export function getSummary(projectId: number): DatasetSummary {
  const r = db.prepare(
    `SELECT
       COUNT(*)                     AS rowCount,
       COUNT(DISTINCT time_order)   AS timeCount,
       COUNT(DISTINCT entity)       AS entityCount
     FROM time_series WHERE project_id = ?`
  ).get(projectId) as {
    rowCount: number; timeCount: number; entityCount: number;
  };
  // 时间范围不能再用 MIN/MAX(time_key)：time_key 是 TEXT，走的是**字典序** ——
  // 月份 1..12 会得到 max="9"，2024-1..2024-12 会得到 max="2024-2"，
  // 前端摘要就会显示成「2024-1 ~ 2024-2」这种明显错误的范围。
  // 必须按 time_order（入库时算好的时间顺序）取首尾。
  const first = db.prepare(
    'SELECT time_key FROM time_series WHERE project_id = ? ORDER BY time_order ASC LIMIT 1'
  ).get(projectId) as { time_key: string } | undefined;
  const last = db.prepare(
    'SELECT time_key FROM time_series WHERE project_id = ? ORDER BY time_order DESC LIMIT 1'
  ).get(projectId) as { time_key: string } | undefined;
  const meta = getDatasetMeta(projectId);
  const cols = meta.valueColumns;
  // 与 GET /datasets 的三级解析对齐：project.config.valueColumn 有效时优先于 meta 默认列，
  // 否则用户切换值列后 summary 仍报旧列，前端列指示显示错误
  let activeValueColumn = meta.defaultValueColumn;
  try {
    const cfgRow = db.prepare('SELECT config FROM projects WHERE id = ?').get(projectId) as { config: string } | undefined;
    const cfgVc = cfgRow ? (JSON.parse(cfgRow.config)?.valueColumn as unknown) : undefined;
    if (typeof cfgVc === 'string' && cols.includes(cfgVc)) activeValueColumn = cfgVc;
  } catch { /* config 损坏时保持默认列 */ }
  let missingValues = 0;
  if (cols.length > 1 || cols[0] !== 'value') {
    const rs = db.prepare('SELECT values_json FROM time_series WHERE project_id = ?').all(projectId) as { values_json: string | null }[];
    for (const row of rs) {
      try {
        const v = row.values_json ? JSON.parse(row.values_json) : {};
        for (const col of cols) if (v[col] === null || v[col] === undefined) missingValues++;
      } catch { /* ignore */ }
    }
  }
  return {
    rowCount: r.rowCount ?? 0,
    timeCount: r.timeCount ?? 0,
    entityCount: r.entityCount ?? 0,
    timeMin: first?.time_key ?? null,
    timeMax: last?.time_key ?? null,
    missingValues,
    valueColumns: cols,
    activeValueColumn,
  };
}

export function hasData(projectId: number): boolean {
  const r = db.prepare('SELECT COUNT(*) AS c FROM time_series WHERE project_id = ?').get(projectId) as { c: number };
  return r.c > 0;
}

/** 后端侧 CSV 长表解析 */
export function parseLongCsv(text: string): { rows: TimeSeriesRow[]; errors: string[] } {
  // BOM 探测：Excel/记事本另存的 UTF-8 CSV 会带 \uFEFF 首字符。
  // 不剥会污染第一个列头（"时间" → "\uFEFF时间"），让列识别全部失配。
  const cleaned = stripBOM(text).trim();
  const result = Papa.parse<Record<string, string>>(cleaned, {
    header: true,
    skipEmptyLines: true,
  });
  const errors: string[] = [];
  if (result.errors.length > 0) {
    errors.push(...result.errors.slice(0, 5).map(e => `第 ${e.row ?? '?'} 行解析异常: ${e.message}`));
  }
  const fields = result.meta.fields ?? [];
  // 列识别走 shared/columns.ts —— 与前端 guessMapping 用同一套别名与优先级。
  // 原来这里自维护了一份更短的别名表（没有 地区/省份/城市…），结果同一份 CSV
  // 前端能导入、走后端路径却报「无法识别列」。
  const timeCol = pickColumn(fields, TIME_COLUMN_ALIASES);
  const entityCol = pickColumn(fields, ENTITY_COLUMN_ALIASES);
  const valueCol = pickColumn(fields, VALUE_COLUMN_ALIASES);
  if (!timeCol || !entityCol || !valueCol) {
    return { rows: [], errors: [`无法识别列：需要 time/entity/value 语义的列，实际表头为 [${fields.join(', ')}]。请改用前端导入做列映射。`] };
  }
  const rows: TimeSeriesRow[] = [];
  // 明细错误最多记 DETAIL_LIMIT 条，其余只汇总计数 ——
  // 原来对每个坏行都 push 一条字符串，万行级别的坏数据会堆出一万个字符串（最后又只留 20 条）。
  const DETAIL_LIMIT = 20;
  let emptyKeyRows = 0;
  let unparsable = 0;
  for (const rec of result.data) {
    const t = (rec[timeCol] ?? '').trim();
    const e = (rec[entityCol] ?? '').trim();
    const rawV = String(rec[valueCol] ?? '').trim();
    if (!t || !e) { emptyKeyRows++; continue; }
    // 空单元格 = 缺失数据，按缺失跳过（与 toNumOrNull 语义一致）。
    // 不能用 Number(raw)：Number('') === 0 会把缺测静默导入成 0，柱长失真。
    const cleanedV = rawV.replace(/[,，\s%¥$]/g, '');
    const v = cleanedV === '' || cleanedV === '-' || cleanedV === '—' ? null : Number(cleanedV);
    if (v === null || !Number.isFinite(v)) {
      if (rawV !== '') {
        unparsable++;
        if (errors.length < DETAIL_LIMIT) {
          errors.push(`实体「${e}」在「${t}」的数值「${rawV}」无法解析，已跳过`);
        }
      }
      continue;
    }
    rows.push({ time_key: t, entity: e, value: v });
  }
  if (emptyKeyRows > 0) errors.push(`另有 ${emptyKeyRows} 行因 time/entity 为空被跳过`);
  if (unparsable > DETAIL_LIMIT) errors.push(`共 ${unparsable} 行数值无法解析（仅列出前 ${DETAIL_LIMIT} 条明细），已跳过`);
  return { rows, errors: errors.slice(0, DETAIL_LIMIT + 5) };
}

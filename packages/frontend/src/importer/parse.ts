/**
 * 前端导入解析器：CSV / XLSX / 粘贴表格 → 规范表；宽表 → 长表（方案 §1.2 / §5.1）
 * 编码策略（方案 §9）：BOM 探测 → UTF-8 严格 → GBK → 兜底替换
 */
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { decodeBytes, type TimeSeriesRow } from '@barstudio/shared';

export interface ParsedTable {
  fields: string[];
  rows: string[][];
  source: 'csv' | 'xlsx' | 'text';
}

export interface ColumnMapping {
  time: string;
  entity: string;
  value: string;
  /** 多值列候选（用户可在导入时/编辑时从这些列里挑横坐标） */
  valueCandidates?: string[];
}

export type TableMode = 'long' | 'wide-by-row' | 'wide-by-col';
// long:        每行 = (time, entity, value)
// wide-by-row: 第一列 = 时间，其余各列 = 实体（政府 CSV 常见）
// wide-by-col: 第一列 = 实体，其余各列 = 时间

/** xlsx 解析结果：可能含多 sheet，给前端让用户选择 */
export interface ParsedXlsxResult {
  sheetNames: string[];
  /** 当前预览的 sheet（默认第 1 个数据 sheet） */
  sheetName: string;
  fields: string[];
  rows: string[][];
}

/** 文本解码：BOM 探测（UTF-16 优先）→ UTF-8 严格 → GBK → 兜底替换（方案 §9） */
export async function decodeFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  return stripBOM(decodeBytes(new Uint8Array(buf)));
}

/** 去掉开头 BOM 字符（UTF-8 \uFEFF / UTF-16 LE / BE 等） */
export function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * 把 sheet 内二维数组 → ParsedTable（供通用路径使用）
 *
 * 表头会做唯一化：政府/企业 Excel 里合并单元格、重复年份做表头很常见
 * （如两列都叫「2020」）。列名重复时后续全部按 `fields.indexOf(name)` 定位，
 * 只会命中第一列 —— 表现为"选了第二列却拿到第一列的数据"。这里给重复项加序号。
 */
function aoaToTable(aoa: unknown[][]): ParsedTable {
  const trimmed = aoa.map(r => r.map(c => String(c ?? '').trim()));
  const raw = trimmed.shift() ?? [];
  const seen = new Map<string, number>();
  const fields = raw.map((f, i) => {
    let name = f ? f : `列${i + 1}`;
    const n = seen.get(name);
    if (n === undefined) {
      seen.set(name, 1);
    } else {
      seen.set(name, n + 1);
      name = `${name}(${n + 1})`;
    }
    return name;
  });
  return { fields, rows: trimmed, source: 'xlsx' };
}

/**
 * workbook 缓存：readXlsxSheets() + readXlsxSheet() 原本各自 XLSX.read 整个文件，
 * 用户在预览里切一次 sheet 就要把整个工作簿重新解析一遍（几 MB 的表要等上一会儿）。
 * 以 File 对象为 key 缓存（WeakMap，不阻止回收）。
 */
const workbookCache = new WeakMap<File, XLSX.WorkBook>();

async function loadWorkbook(file: File): Promise<XLSX.WorkBook> {
  const hit = workbookCache.get(file);
  if (hit) return hit;
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  workbookCache.set(file, wb);
  return wb;
}

/** 读取 xlsx：返回所有 sheet 名称 + 默认第 1 个 sheet 的数据 */
export async function readXlsxSheets(file: File): Promise<ParsedXlsxResult> {
  const wb = await loadWorkbook(file);
  if (wb.SheetNames.length === 0) {
    return { sheetNames: [], sheetName: '', fields: [], rows: [] };
  }
  // 选第一个"像数据表"的 sheet：要求至少 2 行；首 sheet 通常就是
  let pick = wb.SheetNames[0];
  for (const sn of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false, defval: '' });
    if (aoa.length >= 2) { pick = sn; break; }
  }
  const sheet = wb.Sheets[pick];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '' });
  const table = aoaToTable(aoa);
  return { sheetNames: wb.SheetNames, sheetName: pick, fields: table.fields, rows: table.rows };
}

/** 给定 xlsx 文件 + sheet 名，返回该 sheet 的 ParsedTable（用于"切换 sheet 预览"） */
export async function readXlsxSheet(file: File, sheetName: string): Promise<ParsedTable> {
  const wb = await loadWorkbook(file);
  if (!wb.Sheets[sheetName]) throw new Error(`Sheet 不存在: ${sheetName}`);
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, blankrows: false, defval: '' });
  return aoaToTable(aoa);
}

export function parseDelimitedText(text: string): ParsedTable {
  const t0 = stripBOM(text).trim();

  // 全角分隔符归一化（Excel 中文版默认导出 ',' ';' '"' 等全角字符）
  // 仅当第一行主要是全角标点时才替换，避免破坏字符串内的 ASCII 标点
  const firstLineRaw = t0.split(/\r?\n/)[0] ?? '';
  const cnComma = (firstLineRaw.match(/，/g) ?? []).length;
  const enComma = (firstLineRaw.match(/,/g) ?? []).length;
  const useFullWidthComma = cnComma >= Math.max(1, enComma);
  const t = useFullWidthComma ? t0.replace(/，/g, ',').replace(/；/g, ';') : t0;

  const firstLine = t.split(/\r?\n/)[0] ?? '';
  const isTsv = firstLine.includes('\t') && !firstLine.includes(',') && !firstLine.includes(';');
  const result = Papa.parse<string[]>(t, {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter: isTsv ? '\t' : '',
  });
  const rows = (result.data as string[][]).map(r => r.map(c => (c ?? '').trim()));
  const fields = rows.shift() ?? [];
  return { fields, rows, source: 'text' };
}

export function parseCsvFile(text: string): ParsedTable {
  const result = Papa.parse<string[]>(stripBOM(text).trim(), {
    header: false,
    skipEmptyLines: 'greedy',
  });
  const rows = (result.data as string[][]).map(r => r.map(c => (c ?? '').trim()));
  // 字段名也去 BOM（防止 header 第一个字段被污染导致列映射失效）
  const fields = (rows.shift() ?? []).map(f => stripBOM(f));
  return { fields, rows, source: 'csv' };
}

export async function parseXlsxFile(file: File): Promise<ParsedTable> {
  // 兼容旧接口：等同 readXlsxSheets().table
  const r = await readXlsxSheets(file);
  return { fields: r.fields, rows: r.rows, source: 'xlsx' };
}

export async function parseFile(file: File): Promise<ParsedTable> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return parseXlsxFile(file);
  const text = await decodeFile(file);
  if (name.endsWith('.json')) {
    try {
      const arr = JSON.parse(text);
      const rows = Array.isArray(arr) ? arr : [];
      const fields = rows.length ? Object.keys(rows[0]) : [];
      return { fields, rows: rows.map((r: any) => fields.map(f => String(r[f] ?? ''))), source: 'csv' };
    } catch {
      throw new Error('JSON 解析失败：请提供长表数组');
    }
  }
  return parseCsvFile(text);
}

/** 自动猜列头（方案 §3.2）：列名语义 → 兜底启发式 */
export function guessMapping(table: ParsedTable): ColumnMapping | null {
  const { fields, rows } = table;
  if (fields.length < 3) return null;
  const find = (aliases: string[]) =>
    fields.find(f => aliases.some(a => f.toLowerCase().includes(a.toLowerCase())));

  let time = find(['time', '时间', '年份', 'year', '日期', 'date', 'quarter', '季度']);
  let entity = find([
    'entity', '实体', '名称', '国家', '公司', 'name', '厂商', '品牌', '地区', '城市',
    // 政府统计常见：省份/地市/区县/机构
    '省份', 'province', '地市', '区县', '机构', '单位', '行业', '区域',
  ]);
  let value = find([
    'value', '数值', '值', '数量', 'count', '产量', '销量', '出货量',
    // 经济统计常见指标词
    '支出', '收入', '消费', 'gdp', '人均', '总额', '金额', '利润', '税收', '工资',
    '人口', '面积', '增长', '增速', '指数', '价格', '房价', '零售额', '营业额',
  ]);

  if (!time || !entity || !value) {
    // 兜底：找数值比例最高的列作 value，第一列作 time、第二列作 entity
    // ★ 关键防御：排除"标识/编码"类列——它们 100% 是数字但语义上不是统计值
    // （如「省份代码」110000：数值比例满格，但每行恒定，作为 value 会导致条形图一动不动）
    // 值列还应是"有变化"的：同一列在不同行间有多个不同取值才像统计数据
    const hasVariance = (ci: number) => {
      const distinct = new Set(rows.map(r => r[ci]));
      return distinct.size > 1;
    };
    const ratios = fields.map((f, i) =>
      (i < 2 || isIdentifierColumn(f) || !hasVariance(i)) ? -1 : numericRatioOfColumn(rows, i)
    );
    const valueIdx = ratios.indexOf(Math.max(...ratios));
    if (valueIdx < 2) return null;
    time = fields[0];
    entity = fields[1];
    value = fields[valueIdx];
  }

  // 候选"值列"：除时间/实体/标识列外，其它可解析为数值的列都是候选。
  // 注意按**下标**遍历比较（不能用 fields.indexOf(f)：列名重复时它总是返回第一个下标）
  const ti = fields.indexOf(time);
  const ei = fields.indexOf(entity);
  const numericCols = fields.filter((f, i) =>
    i !== ti && i !== ei && !isIdentifierColumn(f) &&
    numericRatioOfColumn(rows, i) > 0.4
  );
  return { time: time!, entity: entity!, value: value!, valueCandidates: numericCols.length ? numericCols : undefined };
}

/**
 * 某一列的"数值比例"：非空单元格中能被解析为数字的占比。
 * 统一清洗口径（千分位/空格/百分号/货币符），供 guessMapping 与导入页候选列共用，
 * 避免两处各写一份导致同一列在不同入口得到不同判定。
 */
export function numericRatioOfColumn(rows: string[][], ci: number): number {
  if (!rows.length) return 0;
  const nonEmpty = rows.filter(r => (r[ci] ?? '') !== '');
  if (!nonEmpty.length) return 0;
  const numeric = nonEmpty.filter(r => Number.isFinite(Number((r[ci] ?? '').replace(/[,，\s%¥$]/g, ''))));
  return numeric.length / nonEmpty.length;
}

/** 标识/编码类列名（省份代码、序号、编号…）：数值比例再高也不是统计值 */
export function isIdentifierColumn(field: string): boolean {
  return /代码|code|id|编号|序号|邮编|区划/i.test(field);
}

export interface ToLongResult {
  rows: TimeSeriesRow[];
  errors: string[];
  warnings: string[];
}

/** 规范表 → 长表（按模式转换 + 数值清洗报告） */
export function toLongRows(
  table: ParsedTable,
  mode: TableMode,
  mapping?: ColumnMapping
): ToLongResult {
  const { fields, rows } = table;
  const errors: string[] = [];
  const warnings: string[] = [];
  const out: TimeSeriesRow[] = [];

  const toNumber = (raw: string): number | null => {
    const cleaned = raw.replace(/[,，\s%¥$]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '—') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  if (mode === 'long') {
    if (!mapping) return { rows: [], errors: ['缺少列映射'], warnings };
    const ti = fields.indexOf(mapping.time);
    const ei = fields.indexOf(mapping.entity);
    const vi = fields.indexOf(mapping.value);
    if (ti < 0 || ei < 0 || vi < 0) return { rows: [], errors: ['列映射无效：所选列不在表中'], warnings };
    for (const r of rows) {
      const t = (r[ti] ?? '').trim();
      const e = (r[ei] ?? '').trim();
      const v = toNumber(r[vi] ?? '');
      if (!t || !e) { warnings.push(`空时间/实体行已跳过: [${r.join(', ')}]`); continue; }
      if (v === null) { warnings.push(`「${e}」在「${t}」的数值「${r[vi]}」无法解析，已跳过`); continue; }
      out.push({ time_key: t, entity: e, value: v });
    }
  } else if (mode === 'wide-by-row') {
    for (const r of rows) {
      const t = (r[0] ?? '').trim();
      if (!t) { warnings.push('存在空时间行，已跳过'); continue; }
      for (let j = 1; j < fields.length; j++) {
        const e = fields[j];
        const v = toNumber(r[j] ?? '');
        if (v === null) {
          if ((r[j] ?? '') !== '') warnings.push(`「${t}」时「${e}」的数值无法解析，已按缺失处理`);
          continue;
        }
        out.push({ time_key: t, entity: e, value: v });
      }
    }
  } else {
    // wide-by-col
    for (const r of rows) {
      const e = (r[0] ?? '').trim();
      if (!e) { warnings.push('存在空实体行，已跳过'); continue; }
      for (let j = 1; j < fields.length; j++) {
        const t = fields[j];
        const v = toNumber(r[j] ?? '');
        if (v === null) {
          if ((r[j] ?? '') !== '') warnings.push(`「${e}」在「${t}」的数值无法解析，已按缺失处理`);
          continue;
        }
        out.push({ time_key: t, entity: e, value: v });
      }
    }
  }

  if (out.length === 0) errors.push('没有解析出有效数据行，请检查列映射或表格模式');
  const uniqWarnings = [...new Set(warnings)];
  return { rows: out, errors, warnings: uniqWarnings.slice(0, 20) };
}

/**
 * 多值长表转换：当用户在宽表中携带多个"值"列（如「人均 GDP」「人均消费支出」并存于同一行）
 * 或长表中一行的多个数值列都需要保留时使用。
 *
 * 输入：
 *   - long 模式 + 多个值列 → 每个 (time, entity) 行展开成多个记录，分别有 values 字典
 *   - long 模式 + 单值列  → 等同 toLongRows，但保留 multi 形态
 *   - wide-by-row 模式    → 每行 = (time, e1, e2, ...)。若多个数值列被指定，转 multi
 */
export function toMultiValueRows(
  table: ParsedTable,
  mode: TableMode,
  mapping?: ColumnMapping,
): {
  rows: { time_key: string; entity: string; values: Record<string, number | null> }[];
  valueColumns: string[];
  errors: string[];
  warnings: string[];
} {
  const { fields, rows } = table;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!mapping) {
    return { rows: [], valueColumns: [], errors: ['缺少列映射'], warnings };
  }

  const toNumber = (raw: string): number | null => {
    const cleaned = raw.replace(/[,，\s%¥$]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '—') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  const out: { time_key: string; entity: string; values: Record<string, number | null> }[] = [];

  if (mode === 'long') {
    const ti = fields.indexOf(mapping.time);
    const ei = fields.indexOf(mapping.entity);
    const candidates = mapping.valueCandidates?.length
      ? mapping.valueCandidates
      : [mapping.value];
    const vis = candidates
      .map(c => ({ col: c, idx: fields.indexOf(c) }))
      .filter(o => o.idx >= 0);
    if (ti < 0 || ei < 0 || vis.length === 0) {
      return { rows: [], valueColumns: [], errors: ['列映射无效'], warnings };
    }
    for (const r of rows) {
      const t = (r[ti] ?? '').trim();
      const e = (r[ei] ?? '').trim();
      if (!t || !e) { warnings.push(`空时间/实体行已跳过`); continue; }
      const values: Record<string, number | null> = {};
      for (const v of vis) values[v.col] = toNumber(r[v.idx] ?? '');
      out.push({ time_key: t, entity: e, values });
    }
  } else if (mode === 'wide-by-row') {
    // 行=时间；列=实体。但若用户从 valueCandidates 里挑了多个列当 multi-value，则每个候选列都成为该行的实体 ?? 这种语义不顺：
    // wide-by-row 的 natural meaning 是 "每列一个实体"。多值时只取主值列（mapping.value 这条），其它候选列忽略。
    const ti = 0;
    for (const r of rows) {
      const t = (r[ti] ?? '').trim();
      if (!t) { warnings.push('存在空时间行，已跳过'); continue; }
      for (let j = 1; j < fields.length; j++) {
        const e = fields[j];
        const v = toNumber(r[j] ?? '');
        if (v === null) continue;
        out.push({ time_key: t, entity: e, values: { [mapping.value]: v } });
      }
    }
  } else {
    // wide-by-col
    for (const r of rows) {
      const e = (r[0] ?? '').trim();
      if (!e) continue;
      for (let j = 1; j < fields.length; j++) {
        const t = fields[j];
        const v = toNumber(r[j] ?? '');
        if (v === null) continue;
        out.push({ time_key: t, entity: e, values: { [mapping.value]: v } });
      }
    }
  }

  const cols = mapping.valueCandidates?.length ? mapping.valueCandidates : [mapping.value];
  if (out.length === 0) errors.push('没有解析出有效数据行');
  return { rows: out, valueColumns: cols, errors, warnings: [...new Set(warnings)].slice(0, 20) };
}

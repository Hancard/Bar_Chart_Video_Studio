#!/usr/bin/env node
/**
 * xlsx 表头处理回归
 *
 * 运行：node --import tsx scripts/parse_xlsx_test.mjs
 *
 * 背景：aoaToTable 直接把表头当列名，遇到重复表头（Excel 里合并单元格、同名年份列很常见）
 * 会产出两个同名字段。而下游一律用 fields.indexOf(name) 定位列 —— 只会命中第一列，
 * 表现为"选了第二列却拿到第一列的数据"。修复后重复项会加序号（2020 / 2020(2)）。
 *
 * 顺带验证 workbook 缓存没有破坏多 sheet 预览。
 */
import * as XLSX from 'xlsx';
import {
  readXlsxSheets,
  readXlsxSheet,
  guessMapping,
  parseCsvFile,
  parseDelimitedText,
  uniqueFields,
} from '../packages/frontend/src/importer/parse.ts';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

function makeXlsx(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new File([buf], 'test.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

// 1) 重复表头 → 唯一化
{
  const file = makeXlsx([['Sheet1', [
    ['地区', '2020', '2020', ''],
    ['A', 1, 2, 3],
    ['B', 4, 5, 6],
  ]]]);
  const r = await readXlsxSheets(file);
  const uniq = new Set(r.fields);
  assert(r.fields.length === 4 && uniq.size === 4,
    '重复表头被唯一化（2 个「2020」不再同名）', JSON.stringify(r.fields));
  assert(r.fields[1] === '2020' && r.fields[2] === '2020(2)',
    '重复项按出现顺序加序号（2020 / 2020(2)）', JSON.stringify(r.fields));
  assert(r.fields[3] === '列4', '空表头补为「列N」', JSON.stringify(r.fields));
}

// 2) 唯一化后，按列名取到的数据必须是真的那一列（而不是永远第一列）
{
  const file = makeXlsx([['Sheet1', [
    ['地区', '2020', '2020'],
    ['A', 11, 99],
  ]]]);
  const r = await readXlsxSheets(file);
  const i1 = r.fields.indexOf('2020');
  const i2 = r.fields.indexOf('2020(2)');
  assert(i1 !== i2 && r.rows[0][i1] === '11' && r.rows[0][i2] === '99',
    '两列各自可取到正确的数据（修复前 indexOf 会都指向第一列）',
    `i1=${i1}(${r.rows[0][i1]}) i2=${i2}(${r.rows[0][i2]})`);
}

// 3) 多 sheet：列 sheet 名 + 按名取数据（覆盖 workbook 缓存路径）
{
  const file = makeXlsx([
    ['汇总', [['地区', '值'], ['A', 1]]],
    ['明细', [['地区', '2021', '2022'], ['B', 7, 8], ['C', 9, 10]]],
  ]);
  const r = await readXlsxSheets(file);
  assert(r.sheetNames.length === 2 && r.sheetNames.join(',') === '汇总,明细',
    '返回全部 sheet 名', JSON.stringify(r.sheetNames));
  assert(r.sheetName === '汇总', '默认选中第一个数据 sheet', r.sheetName);

  const detail = await readXlsxSheet(file, '明细');
  assert(detail.fields.join(',') === '地区,2021,2022' && detail.rows.length === 2,
    '按名取第二个 sheet 的数据正确（缓存不影响正确性）',
    JSON.stringify(detail.fields) + ' rows=' + detail.rows.length);

  // 同一 file 再取一次第一个 sheet，仍应是它自己的数据
  const again = await readXlsxSheet(file, '汇总');
  assert(again.fields.join(',') === '地区,值' && again.rows[0][1] === '1',
    '重复读取不同 sheet 互不串数据', JSON.stringify(again.fields));
}

// 4) 只含单行的 sheet 不应被当作"数据 sheet"（封面页常见）
{
  const file = makeXlsx([
    ['封面', [['报告名称']]],
    ['数据', [['地区', '值'], ['A', 1], ['B', 2]]],
  ]);
  const r = await readXlsxSheets(file);
  assert(r.sheetName === '数据', '跳过只有 1 行的 sheet，选真正的数据表', r.sheetName);
}

// 5) 重复表头的表也能正常猜出列映射，且被复制的列仍作为候选
{
  const table = {
    fields: ['地区', '年份', '数值', '数值(2)'],
    rows: [['A', '2020', '11', '99'], ['B', '2021', '22', '88']],
    source: 'xlsx',
  };
  const m = guessMapping(table);
  assert(m && m.time === '年份' && m.entity === '地区' && m.value === '数值',
    '列映射正确识别 time/entity/value', JSON.stringify(m));
  assert(m && m.valueCandidates && m.valueCandidates.includes('数值') && m.valueCandidates.includes('数值(2)'),
    '同名的第二列也作为候选值列出现（以前会因同名被漏掉）', JSON.stringify(m?.valueCandidates));
}

// 6) CSV / 粘贴入口同样要唯一化 —— 这两条路径以前漏掉了（只有 xlsx 走了唯一化）
{
  const t = parseCsvFile('时间,2020,2020\nA,1,2\nB,3,4');
  assert(t.fields.join(',') === '时间,2020,2020(2)',
    'CSV 入口：重复表头被唯一化', JSON.stringify(t.fields));
  assert(t.fields.indexOf('2020') !== t.fields.indexOf('2020(2)'),
    'CSV 入口：两个同名列可取到不同下标（下游按 indexOf 定位列）',
    `i1=${t.fields.indexOf('2020')} i2=${t.fields.indexOf('2020(2)')}`);
  assert(t.rows[0][0] === 'A' && t.rows[0][1] === '1' && t.rows[0][2] === '2',
    'CSV 入口：行数据未被改动', JSON.stringify(t.rows[0]));
}
{
  const t = parseDelimitedText('地区\t2020\t2020\nA\t1\t2');
  assert(t.fields.join(',') === '地区,2020,2020(2)',
    '粘贴入口（TSV）：重复表头被唯一化', JSON.stringify(t.fields));
}
{
  const t = parseCsvFile('时间,实体,');
  assert(t.fields[2] === '列3', 'CSV 入口：空表头补为「列N」', JSON.stringify(t.fields));
}
{
  const t = parseCsvFile('时间,实体,数值\n2020,A,1');
  assert(t.fields.join(',') === '时间,实体,数值', '无重复时表头保持原样', JSON.stringify(t.fields));
}
{
  assert(uniqueFields(['a', 'a', 'a', 'b']).join(',') === 'a,a(2),a(3),b',
    '三连重名依次加序号', JSON.stringify(uniqueFields(['a', 'a', 'a', 'b'])));
}

console.log(`\nxlsx 表头回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
#!/usr/bin/env node
/**
 * 后端 CSV 长表解析回归（parseLongCsv）
 *
 * 运行：node --import tsx scripts/csv_parse_test.mjs
 *
 * 两处问题：
 *  1) pickCol 只用 includes 匹配别名且按 fields 顺序取"第一个命中项" ——
 *     表头里只要有一列「数量说明」这种带关键词的说明列，就会抢在真正的「数值」前面，
 *     解析出的全是无法转换的文本，整份 CSV 报错跳过。
 *  2) 跳过的行逐条 push 错误字符串，万行表会堆出一万个字符串（最后又只取 20 条）。
 */
import { parseLongCsv } from '../packages/backend/src/services/importService.ts';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

// 1) 别名冲突：说明列不应抢走真正的数值列
{
  const csv = '年份,地区,数量说明,数值\n2020,广东,含说明文字,100\n2021,江苏,另一个说明,200';
  const r = parseLongCsv(csv);
  assert(r.rows.length === 2 && r.rows.every(x => x.value > 0),
    '「数量说明」不抢「数值」列（精确匹配优先）',
    `rows=${JSON.stringify(r.rows)} err=${JSON.stringify(r.errors.slice(0, 2))}`);
  assert(r.rows[0]?.time_key === '2020' && r.rows[0]?.entity === '广东' && r.rows[0]?.value === 100,
    '列语义正确：年份→time、地区→entity、数值→value', JSON.stringify(r.rows[0]));
}
{
  // 说明列排在真正的数值列之前，且排在实体列位置之后
  const csv = '时间,城市,产值说明,产值\n2020,A,x,11\n2021,B,y,22';
  const r = parseLongCsv(csv);
  assert(r.rows.length === 2 && r.rows[0].value === 11,
    '带「说明」后缀的干扰列不会被选中', JSON.stringify(r.rows));
}
{
  // 数值列本身带后缀（无精确匹配项）时，仍应退化为包含匹配
  const csv = '时间,实体,产值变化\n2020,A,11\n2021,B,22';
  const r = parseLongCsv(csv);
  assert(r.rows.length === 2, '无精确匹配时退化为包含匹配（「产值变化」仍可用）',
    `rows=${JSON.stringify(r.rows)} err=${JSON.stringify(r.errors.slice(0, 1))}`);
}
{
  // 说明列排在后面时也不能被选中
  const csv = '年份,城市,数值,备注\n2020,北京,5,无\n2021,上海,6,无';
  const r = parseLongCsv(csv);
  assert(r.rows.length === 2 && r.rows[0].value === 5,
    '常规表头（年份/城市/数值/备注）解析正确', JSON.stringify(r.rows));
}

// 2) 错误汇总：大量坏行不应堆出一堆重复错误
{
  const lines = ['时间,实体,数值'];
  for (let i = 0; i < 500; i++) lines.push(`2020,实体${i},不是数字`);
  const r = parseLongCsv(lines.join('\n'));
  assert(r.rows.length === 0 && r.errors.length <= 25,
    '500 行坏值：错误条数受控（≤25，不是 500 条）', `errors=${r.errors.length}`);
  assert(r.errors.some(e => /500|无法解析/.test(e)),
    '错误里给出总数量级', JSON.stringify(r.errors.slice(0, 3)));
}
{
  const lines = ['时间,实体,数值'];
  for (let i = 0; i < 300; i++) lines.push(`,实体${i},1`);   // 空时间
  const r = parseLongCsv(lines.join('\n'));
  assert(r.rows.length === 0 && r.errors.length <= 25,
    '300 行空 time：错误条数受控', `errors=${r.errors.length}`);
  assert(r.errors.some(e => /300/.test(e)), '错误里带有跳过行数', JSON.stringify(r.errors.slice(0, 3)));
}

// 3) 正常场景不受影响
{
  const csv = '时间,实体,数值\n2024-1,北京,10\n2024-2,上海,20\n2024-3,广州,30';
  const r = parseLongCsv(csv);
  assert(r.rows.length === 3 && r.errors.length === 0,
    '常规 CSV 解析无错误', JSON.stringify(r.rows));
  assert(r.rows[0].time_key === '2024-1' && r.rows[2].value === 30,
    '字段解析正确', JSON.stringify(r.rows[0]));
}
{
  // 千分位要按 CSV 规范加引号，否则逗号会被当成分隔符（那是数据本身的问题，不是解析器的）
  const csv = '\uFEFF时间,实体,数值\n2024,北京,"1,000"';
  const r = parseLongCsv(csv);
  assert(r.rows.length === 1 && r.rows[0].value === 1000,
    'BOM 被剥离 + 带引号的千分位被清洗', JSON.stringify(r.rows));
}
{
  const csv = '时间,实体,数值\n2024,北京,\n2025,上海,20';
  const r = parseLongCsv(csv);
  assert(r.rows.length === 1 && r.rows[0].value === 20,
    '空单元格按缺失跳过（不静默当 0）', JSON.stringify(r.rows));
}

console.log(`\n后端 CSV 解析回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

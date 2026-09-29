/**
 * 列名识别（前后端共用）
 *
 * 背景：前端 `guessMapping` 与后端 `parseLongCsv` 各维护了一份别名表，
 * 结果两边能识别的表头不一样 —— 同一份 CSV 在前端能导入（有列映射 UI），
 * 走后端路径（sourceUrl 抓取 / multipart 上传）却报「无法识别列」。
 * 这里把别名表与匹配规则收敛到一处。
 */

/** 时间列别名 */
export const TIME_COLUMN_ALIASES = [
  'time', '时间', '年份', 'year', '日期', 'date', 'quarter', '季度',
];

/** 实体列别名（政府统计的省份/地市/区县很常见） */
export const ENTITY_COLUMN_ALIASES = [
  'entity', '实体', '名称', '国家', '公司', 'name', '厂商', '品牌',
  '地区', '城市', '省份', 'province', '地市', '区县', '机构', '单位', '行业', '区域',
];

/** 值列别名（含经济统计常见指标词） */
export const VALUE_COLUMN_ALIASES = [
  'value', '数值', '值', '数量', 'count', '产量', '销量', '出货量',
  '支出', '收入', '消费', 'gdp', '人均', '总额', '金额', '利润', '税收', '工资',
  '人口', '面积', '增长', '增速', '指数', '价格', '房价', '零售额', '营业额',
];

/**
 * 按别名从表头里挑列。
 *
 * 匹配顺序（关键）：
 *  1. **先做整名精确匹配**（忽略大小写与首尾空格）—— 否则「数量说明」这种说明列
 *     会因为在表里排得靠前而抢走真正的「数值」列（曾经导致整份 CSV 解析不出数据）。
 *  2. 再退化为包含匹配。多个候选时**取列名最短的那个**：
 *     表头同时有「产值」和「产值说明」、别名是「值」时，正主显然是短的那个。
 */
export function pickColumn(fields: string[], aliases: string[]): string | undefined {
  const norm = (s: string) => s.trim().toLowerCase();
  for (const a of aliases) {
    const target = norm(a);
    const exact = fields.find(f => norm(f) === target);
    if (exact) return exact;
  }
  for (const a of aliases) {
    const target = norm(a);
    const partials = fields.filter(f => norm(f).includes(target));
    if (partials.length > 0) {
      return partials.sort((x, y) => x.length - y.length)[0];
    }
  }
  return undefined;
}

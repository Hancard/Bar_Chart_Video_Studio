#!/usr/bin/env node
/**
 * 时间显示回归
 *
 * 运行：node --import tsx scripts/time_format_test.mjs
 *
 * 背景：数据库的 created_at / updated_at 由 SQLite 的 datetime('now') 生成，返回的是
 * **UTC**（本机实测 2026-10-03 00:14 vs 本地 08:14）。前端原来直接 slice(0,16) 展示，
 * 用户看到的时间比实际早 8 小时。formatLocalTime 统一按 UTC 解析、按本地时区显示。
 *
 * 断言写成「与同一时刻的本地格式化结果比对」，因此在任何时区都能通过。
 */
import { formatLocalTime } from '../packages/shared/src/time.ts';

const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', RST = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`${GRN}✓${RST} ${label}`); }
  else { fail++; console.log(`${RED}✗${RST} ${label}${detail ? ' → ' + YEL + detail + RST : ''}`); }
}

/** 同一时刻的本地格式化（作为期望值，时区无关） */
function expectedLocal(isoUtc, withSeconds = false) {
  const d = new Date(isoUtc);
  const pad = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

const SAMPLE = '2026-10-03 00:14:05';

// 1) SQLite 格式（无时区）按 UTC 解释
{
  const got = formatLocalTime(SAMPLE);
  const want = expectedLocal('2026-10-03T00:14:05Z');
  assert(got === want, 'SQLite datetime（UTC）→ 本地时间', `got=${got} want=${want}`);
  assert(got !== SAMPLE.slice(0, 16) || new Date().getTimezoneOffset() === 0,
    '不再等同于直接截断 UTC 串（UTC+8 下应相差 8 小时）',
    `截断=${SAMPLE.slice(0, 16)} 本地=${got}`);
}

// 2) 带秒
{
  const got = formatLocalTime(SAMPLE, true);
  const want = expectedLocal('2026-10-03T00:14:05Z', true);
  assert(got === want, 'withSeconds=true 时带秒', `got=${got} want=${want}`);
}

// 3) 已带时区标记的 ISO 串不应被二次加 Z
{
  const iso = '2026-10-03T00:14:05Z';
  const got = formatLocalTime(iso);
  assert(got === expectedLocal(iso), '已带 Z 的 ISO 串正确解析', `got=${got}`);
}
{
  const iso = '2026-10-03T08:14:05+08:00';
  const got = formatLocalTime(iso);
  assert(got === expectedLocal(iso), '带 +08:00 偏移的串正确解析', `got=${got}`);
}

// 4) 空值
{
  assert(formatLocalTime(null) === '—' && formatLocalTime(undefined) === '—' && formatLocalTime('') === '—',
    'null / undefined / 空串 → 占位符「—」',
    [formatLocalTime(null), formatLocalTime(undefined), formatLocalTime('')].join(','));
  assert(formatLocalTime('   ') === '—', '纯空白 → 占位符');
}

// 5) 无法解析的串不能显示 Invalid Date
{
  const got = formatLocalTime('not-a-date');
  assert(!/Invalid/i.test(got) && got.length > 0,
    '无法解析时原样截断，不显示 Invalid Date', `got=${got}`);
}

// 6) 跨日边界（UTC 深夜 + 8 小时应落到次日）
{
  const got = formatLocalTime('2026-01-01 20:00:00');
  const want = expectedLocal('2026-01-01T20:00:00Z');
  assert(got === want, '跨日转换正确（UTC 20:00 → 本地次日 04:00 之类）', `got=${got} want=${want}`);
}

// 7) 真实用例：库里的记录时间不再是"早 8 小时"的那个串
{
  const dbValue = '2026-09-08 15:46:06';
  const shown = formatLocalTime(dbValue, true);   // 带秒才能精确比对
  const asUtcDate = new Date('2026-09-08T15:46:06Z');
  assert(new Date(shown.replace(' ', 'T')).getTime() === asUtcDate.getTime(),
    '展示值与 UTC 时刻指向同一瞬间（只是换算到本地时区）',
    `shown=${shown}`);
}

console.log(`\n时间显示回归：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

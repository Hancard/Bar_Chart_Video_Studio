/**
 * 时间显示（前后端共用）
 *
 * 背景：数据库里的 `created_at` / `updated_at` 由 SQLite 的 `datetime('now')` 生成，
 * 它返回的是 **UTC**（本机实测 2026-10-03 00:14 vs 本地 08:14，差 8 小时）。
 * 前端原来直接 `s.slice(0, 16)` 展示，用户看到的时间比实际早 8 小时
 * （"更新于 2026-09-14 23:34" 实际是本地 09-15 07:34）。
 */

/**
 * 把 SQLite 的 UTC 时间串转成本地时间展示。
 *
 * @param value "2026-10-03 00:14:05"（SQLite datetime）或 ISO 串；null/undefined 返回 '—'
 * @param withSeconds 是否带秒
 */
export function formatLocalTime(value: string | null | undefined, withSeconds = false): string {
  if (!value) return '—';
  const raw = String(value).trim();
  if (!raw) return '—';
  // "2026-10-03 00:14:05" → "2026-10-03T00:14:05Z"（SQLite 不写时区，按 UTC 解释）
  // 已带 Z / 带偏移量的 ISO 串保持原样解析。
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? raw
    : raw.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 16); // 解析不了就原样截断，别显示 Invalid Date
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

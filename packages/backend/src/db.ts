/**
 * SQLite 初始化与 DDL —— 严格对应技术方案 §4.4
 * 单机单用户定稿：SQLite 即最终数据库；DDL 按可移植口径书写。
 *
 * 含 schema 迁移（additive only），所以旧 DB 自动兼容到 v2（多值数据集）。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(BACKEND_ROOT, 'data');
export const STORAGE_DIR = path.join(BACKEND_ROOT, 'storage');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(STORAGE_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 3000'); // 写锁短暂等待而非立刻抛 SQLITE_BUSY

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY,
  title         TEXT    NOT NULL DEFAULT '未命名项目',
  description   TEXT,
  config        TEXT    NOT NULL DEFAULT '{}',
  dataset_hash  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_series (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  time_key    TEXT    NOT NULL,
  time_order  INTEGER NOT NULL,
  entity      TEXT    NOT NULL,
  value       REAL    NOT NULL,
  values_json TEXT,
  UNIQUE (project_id, time_order, entity)
);
CREATE INDEX IF NOT EXISTS idx_ts_project ON time_series(project_id, time_order);

CREATE TABLE IF NOT EXISTS datasets_meta (
  project_id     INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  value_columns  TEXT    NOT NULL DEFAULT '["value"]',
  default_value_column TEXT NOT NULL DEFAULT 'value'
);

CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity      TEXT    NOT NULL,
  color       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, entity)
);

CREATE TABLE IF NOT EXISTS records (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  config_snapshot TEXT NOT NULL,
  file_path   TEXT,
  format      TEXT    NOT NULL DEFAULT 'mp4',
  width       INTEGER NOT NULL DEFAULT 1920,
  height      INTEGER NOT NULL DEFAULT 1080,
  fps         INTEGER NOT NULL DEFAULT 30,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- records 一直缺索引：/records?projectId=x 与每个项目的成片计数都是全表扫。
-- IF NOT EXISTS 让旧库启动时自动补上。
CREATE INDEX IF NOT EXISTS idx_records_project ON records(project_id, created_at);

CREATE TABLE IF NOT EXISTS ai_tasks (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'deepseek-chat',
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  request TEXT, response TEXT, status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/**
 * 兼容迁移：旧版 time_series 没有 values_json / datasets_meta。
 * 增量 ALTER TABLE 幂等执行（IF NOT EXISTS 不能用于 ADD COLUMN，这里查 pragma_column_info 决定）。
 */
function ensureColumn(table: string, col: string, decl: string) {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}

function ensureTable(name: string, ddl: string) {
  const exists = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(name) as { name: string } | undefined);
  if (!exists) db.exec(ddl);
}

ensureColumn('time_series', 'values_json', 'TEXT');
ensureTable('datasets_meta', `
  CREATE TABLE datasets_meta (
    project_id     INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    value_columns  TEXT    NOT NULL DEFAULT '["value"]',
    default_value_column TEXT NOT NULL DEFAULT 'value'
  )
`);

/** 内容哈希（幂等导入比对用） */
export function contentHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export default db;

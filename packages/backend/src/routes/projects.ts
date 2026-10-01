import type { FastifyInstance } from 'fastify';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import db, { STORAGE_DIR } from '../db';
import { hasData } from '../services/importService';
import { createProjectSchema, updateProjectSchema, DEFAULT_RENDER_CONFIG } from '@barstudio/shared';
import type { ProjectInfo, RenderConfig } from '@barstudio/shared';
import { ZodError } from 'zod';

type ProjectRow = {
  id: number; title: string; description: string | null; config: string;
  dataset_hash: string | null; created_at: string; updated_at: string;
};

function toInfo(row: ProjectRow, recordCount?: number, hasDataFlag?: boolean): ProjectInfo {
  let config: RenderConfig;
  try { config = { ...DEFAULT_RENDER_CONFIG, ...JSON.parse(row.config) }; }
  catch { config = { ...DEFAULT_RENDER_CONFIG }; }
  // 列表页会一次性把各项目的成片数与「有没有数据」查出来传进来；
  // 单条查询（详情 / 创建 / 更新）时按需再查。
  const rc = recordCount
    ?? (db.prepare('SELECT COUNT(*) AS c FROM records WHERE project_id = ?').get(row.id) as { c: number }).c;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    config,
    dataset_hash: row.dataset_hash,
    hasData: hasDataFlag ?? hasData(row.id),
    recordCount: rc,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function projectRoutes(app: FastifyInstance) {
  app.get('/projects', async () => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
    // 一次查完全部项目的成片数：原实现靠 toInfo 对每个项目单独 COUNT，项目多时是 N+1
    const counts = db.prepare(
      'SELECT project_id, COUNT(*) AS c FROM records GROUP BY project_id'
    ).all() as { project_id: number; c: number }[];
    const countMap = new Map(counts.map(r => [r.project_id, r.c]));
    // 「有没有数据」同理：hasData() 是每个项目一次 COUNT(*)，49 个项目就是 49 次查询。
    // 一次查出所有有数据的 project_id（DISTINCT 走 idx_ts_project 索引）。
    const withData = db.prepare(
      'SELECT DISTINCT project_id FROM time_series'
    ).all() as { project_id: number }[];
    const dataSet = new Set(withData.map(r => r.project_id));
    // 注意不能写 rows.map(toInfo)：Array.map 会把下标当第二个实参传进去
    return { data: rows.map(r => toInfo(r, countMap.get(r.id) ?? 0, dataSet.has(r.id))) };
  });

  app.post('/projects', async (req, reply) => {
    const parsed = createProjectSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send(validationError(parsed.error));
    const { title, description, config } = parsed.data;
    const full = { ...DEFAULT_RENDER_CONFIG, ...(config ?? {}) };
    const r = db.prepare(
      'INSERT INTO projects (title, description, config) VALUES (?, ?, ?)'
    ).run(title, description ?? null, JSON.stringify(full));
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid) as ProjectRow;
    return reply.status(201).send({ data: toInfo(row) });
  });

  app.get('/projects/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) return reply.status(404).send(notFound());
    return { data: toInfo(row) };
  });

  app.patch('/projects/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) return reply.status(404).send(notFound());
    const parsed = updateProjectSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send(validationError(parsed.error));
    const { title, description, config } = parsed.data;
    const merged = { ...toInfo(row).config, ...(config ?? {}) };
    db.prepare(
      `UPDATE projects SET title = ?, description = ?, config = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(title ?? row.title, description === undefined ? row.description : description, JSON.stringify(merged), id);
    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
    return { data: toInfo(updated) };
  });

  app.delete('/projects/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    // 级联删除只清 DB 行，storage 下的成片文件需手动清理
    const files = db.prepare(
      'SELECT file_path FROM records WHERE project_id = ? AND file_path IS NOT NULL'
    ).all(id) as { file_path: string }[];
    const r = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    if (r.changes === 0) return reply.status(404).send(notFound());
    for (const f of files) {
      const full = path.join(STORAGE_DIR, f.file_path);
      if (existsSync(full)) { try { unlinkSync(full); } catch { /* 单机工具：删不掉不阻塞 */ } }
    }
    return reply.status(204).send();
  });
}

export function notFound() {
  return { error: { code: 'E_NOT_FOUND', message: '资源不存在' } };
}

export function validationError(err: ZodError) {
  return {
    error: {
      code: 'E_VALIDATION',
      message: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    },
  };
}

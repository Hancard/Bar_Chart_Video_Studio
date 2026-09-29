import type { FastifyInstance } from 'fastify';
import { createReadStream, createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import db, { STORAGE_DIR } from '../db';
import { createRecordSchema } from '@barstudio/shared';
import { notFound, validationError } from './projects';
import type { RecordInfo, RenderConfig } from '@barstudio/shared';

type RecordRow = {
  id: number; project_id: number; config_snapshot: string; file_path: string | null;
  format: string; width: number; height: number; fps: number;
  duration_ms: number; size_bytes: number; created_at: string;
};

function toInfo(row: RecordRow): RecordInfo {
  let cfg: RenderConfig;
  try { cfg = JSON.parse(row.config_snapshot); } catch { cfg = {} as RenderConfig; }
  return { ...row, config_snapshot: cfg };
}

export async function recordRoutes(app: FastifyInstance) {
  app.get('/records', async (req) => {
    const projectId = Number((req.query as any).projectId);
    const rows = (projectId > 0
      ? db.prepare(
          `SELECT r.*, p.title AS project_title FROM records r LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.project_id = ? ORDER BY r.created_at DESC`
        ).all(projectId)
      : db.prepare(
          `SELECT r.*, p.title AS project_title FROM records r LEFT JOIN projects p ON p.id = r.project_id
           ORDER BY r.created_at DESC`
        ).all()
    ) as (RecordRow & { project_title: string | null })[];
    return { data: rows.map(r => ({ ...toInfo(r), project_title: r.project_title ?? undefined })) };
  });

  app.post('/records', async (req, reply) => {
    const parsed = createRecordSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send(validationError(parsed.error));
    const { project_id, config_snapshot, duration_ms, size_bytes, format } = parsed.data;
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
    if (!project) return reply.status(404).send(notFound());
    const r = db.prepare(
      `INSERT INTO records (project_id, config_snapshot, format, width, height, fps, duration_ms, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(project_id, JSON.stringify(config_snapshot), format,
      config_snapshot.width, config_snapshot.height, config_snapshot.fps, duration_ms, size_bytes);
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(r.lastInsertRowid) as RecordRow;
    return reply.status(201).send({ data: toInfo(row) });
  });

  /** 上传产物文件存档（multipart） */
  app.post('/records/:id/file', async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined;
    if (!row) return reply.status(404).send(notFound());
    const file = await (req as any).file();
    if (!file) return reply.status(400).send({ error: { code: 'E_VALIDATION', message: '缺少文件' } });
    const ext = (file.filename || 'video.mp4').toLowerCase().endsWith('.webm') ? 'webm' : 'mp4';
    const rel = `${id}-${Date.now()}.${ext}`;
    const oldRel = row.file_path;
    const full = path.join(STORAGE_DIR, rel);
    try {
      await pipeline(file.file, createWriteStream(full));
    } catch (err) {
      // 中途失败（客户端断开/磁盘满）：清掉半成品，避免磁盘孤儿文件 + DB 无记录
      try { unlinkSync(full); } catch { /* ignore */ }
      throw err;
    }
    const st = statSync(full);
    db.prepare('UPDATE records SET file_path = ?, size_bytes = ?, format = ? WHERE id = ?').run(rel, st.size, ext, id);
    // 重复上传覆盖：删除旧存档文件，避免孤儿
    if (oldRel && oldRel !== rel) {
      const oldFull = path.join(STORAGE_DIR, oldRel);
      if (existsSync(oldFull)) { try { unlinkSync(oldFull); } catch { /* 删不掉不阻塞响应 */ } }
    }
    return reply.status(201).send({ data: { id, file_path: rel, size_bytes: st.size } });
  });

  app.get('/records/:id/file', async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined;
    if (!row) return reply.status(404).send(notFound());
    if (!row.file_path || !existsSync(path.join(STORAGE_DIR, row.file_path))) {
      return reply.status(404).send({ error: { code: 'E_NOT_FOUND', message: '成片文件不存在（可能未上传存档）' } });
    }
    const full = path.join(STORAGE_DIR, row.file_path);
    // 显式设置 Content-Length，否则 Node 读 stream 时部分客户端/代理会显示 0
    const stat = statSync(full);
    reply.header('content-length', String(stat.size));
    reply.header('content-type', row.format === 'webm' ? 'video/webm' : 'video/mp4');
    // 不设置文件名时，浏览器会拿 URL 的 basename 当文件名 —— 这里就是 "file"，
    // 连扩展名都没有，下载下来系统不知道该用什么打开。
    const ext = row.format === 'webm' ? 'webm' : 'mp4';
    const proj = db.prepare('SELECT title FROM projects WHERE id = ?').get(row.project_id) as { title: string } | undefined;
    const safeTitle = String(proj?.title ?? 'bar-chart-race').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'bar-chart-race';
    const stamp = String(row.created_at ?? '').replace(/[-: ]/g, '').slice(0, 8);
    const human = `${safeTitle}-${stamp || id}.${ext}`;
    // 标题可能是中文：按 RFC 5987 给 filename*，同时留一个 ASCII fallback
    reply.header(
      'content-disposition',
      `attachment; filename="bar-chart-race-${id}.${ext}"; filename*=UTF-8''${encodeURIComponent(human)}`,
    );
    return (reply as any).send(createReadStream(full));
  });

  app.delete('/records/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined;
    if (!row) return reply.status(404).send(notFound());
    if (row.file_path) {
      const full = path.join(STORAGE_DIR, row.file_path);
      // Windows 上文件可能被播放器/上传中的句柄占用（EBUSY/EPERM）。
      // 删不掉文件只应留下磁盘孤儿，不能让整条记录删不掉、更不能冒 500。
      if (existsSync(full)) {
        try { unlinkSync(full); } catch { /* 见上 */ }
      }
    }
    db.prepare('DELETE FROM records WHERE id = ?').run(id);
    return reply.status(204).send();
  });
}

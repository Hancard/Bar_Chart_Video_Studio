import type { FastifyInstance } from 'fastify';
import db from '../db';
import {
  importSeriesRaw, importSeriesMulti, getSeries, getDatasetMeta, getSummary, parseLongCsv,
} from '../services/importService';
import { importPayloadSchema, importMultiValuePayloadSchema, decodeBytes } from '@barstudio/shared';
import { notFound, validationError } from './projects';

export async function datasetRoutes(app: FastifyInstance) {
  /** JSON 导入（主链路：前端已解析 + 列映射后的长表） */
  app.post('/projects/:id/datasets/import', async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send(notFound());
    const parsed = importPayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send(validationError(parsed.error));
    const { rows } = parsed.data;
    if (rows.length === 0) {
      return reply.status(400).send({ error: { code: 'E_EMPTY_TIMESERIES', message: '没有可导入的数据行' } });
    }
    const result = importSeriesRaw(id, rows);
    if (result.imported === 0) {
      return reply.status(400).send({
        error: { code: 'E_EMPTY_TIMESERIES', message: '没有可导入的有效数据行（所有行均解析失败）' },
      });
    }
    return reply.status(201).send({ data: { ...result, summary: getSummary(id) } });
  });

  /** 多值 JSON 导入（横坐标选取：同行为多列值的导入） */
  app.post('/projects/:id/datasets/import-multi', async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send(notFound());
    const parsed = importMultiValuePayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send(validationError(parsed.error));
    const result = importSeriesMulti(id, parsed.data);
    if (result.imported === 0) {
      return reply.status(400).send({
        error: { code: 'E_EMPTY_TIMESERIES', message: '多值导入：没有任何有效行' },
      });
    }
    return reply.status(201).send({ data: { ...result, summary: getSummary(id) } });
  });

  /** multipart 上传 CSV 文件（后端解析长表）或 sourceUrl 抓取 */
  app.post('/projects/:id/datasets/upload', async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send(notFound());

    let csvText = '';
    const ct = req.headers['content-type'] ?? '';

    if (ct.includes('application/json')) {
      // { sourceUrl } 抓取政府公开数据
      const body = (req.body ?? {}) as { sourceUrl?: string };
      if (!body.sourceUrl) {
        return reply.status(400).send({ error: { code: 'E_VALIDATION', message: 'sourceUrl 不能为空' } });
      }
      try {
        const res = await fetch(body.sourceUrl, {
          headers: { 'user-agent': 'Mozilla/5.0 bar-chart-video-studio' },
          signal: AbortSignal.timeout(20_000), // 防挂死 URL 长期占用连接
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') ?? 0);
        if (Number.isFinite(len) && len > 64 * 1024 * 1024) {
          throw new Error(`文件过大（${(len / 1048576).toFixed(0)}MB，上限 64MB）`);
        }
        const buf = await res.arrayBuffer();
        // 编码探测：UTF-16 BOM → UTF-8 严格 → GBK → 兜底（与前端 decodeFile 同一实现）
        csvText = decodeBytes(new Uint8Array(buf));
      } catch (e: any) {
        return reply.status(400).send({ error: { code: 'E_CSV_PARSE', message: `抓取失败: ${e.message}` } });
      }
    } else {
      const file = await (req as any).file();
      if (!file) return reply.status(400).send({ error: { code: 'E_CSV_PARSE', message: '缺少文件' } });
      const buf = await file.toBuffer();
      csvText = decodeBytes(buf);
    }

    const { rows, errors } = parseLongCsv(csvText);
    if (rows.length === 0) {
      return reply.status(400).send({ error: { code: 'E_CSV_PARSE', message: errors.join('; ') || 'CSV 中没有有效数据' } });
    }
    const result = importSeriesRaw(id, rows);
    return reply.status(201).send({ data: { ...result, warnings: errors, summary: getSummary(id) } });
  });

  /** 取回时序数据。可选 query 参数 ?valueColumn=name 切换当前柱长所用列。 */
  app.get('/projects/:id/datasets', async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send(notFound());
    // 切换列优先级：query 显式 > project.config.valueColumn > meta.defaultValueColumn
    const meta = getDatasetMeta(id);
    const cols = meta.valueColumns;
    const isValid = (c?: string) => Boolean(c && cols.includes(c));
    const qVc = (req.query as { valueColumn?: string }).valueColumn;
    let cfgVc: string | undefined;
    const cfgRow = db.prepare('SELECT config FROM projects WHERE id = ?').get(id) as { config: string } | undefined;
    if (cfgRow) {
      try { cfgVc = (JSON.parse(cfgRow.config).valueColumn as string | undefined); } catch { cfgVc = undefined; }
    }
    // invalid query valueColumn → 退回 project.config.valueColumn；仍无效则用 meta.default
    const vc = isValid(qVc) ? qVc
      : (isValid(cfgVc) ? cfgVc : meta.defaultValueColumn);
    return { data: getSeries(id, vc) };
  });

  app.get('/projects/:id/datasets/summary', async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send(notFound());
    return { data: getSummary(id) };
  });

  app.delete('/projects/:id/datasets', async (req, reply) => {
    const id = Number((req.params as any).id);
    // 与同文件其它端点一致：项目不存在应 404，而不是 200 + deleted:0
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send(notFound());
    // 这几条写语句原子化：避免中途崩溃留下「数据已删但元信息还在」的中间态。
    // datasets_meta 必须一起清 —— 否则清空数据后 GET /datasets 仍返回上一次的多值列清单，
    // 前端「值列」下拉里会留着已经不存在的数据列；entities 同理（遗留实体列表已无意义）。
    const r = db.transaction(() => {
      const del = db.prepare('DELETE FROM time_series WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM datasets_meta WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM entities WHERE project_id = ?').run(id);
      db.prepare(`UPDATE projects SET dataset_hash = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
      return del;
    })();
    return reply.status(200).send({ data: { deleted: r.changes } });
  });
}

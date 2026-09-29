import { z } from 'zod';
import { DEFAULT_RENDER_CONFIG } from './types';

/** 渲染配置 schema：PATCH 允许部分更新 */
export const renderConfigSchema = z.object({
  title: z.string().max(120).default(DEFAULT_RENDER_CONFIG.title),
  subtitle: z.string().max(200).default(''),
  sourceNote: z.string().max(120).default(DEFAULT_RENDER_CONFIG.sourceNote),
  maxBars: z.number().int().min(1).max(100).default(15),
  secondsPerStep: z.number().min(0.1).max(10).default(1.0),
  headHold: z.number().min(0).max(5).default(0.5),
  tailHold: z.number().min(0).max(5).default(0.5),
  palette: z.string().default('flat'),
  showValues: z.boolean().default(true),
  valueDecimals: z.number().int().min(0).max(4).default(0),
  showRank: z.boolean().default(true),
  timeLabelPos: z.enum(['top-left', 'top-right', 'none']).default('top-right'),
  timeLabelMode: z.enum(['step', 'continuous']).default('step'),
  fontScale: z.number().min(0.6).max(1.6).default(1),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f5f6fa'),
  width: z.number().int().min(640).max(3840).default(1920),
  height: z.number().int().min(360).max(3840).default(1080),
  fps: z.number().int().min(10).max(60).default(30),
  videoBitsPerSecond: z.number().int().min(1_000_000).max(40_000_000).default(8_000_000),
  valueColumn: z.string().max(64).optional(),
  /** 顶部数轴刻度步幅；0/未设置 = 自动（nice step） */
  axisStep: z.number().min(0).max(1e12).optional(),
});

/** 长表单值导入 payload —— value 允许多种形态（由后端 importService 统一清洗为 number，符合方案 §9 缺失/异常值策略） */
export const importPayloadSchema = z.object({
  rows: z.array(z.object({
    time_key: z.string().max(64),
    entity: z.string().max(200),
    // z.unknown() 比 nullable + optional 更精确：保留所有入参，由后端过滤
    value: z.unknown(),
  })).min(1),
});

/** 长表多值导入 payload —— 同一行承载多个数值列（如 原始 / 插值 / 填补） */
export const importMultiValuePayloadSchema = z.object({
  rows: z.array(z.object({
    time_key: z.string().max(64),
    entity: z.string().max(200),
    // 值列名 → 数值 / null；后端统一 Number() 清洗，缺/脏值变 null
    values: z.record(z.string().max(64), z.unknown()),
  })).min(1),
  /** 该批数据携带的"值列"名清单，必须按表头固定顺序 */
  valueColumns: z.array(z.string().min(1).max(64)).min(1),
  /** 默认显示哪一列（可选，未提供时 = valueColumns[0]） */
  defaultValueColumn: z.string().max(64).optional(),
});

export const createProjectSchema = z.object({
  title: z.string().min(1).max(120).default('未命名项目'),
  description: z.string().max(2000).optional().nullable(),
  config: renderConfigSchema.partial().optional(),
});

export const updateProjectSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  config: renderConfigSchema.partial().optional(),
});

export const createRecordSchema = z.object({
  project_id: z.number().int().positive(),
  config_snapshot: renderConfigSchema,
  duration_ms: z.number().int().min(0).default(0),
  size_bytes: z.number().int().min(0).default(0),
  /** 实际产出格式。以前后端写死 'mp4'，导出 WebM 的记录也会标成 mp4，
   *  下载时用错的 Content-Type 与扩展名（内容与后缀不符）。 */
  format: z.enum(['mp4', 'webm']).default('mp4'),
});

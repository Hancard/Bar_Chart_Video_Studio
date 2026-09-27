/**
 * 录制导出链路（技术方案 §3.5 / §6.3 实现必读）
 *
 * 1. 隐藏高清画布（默认 1920×1080，不挂 DOM）
 * 2. canvas.captureStream(0) + track.requestFrame() 手动推帧（帧率精确、不受高刷屏影响）
 *    —— 不支持 requestFrame 时降级 captureStream(fps)
 * 3. MediaRecorder mimeType 探测降级链：
 *    mp4(avc1) 直录 → webm(vp9) → webm(vp8) → webm
 * 4. 墙钟时间驱动渲染进度（暂停/恢复不跳帧，变速不丢时间）
 * 5. webm 产物用 ffmpeg.wasm 就地转 H.264 mp4（yuv420p + faststart）；
 *    ffmpeg 加载/转码失败时降级交付 webm
 * 6. 时间基准 setTimeout 按目标帧时刻自校正，避免累计漂移
 */
import type { RenderConfig } from '@barstudio/shared';
import { interpolate, progressToOrderF, totalDuration, type Dataset } from '../renderer/frames';
import { renderer } from '../renderer/engine';
import type { Palette } from '../renderer/palettes';

export type ExportStage = 'prepare' | 'record' | 'transcode' | 'done';

export interface ExportProgress {
  stage: ExportStage;
  /** 0-1 */
  progress: number;
  message: string;
}

export interface ExportVideoOptions {
  config: RenderConfig;
  dataset: Dataset;
  palette: Palette;
  colorOf: (entity: string) => string;
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  format: 'mp4' | 'webm';
  durationMs: number;
  fileName: string;
}

function pickMimeType(): { mime: string; direct: boolean } {
  const candidates: { mime: string; direct: boolean }[] = [
    { mime: 'video/mp4;codecs=avc1.42E01E', direct: true },  // Chrome 126+ 直录 H.264
    { mime: 'video/webm;codecs=vp9', direct: false },
    { mime: 'video/webm;codecs=vp8', direct: false },
    { mime: 'video/webm', direct: false },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  throw new Error('当前浏览器不支持 MediaRecorder，请使用 Chrome / Edge');
}

const FFMPEG_CORE_VERSION = '0.12.6';

/**
 * 转码内核的候选来源，按顺序尝试。
 *
 * 原实现只认 unpkg —— 国内网络经常不可达，结果用户每次导出都静默降级成 WebM，
 * 拿不到 mp4。这里依次退到 jsdelivr / npmmirror（国内可达性好），
 * 并优先同源 `/ffmpeg-core/`：把 `ffmpeg-core.js` + `ffmpeg-core.wasm`
 * 放到 `packages/frontend/public/ffmpeg-core/` 即可完全离线转码。
 */
const FFMPEG_CORE_BASES: string[] = [
  ...(typeof location !== 'undefined' ? [`${location.origin}/ffmpeg-core`] : []),
  `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`,
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`,
  `https://registry.npmmirror.com/@ffmpeg/core/${FFMPEG_CORE_VERSION}/files/dist/umd`,
];

async function loadFfmpeg(onLog?: (msg: string) => void): Promise<any> {
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const { toBlobURL } = await import('@ffmpeg/util');
  const errors: string[] = [];
  for (const base of FFMPEG_CORE_BASES) {
    try {
      const ffmpeg = new FFmpeg();
      if (onLog) ffmpeg.on('log', ({ message }: any) => onLog(message));
      const coreURL = await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript');
      const wasmURL = await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm');
      await ffmpeg.load({ coreURL, wasmURL });
      return ffmpeg;
    } catch (err: any) {
      errors.push(`${base.replace(/^https?:\/\//, '').slice(0, 48)}: ${err?.message ?? err}`);
    }
  }
  throw new Error(`转码内核加载失败（已尝试 ${FFMPEG_CORE_BASES.length} 个源）→ ${errors.join(' | ')}`);
}

/**
 * 模块级缓存：转码内核是 ~30MB 的 wasm，加载 + 编译要几秒。
 * 原实现每次导出都调 loadFfmpeg() —— toBlobURL 每次重新生成 blob URL
 * （旧的从不 revoke，等于每次导出泄漏约 30MB 内存），wasm 也要重新编译。
 */
let ffmpegPromise: Promise<any> | null = null;
/** 本次导出的转码进度回调（'progress' 监听只注册一次，避免多次导出堆积 handler） */
let transcodeProgress: ((p: number) => void) | null = null;

async function getFfmpeg(): Promise<any> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ff = await loadFfmpeg();
      ff.on('progress', ({ progress }: any) => {
        if (transcodeProgress && Number.isFinite(progress)) transcodeProgress(progress);
      });
      return ff;
    })().catch((err) => {
      ffmpegPromise = null; // 加载失败不留缓存，下次导出可重试
      throw err;
    });
  }
  return ffmpegPromise;
}

export async function exportVideo(opts: ExportVideoOptions): Promise<ExportResult> {
  const { config, dataset, palette, colorOf, onProgress, signal } = opts;
  const report = (stage: ExportStage, progress: number, message: string) =>
    onProgress?.({ stage, progress, message });

  if (dataset.times.length === 0) throw new Error('没有数据，无法导出');

  // ---- 准备离屏画布 ----
  report('prepare', 0, '准备导出画布…');
  const canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('无法创建 2D 绘图上下文');

  // ---- 预算实体名标签区宽度（dataset.entities 全集一次性预算，保持跨帧稳定）----
  const s = config.width / 1920;
  const fs = config.fontScale;
  const nameFont = `700 ${30 * s * fs}px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif`;
  const measuredName = renderer.measureLabelWidth(dataset.entities, nameFont, ctx);
  const labelWidth = Math.min(460 * s, Math.max(120 * s, measuredName));

  const { mime, direct } = pickMimeType();

  const manualMode = (() => {
    try {
      const probe = document.createElement('canvas');
      const st: MediaStream = (probe as any).captureStream(0);
      const ok = typeof (st.getVideoTracks()[0] as any).requestFrame === 'function';
      // 探测用的捕获流必须立刻停掉，否则每次导出都漏一个 MediaStreamTrack
      st.getTracks().forEach((t) => t.stop());
      return ok;
    } catch {
      return false;
    }
  })();

  const stream: MediaStream = (canvas as any).captureStream(manualMode ? 0 : config.fps);
  const track = stream.getVideoTracks()[0] as any;
  /** 释放画布捕获流：不 stop 的话每次导出都会留下一个持续捕获画布的 track */
  const releaseStream = () => {
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
  };

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: config.videoBitsPerSecond,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (e: any) => reject(new Error(`录制出错: ${e?.error?.name ?? 'unknown'}`));
  });

  const duration = totalDuration(dataset, config.secondsPerStep, config.headHold, config.tailHold);
  const frameInterval = 1000 / config.fps;
  const startedAt = performance.now();

  report('record', 0, `开始录制（${direct ? '直录 mp4' : '录制 WebM'}，${config.width}×${config.height}@${config.fps}fps）…`);

  recorder.start(1000);

  // ---- 墙钟驱动渲染循环：按目标帧时刻自校正漂移 ----
  await new Promise<void>((resolve, reject) => {
    const drawOptions = { width: config.width, height: config.height, config, palette, colorOf, dataset, labelWidth };

    const drawAt = (elapsedMs: number) => {
      const p = Math.min(elapsedMs / 1000 / duration, 1);
      const orderF = progressToOrderF(dataset, p, config.secondsPerStep, config.headHold, config.tailHold);
      const frame = interpolate(dataset, orderF, config.maxBars);
      renderer.draw(frame, drawOptions, ctx);
    };

    // 首帧立即绘制
    drawAt(0);
    if (manualMode) track.requestFrame();

    let frameIndex = 0;
    const tick = () => {
      if (signal?.aborted) {
        try { recorder.stop(); } catch { /* noop */ }
        releaseStream();
        reject(new DOMException('已取消导出', 'AbortError'));
        return;
      }
      const targetMs = frameIndex * frameInterval;
      const now = performance.now() - startedAt;
      if (targetMs > now) {
        setTimeout(tick, Math.max(0, targetMs - now));
        return;
      }
      if (now >= duration * 1000 + 120) {
        // 收尾：定格尾帧已画，多留 120ms 缓冲后停止
        try { recorder.stop(); } catch { /* noop */ }
        resolve();
        return;
      }
      drawAt(now);
      if (manualMode) track.requestFrame();
      frameIndex++;
      report('record', Math.min(now / 1000 / duration, 1), `录制中 ${(Math.min(now / 1000, duration)).toFixed(1)}s / ${duration.toFixed(1)}s`);
      setTimeout(tick, 0); // 立即排下一帧（由 targetMs 自校正等待）
    };
    setTimeout(tick, frameInterval);
  });

  try {
    await stopped;
  } finally {
    // 正常结束 / recorder 报错，捕获流都不再需要（此前不 stop，每次导出都会留下一个持续捕获画布的 track）
    releaseStream();
  }
  const recordedMs = performance.now() - startedAt;

  if (signal?.aborted) throw new DOMException('已取消导出', 'AbortError');
  if (chunks.length === 0) throw new Error('录制结果为空（浏览器可能限制了后台标签页渲染，请保持页面在前台重试）');

  const rawBlob = new Blob(chunks, { type: mime.split(';')[0] });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const baseName = (config.title || 'bar-chart-race').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);

  if (direct) {
    report('done', 1, '导出完成（mp4 直录）');
    return { blob: rawBlob, format: 'mp4', durationMs: Math.round(duration * 1000), fileName: `${baseName}-${stamp}.mp4` };
  }

  // ---- ffmpeg.wasm: WebM → H.264 mp4 ----
  report('transcode', 0, '加载转码内核（首次约 30MB，之后复用常驻实例）…');
  try {
    const ffmpeg = await getFfmpeg();
    const { fetchFile } = await import('@ffmpeg/util');
    await ffmpeg.writeFile('in.webm', await fetchFile(rawBlob));
    // 进度回调走模块级变量：'progress' 监听只在 getFfmpeg() 里注册一次，
    // 否则每导出一次都会往同一个 ffmpeg 实例上挂一个 handler。
    transcodeProgress = (p) => {
      const v = Math.min(Math.max(p, 0), 1);
      report('transcode', v, `转码 mp4 ${(v * 100).toFixed(0)}%`);
    };
    report('transcode', 0, '转码中（H.264 / yuv420p / faststart）…');
    try {
      await ffmpeg.exec([
        '-i', 'in.webm',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-r', String(config.fps),
        'out.mp4',
      ]);
      const data = await ffmpeg.readFile('out.mp4');
      const blob = new Blob([data], { type: 'video/mp4' });
      try { await ffmpeg.deleteFile('in.webm'); await ffmpeg.deleteFile('out.mp4'); } catch { /* noop */ }
      report('done', 1, '导出完成');
      return { blob, format: 'mp4', durationMs: Math.round(duration * 1000), fileName: `${baseName}-${stamp}.mp4` };
    } finally {
      transcodeProgress = null;
    }
  } catch (err: any) {
    // 降级：交付 WebM（方案 §9 备选路径）
    const msg = err?.message ?? String(err);
    report('done', 1, `ffmpeg 转码失败（${msg}），已降级保存 WebM`);
    return {
      blob: rawBlob,
      format: 'webm',
      durationMs: Math.round(recordedMs),
      fileName: `${baseName}-${stamp}.webm`,
    };
  }
}

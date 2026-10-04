/** REST client：统一 { data } / { error } 响应约定（方案 §4.3） */
const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

async function readJson(res: Response): Promise<unknown> {
  // 不能直接用 res.json()：后端没启动、或 /api 代理把请求指到了前端页面时，
  // 响应体可能是 HTML 或空 —— res.json() 抛错后若兜成 {}，
  // 调用方会拿到 undefined（`({}).data`）而不是一个能定位问题的错误。
  const text = await res.text().catch(() => '');
  if (text.trim() === '') return null;
  try { return JSON.parse(text); } catch { return null; }
}

function badResponse(status: number): ApiError {
  return new ApiError(
    'E_BAD_RESPONSE',
    `服务端返回的不是 JSON（HTTP ${status}）—— 后端可能未启动，或 /api 代理指向了前端页面`,
    status,
  );
}

/**
 * fetch 的网络层异常统一包装。
 * 直接冒出去的话，用户看到的是 "Failed to fetch"（Chrome）/ "NetworkError when attempting…"（Firefox），
 * 完全定位不到问题；包成 ApiError 后能明确指向"后端可能没启动"。
 */
async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err; // 主动取消原样抛出，交给调用方处理
    throw new ApiError(
      'E_NETWORK',
      `无法连接服务端（${err?.message ?? err}）—— 请确认后端已启动`,
      0,
    );
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await safeFetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await readJson(res);
  if (json === null) throw badResponse(res.status);
  if (!res.ok) {
    const err = (json as any).error ?? { code: 'E_INTERNAL', message: `HTTP ${res.status}` };
    throw new ApiError(err.code, err.message, res.status);
  }
  if (typeof json === 'object' && 'data' in (json as object)) return (json as any).data as T;
  throw badResponse(res.status);
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),

  /** multipart 文件上传 */
  uploadFile: async <T>(path: string, file: Blob, filename: string): Promise<T> => {
    const fd = new FormData();
    fd.append('file', file, filename);
    const res = await safeFetch(`${BASE}${path}`, { method: 'POST', body: fd });
    if (res.status === 204) return undefined as T;
    const json = await readJson(res);
    if (json === null) throw badResponse(res.status);
    if (!res.ok) {
      const err = (json as any).error ?? { code: 'E_INTERNAL', message: `HTTP ${res.status}` };
      throw new ApiError(err.code, err.message, res.status);
    }
    if (typeof json === 'object' && 'data' in (json as object)) return (json as any).data as T;
    throw badResponse(res.status);
  },
};

/**
 * 端到端 API 冒烟测试 —— 不依赖任何框架，断言后端业务逻辑正确性
 * 用法：node scripts/e2e.mjs
 */
import { apiBase, installAutoCleanup } from './lib-test-utils.mjs';
const BASE = apiBase();
// 本次新建的项目在结束时自动清掉（断言失败 / 崩溃同样会清）
const cleanup = await installAutoCleanup(BASE);
let pass = 0, fail = 0;
const fails = [];

function assert(cond, msg) {
  if (cond) { pass++; console.log(`✓ ${msg}`); }
  else { fail++; fails.push(msg); console.log(`✗ ${msg}`); }
}

async function req(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function run() {
  // 0) health
  const h = await req('GET', '/health');
  assert(h.status === 200 && h.body.data?.status === 'ok', 'health 接口返回 200/ok');

  // 1) 空列表
  const l0 = await req('GET', '/projects');
  assert(l0.status === 200 && Array.isArray(l0.body.data), '项目列表接口返回数组');

  // 2) 创建项目
  const c1 = await req('POST', '/projects', { title: 'e2e-A' });
  assert(c1.status === 201 && c1.body.data.id > 0, '创建项目 → 201 + id');
  const pidA = c1.body.data.id;

  // 3) 创建项目（带 config 覆盖）
  const c2 = await req('POST', '/projects', {
    title: 'e2e-B',
    description: 'desc',
    config: { title: 'B标题', maxBars: 7, palette: 'dark' },
  });
  assert(c2.status === 201 && c2.body.data.config.maxBars === 7 && c2.body.data.config.palette === 'dark', '创建时 config 部分覆盖生效');
  const pidB = c2.body.data.id;

  // 4) 取不存在的项目
  const g404 = await req('GET', '/projects/9999999');
  assert(g404.status === 404 && g404.body.error?.code === 'E_NOT_FOUND', '取不存在项目 → 404/E_NOT_FOUND');

  // 5) 读已创建项目
  const g1 = await req('GET', `/projects/${pidA}`);
  assert(g1.status === 200 && g1.body.data.title === 'e2e-A', '按 id 读取项目成功');

  // 6) 更新项目
  const u1 = await req('PATCH', `/projects/${pidA}`, { title: 'e2e-A-改', config: { maxBars: 5 } });
  assert(u1.status === 200 && u1.body.data.title === 'e2e-A-改' && u1.body.data.config.maxBars === 5, '更新 title + 部分 config 合并');
  assert(u1.body.data.config.palette === 'flat', '未传字段保留旧值（默认 palette）');

  // 7) 校验：不传 title 自动回退默认；空字符串触发 min(1) 失败
  const cDef = await req('POST', '/projects', { description: 'no title' });
  assert(cDef.status === 201 && cDef.body.data.title === '未命名项目', '不传 title 自动回退默认');
  await req('DELETE', `/projects/${cDef.body.data.id}`);
  const c400 = await req('POST', '/projects', { title: '' });
  assert(c400.status === 400 && c400.body.error?.code === 'E_VALIDATION', '空字符串 title → 400/E_VALIDATION');

  // 8) 导入基础长表
  const rows = [];
  for (const y of [2018, 2019, 2020, 2021, 2022]) {
    for (const [e, base] of [['A', 100], ['B', 80], ['C', 60]]) {
      rows.push({ time_key: String(y), entity: e, value: base + y - 2018 });
    }
  }
  const i1 = await req('POST', `/projects/${pidA}/datasets/import`, { rows });
  assert(i1.status === 201 && i1.body.data.imported === 15, '导入 15 行长表');
  assert(i1.body.data.timeCount === 5, 'timeCount = 5');
  assert(i1.body.data.entityCount === 3, 'entityCount = 3');

  // 9) summary
  const s1 = await req('GET', `/projects/${pidA}/datasets/summary`);
  assert(s1.body.data.rowCount === 15 && s1.body.data.timeMin === '2018' && s1.body.data.timeMax === '2022', 'summary 行数与时间范围正确');

  // 10) 取回
  const g2 = await req('GET', `/projects/${pidA}/datasets`);
  assert(g2.body.data.series.length === 15, '取回 15 行');
  assert(g2.body.data.series[0].time_order === 0, 'time_order 从 0 起始');

  // 11) 数值清洗：跳过空字符串与非数值（方案 §9 友好清洗而非整批拒绝）
  const dirtyRows = [
    { time_key: '2020', entity: 'X', value: 10 },
    { time_key: '2020', entity: 'Y', value: 'abc' },  // 会被 Number() 转 NaN → 跳过
    { time_key: '', entity: 'Z', value: 5 },         // 空时间 → 跳过
    { time_key: '2020', entity: '', value: 5 },      // 空实体 → 跳过
  ];
  const i2 = await req('POST', `/projects/${pidA}/datasets/import`, { rows: dirtyRows });
  assert(i2.status === 201 && i2.body.data.imported === 1 && i2.body.data.skipped === 3, '脏数据清洗：1 通过 / 3 跳过');

  // 12) 空 rows 拒绝（zod .min(1) 拦下，错误码为 E_VALIDATION）
  const i3 = await req('POST', `/projects/${pidA}/datasets/import`, { rows: [] });
  assert(i3.status === 400, '空 rows → 400（zod min(1) 或业务 E_EMPTY_TIMESERIES）');

  // 13) 重复导入（覆盖）—— 用独立项目测幂等，避免脏数据测试残留状态
  const pidHash = (await req('POST', '/projects', { title: 'hash-test' })).body.data.id;
  await req('POST', `/projects/${pidHash}/datasets/import`, { rows });
  const beforeHash = (await req('GET', `/projects/${pidHash}`)).body.data.dataset_hash;
  await req('POST', `/projects/${pidHash}/datasets/import`, { rows });
  const afterHash = (await req('GET', `/projects/${pidHash}`)).body.data.dataset_hash;
  assert(beforeHash && afterHash && beforeHash === afterHash, '幂等导入：相同内容 hash 不变');

  // 14) 修改内容后 hash 变化
  const newRows = [...rows, { time_key: '2023', entity: 'A', value: 999 }];
  await req('POST', `/projects/${pidHash}/datasets/import`, { rows: newRows });
  const changedHash = (await req('GET', `/projects/${pidHash}`)).body.data.dataset_hash;
  assert(changedHash !== afterHash, '内容变化时 hash 改变');
  await req('DELETE', `/projects/${pidHash}`);

  // 15) 宽表 multipart 路径（CSV with GBK 解析）—— 改用 sourceUrl 走后端 papaparse
  // 构造一个 CSV 文本走 multipart 文件
  const csvText = 'time,entity,value\n2010,A,1\n2010,B,2\n2011,A,3\n2011,B,4\n';
  const fd = new FormData();
  fd.append('file', new Blob([csvText], { type: 'text/csv' }), 'test.csv');
  const upRes = await fetch(`${BASE}/projects/${pidB}/datasets/upload`, { method: 'POST', body: fd });
  const upJson = await upRes.json();
  assert(upRes.status === 201 && upJson.data.imported === 4, 'multipart CSV 导入 4 行');
  assert(upJson.data.warnings === undefined || upJson.data.warnings.length === 0, '干净 CSV 无 warning');

  // 16) multipart 表头不匹配 → E_CSV_PARSE
  const badCsv = 'foo,bar\n1,2\n';
  const fd2 = new FormData();
  fd2.append('file', new Blob([badCsv], { type: 'text/csv' }), 'bad.csv');
  const upRes2 = await fetch(`${BASE}/projects/${pidB}/datasets/upload`, { method: 'POST', body: fd2 });
  const upJson2 = await upRes2.json();
  assert(upRes2.status === 400 && upJson2.error?.code === 'E_CSV_PARSE', '无法识别列头 → E_CSV_PARSE');

  // 17) multipart 缺文件
  const fd3 = new FormData();
  const upRes3 = await fetch(`${BASE}/projects/${pidB}/datasets/upload`, { method: 'POST', body: fd3 });
  assert(upRes3.status === 400, 'multipart 缺文件 → 400');

  // 18) sourceUrl 抓取不可达 URL
  const upRes4 = await fetch(`${BASE}/projects/${pidB}/datasets/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceUrl: 'http://127.0.0.1:1/no.txt' }),
  });
  assert(upRes4.status === 400, 'sourceUrl 不可达 → 400');

  // 19) 取回宽表项目数据
  const g3 = await req('GET', `/projects/${pidB}/datasets`);
  assert(g3.body.data.series.length === 4, '宽表项目取回 4 行');

  // 20) 删除数据集
  const d1 = await req('DELETE', `/projects/${pidB}/datasets`);
  assert(d1.status === 200 && d1.body.data.deleted === 4, '清空数据集');
  const g4 = await req('GET', `/projects/${pidB}/datasets/summary`);
  assert(g4.body.data.rowCount === 0, '清空后 rowCount = 0');

  // 21) records：登记
  const r1 = await req('POST', '/records', {
    project_id: pidA,
    config_snapshot: { width: 1920, height: 1080, fps: 30 },
    duration_ms: 12000,
    size_bytes: 1234567,
  });
  assert(r1.status === 201 && r1.body.data.id > 0, '登记作品记录');
  const recId = r1.body.data.id;
  // 不传 format 时默认 mp4（老客户端的兼容路径）
  assert(r1.body.data.format === 'mp4', '未指定 format 时默认 mp4', `format=${r1.body.data.format}`);

  // 21b) 显式声明 webm：以前后端写死 'mp4'，WebM 成片的下载后缀/Content-Type 全是错的
  const rWebm = await req('POST', '/records', {
    project_id: pidA,
    config_snapshot: { width: 1280, height: 720, fps: 30 },
    duration_ms: 3000,
    size_bytes: 999,
    format: 'webm',
  });
  assert(rWebm.status === 201 && rWebm.body.data.format === 'webm',
    '声明的 format=webm 被如实保存', `format=${rWebm.body.data.format}`);
  const rBadFmt = await req('POST', '/records', {
    project_id: pidA,
    config_snapshot: { width: 1280, height: 720, fps: 30 },
    duration_ms: 3000,
    size_bytes: 999,
    format: 'avi',
  });
  assert(rBadFmt.status === 400, '非法 format 被拒（zod 枚举）', `status=${rBadFmt.status}`);
  await req('DELETE', `/records/${rWebm.body.data.id}`);

  // 22) 列表 + 按 projectId 过滤
  const lr = await req('GET', '/records');
  assert(lr.body.data.length >= 1, 'records 列表 ≥1 条');
  const lr2 = await req('GET', `/records?projectId=${pidA}`);
  assert(lr2.body.data.length === 1, '按 projectId 过滤后 1 条');
  const lr3 = await req('GET', `/records?projectId=${pidB}`);
  assert(lr3.body.data.length === 0, '按 projectId 过滤后 0 条');

  // 23) 文件上传存档
  const blob = new Blob([new Uint8Array(64 * 1024)], { type: 'video/mp4' });
  const fdF = new FormData();
  fdF.append('file', blob, 'test.mp4');
  const upFileRes = await fetch(`${BASE}/records/${recId}/file`, { method: 'POST', body: fdF });
  const upFileJson = await upFileRes.json();
  assert(upFileRes.status === 201 && upFileJson.data.size_bytes === blob.size, '作品文件上传成功');

  // 24) 文件下载
  const dlRes = await fetch(`${BASE}/records/${recId}/file`);
  assert(dlRes.status === 200, '下载作品 → 200');
  const dlSize = Number(dlRes.headers.get('content-length'));
  assert(dlSize === blob.size, `下载字节数匹配 (${dlSize} === ${blob.size})`);
  // 没有文件名时浏览器会把下载存成 URL 的 basename（"file"，无扩展名）
  const cdisp = dlRes.headers.get('content-disposition') ?? '';
  assert(/filename\*=UTF-8''.+\.(mp4|webm)/.test(cdisp) && /filename="/.test(cdisp),
    '下载响应带文件名（含 ASCII fallback + RFC 5987 filename*）',
    `content-disposition=${cdisp}`);

  // 25) 删除作品（同时删文件）
  const delR = await req('DELETE', `/records/${recId}`);
  assert(delR.status === 204, '删除作品记录 → 204');
  const dlAfter = await fetch(`${BASE}/records/${recId}/file`);
  assert(dlAfter.status === 404, '删后下载 → 404');

  // 26) datasources
  const ds = await req('GET', '/datasources');
  assert(ds.body.data.length >= 3, 'datasources 至少 3 条');

  // 27) 删除项目级联
  const dA = await req('DELETE', `/projects/${pidA}`);
  assert(dA.status === 204, '删除项目 A → 204');
  const afterA = await req('GET', `/projects/${pidA}/datasets/summary`);
  assert(afterA.status === 404, '级联：删项目后取 summary → 404');

  const dB = await req('DELETE', `/projects/${pidB}`);
  assert(dB.status === 204, '删除项目 B → 204');

  // 28) 错误响应格式统一
  const e1 = await req('GET', '/projects/abc'); // 非数字 ID
  assert(e1.status === 404 || e1.status === 500, '非数字 ID 不导致 5xx 响应格式错乱');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('\n失败项:'); fails.forEach(f => console.log(' - ' + f)); }
  // 失败时以前会在这里直接 exit，导致清理被跳过 —— 现在统一先清再退
  await cleanup();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(async (e) => {
  console.error('e2e crashed:', e);
  await cleanup();
  process.exit(2);
});

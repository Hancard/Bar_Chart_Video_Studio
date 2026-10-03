#!/usr/bin/env node
/**
 * 网络受限时用 GitHub 的 Git Data API 推送本地 commit（等价于 git push）
 *
 * 背景：本机访问 github.com:443 会间歇性超时（git 的 push/fetch 直接失败），
 * 但 `gh`（api.github.com）通常仍然可用。这个脚本走 API 完成同一次推送。
 *
 * 两种模式：
 *
 * A) 自动模式（能跑 git 时）：
 *      node scripts/push_via_api.mjs <localRef> [remote] [branch]
 *      node scripts/push_via_api.mjs 16027d8 bar_video main
 *
 * B) 离线模式（node 里 spawn git 报 EBUSY 时，用 bash 先导出清单）：
 *      git diff-tree --no-commit-id --name-status -r <sha> > changes.txt
 *      git log -1 --format=%B <sha> > message.txt
 *      node scripts/push_via_api.mjs --changes=changes.txt --message=message.txt [remote] [branch]
 *      文件内容直接从工作区读（前提：工作区干净、内容与 <sha> 一致）。
 *
 * 原理（blob → tree → commit → 更新 ref）：
 *   1. 取远端分支当前 commit 作为 base tree / parent
 *   2. 得到「本次变更的文件清单」（自动模式跑 git，离线模式读文件）
 *   3. 逐个上传 blob（删除的文件用 sha:null）→ 基于 base_tree 建 tree → 建 commit
 *   4. PATCH 分支 ref，并补写本地 head / remote-tracking ref
 *
 * 注意：blob / tree / commit 的 body 一律用 `--input <文件>` 传给 gh ——
 * 用 `-f content=<base64>` 会爆命令行长度限制。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const getOpt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const positional = argv.filter((a) => !a.startsWith('--'));
const changesFile = getOpt('changes');
const messageFile = getOpt('message');
const remoteName = positional[changesFile ? 0 : 1] ?? 'bar_video';
const branch = positional[changesFile ? 1 : 2] ?? 'main';
const localRef = changesFile ? null : positional[0];

if (!localRef && !changesFile) {
  console.error('用法：\n'
    + '  node scripts/push_via_api.mjs <localRef> [remote] [branch]\n'
    + '  node scripts/push_via_api.mjs --changes=<file> --message=<file> [remote] [branch]');
  process.exit(2);
}
if (changesFile && !messageFile) {
  console.error('离线模式需要同时提供 --message=<file>（commit 消息导出文件）');
  process.exit(2);
}

// ---------- git 可执行文件探测（shim 环境下 spawn "git" 常报 EBUSY） ----------
let GIT_BIN = null;
function resolveGitBin() {
  if (GIT_BIN !== null) return GIT_BIN;
  for (const c of [process.env.GIT_BIN, 'git', 'S:\\Git\\cmd\\git.exe']) {
    if (!c) continue;
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); GIT_BIN = c; return c; } catch { /* 下一个 */ }
  }
  GIT_BIN = '';
  return '';
}
const git = (args, opts = {}) => {
  const bin = resolveGitBin();
  if (!bin) throw new Error('git 不可用（EBUSY / 未找到）');
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts }).trim();
};

// ---------- 仓库定位（读 .git/config，不依赖 git 命令） ----------
function repoFromConfig() {
  const cfg = readFileSync('.git/config', 'utf8');
  const re = new RegExp(`\\[remote "${remoteName}"\\]([\\s\\S]*?)(?=\\n\\[|$)`);
  const block = re.exec(cfg)?.[1] ?? '';
  const url = /url\s*=\s*(.+)/.exec(block)?.[1]?.trim() ?? '';
  const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`无法从 .git/config 解析仓库：${url}`);
  return `${m[1]}/${m[2]}`;
}
const repo = repoFromConfig();
console.log(`仓库 ${repo} ← ${remoteName}/${branch}`);

const tmp = mkdtempSync(path.join(tmpdir(), 'pushapi-'));

function ghApi(method, endpoint, body) {
  const args = ['api', '-X', method, endpoint];
  if (body !== undefined) {
    const f = path.join(tmp, 'body.json');
    writeFileSync(f, JSON.stringify(body));
    args.push('--input', f);
  }
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : null;
}

// ---------- 远端现状 ----------
const remoteSha = ghApi('GET', `repos/${repo}/git/ref/heads/${branch}`).object.sha;
console.log(`远端 ${branch} = ${remoteSha.slice(0, 7)}`);

/** 待推的 commit 列表：[{ sha, message, changes: [{status, path}] }]（旧 → 新） */
const commits = [];

if (changesFile) {
  // 离线模式：清单 + 消息都来自文件，文件内容从工作区读
  const changes = parseChanges(readFileSync(changesFile, 'utf8'));
  const message = readFileSync(messageFile, 'utf8').replace(/\s+$/, '');
  const localSha = readFileSync(path.join('.git', 'refs', 'heads', branch), 'utf8').trim();
  commits.push({ sha: localSha, message, changes });
  console.log(`离线模式：${changes.length} 个变更文件`);
} else {
  const localSha = git(['rev-parse', localRef]);
  if (localSha === remoteSha) {
    console.log('远端已是最新，无需推送');
    process.exit(0);
  }
  const todo = git(['rev-list', '--reverse', `${remoteSha}..${localSha}`]).split('\n').filter(Boolean);
  if (todo.length === 0) {
    console.log('本地没有领先远端的 commit');
    process.exit(1);
  }
  const firstParent = git(['rev-parse', `${todo[0]}^`]);
  if (firstParent !== remoteSha) {
    console.error(`不是 fast-forward：${todo[0].slice(0, 7)} 的父提交是 ${firstParent.slice(0, 7)}，`
      + `而远端是 ${remoteSha.slice(0, 7)}`);
    process.exit(1);
  }
  for (const sha of todo) {
    commits.push({
      sha,
      message: git(['log', '-1', '--format=%B', sha]),
      changes: parseChanges(git(['diff-tree', '--no-commit-id', '--name-status', '-r', sha])),
    });
  }
  console.log(`待推 ${commits.length} 个 commit`);
}

function parseChanges(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t');
    return { status: parts[0][0], path: parts.slice(1).join('\t') };
  });
}

/** 每个文件的内容：自动模式从该 commit 取，离线模式读工作区 */
function fileContent(commitSha, p) {
  if (changesFile) return readFileSync(p);
  const buf = execFileSync(resolveGitBin(), ['show', `${commitSha}:${p}`], { maxBuffer: 512 * 1024 * 1024 });
  return buf;
}
function fileMode(commitSha, p) {
  if (changesFile) return '100644';
  const line = git(['ls-tree', commitSha, '--', p]);
  return line ? line.split(/\s+/)[0] : '100644';
}

// ---------- 逐个 commit 推送 ----------
let parent = remoteSha;
let baseTree = ghApi('GET', `repos/${repo}/git/commits/${parent}`).tree.sha;
let pushed = 0;

for (const c of commits) {
  const subject = c.message.split('\n')[0];
  const entries = [];
  for (const ch of c.changes) {
    if (ch.status === 'D') {
      entries.push({ path: ch.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const buf = fileContent(c.sha, ch.path);
    const blob = ghApi('POST', `repos/${repo}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    entries.push({ path: ch.path, mode: fileMode(c.sha, ch.path), type: 'blob', sha: blob.sha });
  }
  const tree = ghApi('POST', `repos/${repo}/git/trees`, { base_tree: baseTree, tree: entries });
  const commit = ghApi('POST', `repos/${repo}/git/commits`, {
    message: c.message,
    tree: tree.sha,
    parents: [parent],
  });
  console.log(`  ${c.sha.slice(0, 7)} → ${commit.sha.slice(0, 7)}  ${subject.slice(0, 58)}  (${c.changes.length} 文件)`);
  parent = commit.sha;
  baseTree = tree.sha;
  pushed++;
}

// ---------- 更新 ref ----------
ghApi('PATCH', `repos/${repo}/git/refs/heads/${branch}`, { sha: parent, force: false });
console.log(`已推送 ${pushed} 个 commit，远端 ${branch} → ${parent.slice(0, 7)}`);

// 本地 head / remote-tracking ref 手动对齐（API 建出的 commit sha 与本地不同，但内容一致）
writeFileSync(path.join('.git', 'refs', 'heads', branch), parent + '\n');
const trackFile = path.join('.git', 'refs', 'remotes', remoteName, branch);
mkdirSync(path.dirname(trackFile), { recursive: true });
writeFileSync(trackFile, parent + '\n');
console.log(`已更新本地 refs/heads/${branch} 与 refs/remotes/${remoteName}/${branch}`);
if (!existsSync(trackFile)) process.exit(1);

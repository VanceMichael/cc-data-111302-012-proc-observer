import {readdir, readFile as defaultReadFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseStat, parseStatus, parseCmdline, parseIo, parseCgroupFile} from './proc-parse.mjs';

export const PROC_FILES = ['stat', 'status', 'cmdline', 'io', 'cgroup'];
export const COUNTERS = ['utime', 'stime', 'readBytes', 'writeBytes'];
const MAX_CGROUP_DEPTH = 8;

/** 把读取错误归类为可区分的完整度原因。 */
export function classifyReadError(error) {
  const code = error?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'vanished';
  if (code === 'EACCES' || code === 'EPERM') return 'denied';
  return 'error';
}

/** 限制同时打开的文件数的门闩。 */
function createGate(limit) {
  let active = 0;
  const waiting = [];
  return async function acquire() {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve));
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    };
  };
}

/**
 * 对配置的 proc/cgroup 树做一次只读采样，产出一份进程快照。
 *
 * 观察身份：每个进程的 identity 是 {bootId, pid, startTime} 三元组，
 * 三者共同决定"是不是同一个观察对象"，单独一个 pid 不作数。
 *
 * 完整度：每个文件的读取结果分为 ok / vanished / denied / invalid / error，
 * 进程级 completeness 为 complete 或 partial；读取之间文件消失是常态，不算失败。
 *
 * 资源约束：同时打开的文件数不超过 maxOpen；总耗时预算 budgetMs 用完后，
 * 未开始的对象记入 incomplete（原因 budget-exceeded），而不是悄悄丢弃。
 *
 * 可注入 readFile 以便测试模拟慢速或拒绝的读取。
 */
export async function sampleTree({procRoot, cgroupRoot = null, budgetMs = 1000, maxOpen = 16, readFile = defaultReadFile} = {}) {
  if (!procRoot) throw new Error('sampleTree 需要 procRoot');
  const startedAt = Date.now();
  const acquire = createGate(Math.max(1, maxOpen));
  const incomplete = [];
  const expired = () => Date.now() - startedAt >= budgetMs;

  async function readGuarded(path) {
    const release = await acquire();
    try {
      return await readFile(path);
    } finally {
      release();
    }
  }

  // 内核启动身份：整棵树的观察都挂在它下面。
  let bootId = null;
  let boot = 'ok';
  try {
    bootId = (await readGuarded(join(procRoot, 'sys', 'kernel', 'random', 'boot_id'))).toString('utf8').trim();
  } catch (error) {
    boot = classifyReadError(error);
  }

  // 发现进程目录。
  let pids = [];
  try {
    pids = (await readdir(procRoot)).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b);
  } catch (error) {
    incomplete.push({kind: 'proc-tree', reason: classifyReadError(error)});
  }

  async function sampleProcess(pid) {
    const dir = join(procRoot, String(pid));
    const files = {};
    const raw = {};
    await Promise.all(PROC_FILES.map(async name => {
      try {
        raw[name] = await readGuarded(join(dir, name));
        files[name] = 'ok';
      } catch (error) {
        files[name] = classifyReadError(error);
      }
    }));
    const record = {pid, source: dir, files, identity: null, counters: {}};
    let stat = null;
    if (files.stat === 'ok') {
      try {
        stat = parseStat(raw.stat.toString('utf8'));
      } catch {
        files.stat = 'invalid';
      }
    }
    if (stat) {
      record.name = stat.name;
      record.state = stat.state;
      record.counters.utime = stat.utime;
      record.counters.stime = stat.stime;
      if (bootId) record.identity = {bootId, pid, startTime: stat.startTime};
    }
    if (files.status === 'ok') {
      try {
        const status = parseStatus(raw.status.toString('utf8'));
        if (status.nspid?.length) record.nspid = {values: status.nspid, source: join(dir, 'status')};
      } catch {
        files.status = 'invalid';
      }
    }
    if (files.cmdline === 'ok') {
      try {
        record.cmdline = parseCmdline(raw.cmdline);
      } catch {
        files.cmdline = 'invalid';
      }
    }
    if (files.io === 'ok') {
      try {
        Object.assign(record.counters, parseIo(raw.io.toString('utf8')));
      } catch {
        files.io = 'invalid';
      }
    }
    if (files.cgroup === 'ok') {
      try {
        record.cgroup = {path: parseCgroupFile(raw.cgroup.toString('utf8')), source: join(dir, 'cgroup')};
      } catch {
        files.cgroup = 'invalid';
      }
    }
    record.missing = PROC_FILES.filter(name => files[name] !== 'ok');
    record.completeness = record.missing.length === 0 ? 'complete' : 'partial';
    return record;
  }

  // 进程级工作池：进程内并发读各文件，进程间按 maxOpen 折算的并发度推进，
  // 门闩保证任意时刻打开的文件数不超过 maxOpen。
  const processes = {};
  const concurrency = Math.max(1, Math.min(64, Math.floor(maxOpen / PROC_FILES.length)));
  let cursor = 0;
  async function worker() {
    while (cursor < pids.length) {
      const pid = pids[cursor];
      cursor += 1;
      if (expired()) {
        incomplete.push({kind: 'process', pid, reason: 'budget-exceeded'});
        continue;
      }
      processes[pid] = await sampleProcess(pid);
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, Math.max(1, pids.length))}, () => worker()));

  // cgroup 树成员归属；每条记录保留来源路径，树路径本身不是业务作业身份。
  const groups = {};
  async function scanGroups(relative, depth) {
    if (!cgroupRoot || depth > MAX_CGROUP_DEPTH) return;
    let entries;
    try {
      entries = await readdir(join(cgroupRoot, relative || ''), {withFileTypes: true});
    } catch (error) {
      incomplete.push({kind: 'group', path: relative || '/', reason: classifyReadError(error)});
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = `${relative}/${entry.name}`;
      if (expired()) {
        incomplete.push({kind: 'group', path: child, reason: 'budget-exceeded'});
        continue;
      }
      const procsPath = join(cgroupRoot, child, 'cgroup.procs');
      try {
        const text = (await readGuarded(procsPath)).toString('utf8');
        groups[child] = {status: 'ok', members: text.split('\n').map(part => part.trim()).filter(Boolean).map(Number), source: procsPath};
      } catch (error) {
        groups[child] = {status: classifyReadError(error), members: [], source: procsPath};
      }
      await scanGroups(child, depth + 1);
    }
  }
  await scanGroups('', 0);

  // 进程自报归属与组树成员列表交叉校验：不一致即"采样中迁组"的证据。
  for (const record of Object.values(processes)) {
    const path = record.cgroup?.path;
    if (!path) {
      record.membership = 'unknown';
      continue;
    }
    const group = groups[path];
    if (!group) {
      record.membership = 'stale';
      continue;
    }
    if (group.status !== 'ok') {
      record.membership = 'unknown';
      continue;
    }
    record.membership = group.members.includes(record.pid) ? 'consistent' : 'mismatch';
  }

  return {
    meta: {
      version: 1,
      bootId,
      boot,
      roots: {proc: procRoot, cgroup: cgroupRoot},
      startedAt,
      durationMs: Date.now() - startedAt,
      budgetMs,
      maxOpen,
      timedOut: incomplete.some(item => item.reason === 'budget-exceeded'),
      discovered: pids.length,
      completed: Object.keys(processes).length,
    },
    processes,
    groups,
    incomplete,
  };
}

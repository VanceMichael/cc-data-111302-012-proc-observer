import {COUNTERS} from './sampler.mjs';

/**
 * 对相邻两份快照做对齐与计数增量裁决。
 *
 * 裁决原则：无法对齐的两次观察不硬算负数、不补零，而是给出机器可读的原因。
 * - boot_id 不同（系统重启）或缺失：整体不可对齐，不产出任何进程增量。
 * - pid 相同但 startTime 不同：PID 已被复用，是另一个观察对象，增量拒绝。
 * - 任一侧读取不全：incomplete，增量不可用，列出缺了哪些文件。
 * - 计数回退：该计数器标记 reset，给出前后值但不给增量；其余计数器照常。
 * - cgroup 迁移：进程级计数增量仍有效（计数器属于进程本身），
 *   但必须带 cgroup-moved 标记 标注，按组记账的使用方不应直接入账。
 */
export function diffSnapshots(prev, next) {
  const result = {
    aligned: false,
    reason: null,
    boot: {previous: prev?.meta?.bootId ?? null, current: next?.meta?.bootId ?? null},
    processes: {},
    groups: {},
  };
  if (!prev?.meta || !next?.meta) {
    result.reason = 'snapshot-missing';
    return result;
  }
  if (!prev.meta.bootId || !next.meta.bootId) {
    result.reason = 'boot-unknown';
    return result;
  }
  if (prev.meta.bootId !== next.meta.bootId) {
    result.reason = 'boot-changed';
    return result;
  }
  result.aligned = true;

  const pids = [...new Set([...Object.keys(prev.processes ?? {}), ...Object.keys(next.processes ?? {})])]
    .map(Number)
    .sort((a, b) => a - b);
  for (const pid of pids) {
    result.processes[pid] = diffProcess(prev.processes[pid], next.processes[pid]);
  }

  const paths = [...new Set([...Object.keys(prev.groups ?? {}), ...Object.keys(next.groups ?? {})])].sort();
  for (const path of paths) {
    const before = prev.groups[path];
    const after = next.groups[path];
    if (before && !after) {
      result.groups[path] = {status: 'removed', members: before.members};
    } else if (!before && after) {
      result.groups[path] = {status: 'added', members: after.members};
    } else {
      const beforeMembers = new Set(before.members);
      const afterMembers = new Set(after.members);
      result.groups[path] = {
        status: 'ok',
        joined: [...afterMembers].filter(pid => !beforeMembers.has(pid)),
        left: [...beforeMembers].filter(pid => !afterMembers.has(pid)),
      };
    }
  }
  return result;
}

function diffProcess(prev, next) {
  if (prev && !next) return {status: 'vanished', identity: prev.identity ?? null, deltas: null};
  if (!prev && next) return {status: 'appeared', identity: next.identity ?? null, deltas: null};
  if (!prev.identity || !next.identity) {
    return {
      status: 'not-aligned',
      reason: 'identity-missing',
      detail: {previousReadable: Boolean(prev.identity), currentReadable: Boolean(next.identity)},
      deltas: null,
    };
  }
  if (prev.identity.bootId !== next.identity.bootId || prev.identity.startTime !== next.identity.startTime) {
    return {
      status: 'pid-reused',
      reason: 'identity-changed',
      previous: prev.identity,
      current: next.identity,
      deltas: null,
    };
  }
  const entry = {status: 'ok', identity: next.identity, flags: []};
  if (prev.cgroup?.path !== next.cgroup?.path) {
    entry.flags.push('cgroup-moved');
    entry.cgroup = {from: prev.cgroup?.path ?? null, to: next.cgroup?.path ?? null};
  }
  if (prev.completeness !== 'complete' || next.completeness !== 'complete') {
    entry.status = 'incomplete';
    entry.deltas = null;
    entry.missing = {previous: prev.missing ?? [], current: next.missing ?? []};
    return entry;
  }
  entry.deltas = {};
  for (const key of COUNTERS) {
    const before = prev.counters?.[key];
    const after = next.counters?.[key];
    if (typeof before !== 'number' || typeof after !== 'number') {
      entry.deltas[key] = {status: 'unavailable'};
      entry.flags.push('counter-missing');
      continue;
    }
    if (after < before) {
      entry.deltas[key] = {status: 'reset', previous: before, current: after};
      entry.flags.push('counter-reset');
      continue;
    }
    entry.deltas[key] = {status: 'ok', value: after - before};
  }
  if (entry.flags.includes('counter-reset')) entry.status = 'counter-reset';
  else if (entry.flags.includes('cgroup-moved')) entry.status = 'cgroup-moved';
  else if (entry.flags.includes('counter-missing')) entry.status = 'counter-missing';
  return entry;
}

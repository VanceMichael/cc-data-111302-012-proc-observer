import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdir, rm, writeFile, readFile as fsRead} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createSource} from '../src/source.mjs';
import {sampleTree} from '../src/sampler.mjs';
import {diffSnapshots} from '../src/diff.mjs';
import {parseStat} from '../src/proc-parse.mjs';

async function withSource(callback) {
  const source = await createSource();
  try {
    return await callback(source);
  } finally {
    await source.close();
  }
}

function rootsOf(source) {
  const root = source.state.treeRoot;
  return {procRoot: join(root, 'proc'), cgroupRoot: join(root, 'cgroup')};
}

async function control(source, body) {
  const response = await fetch(source.url + '/control', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  assert.equal(response.status, 200);
}

async function addProcess(roots, pid, fromPid = 41) {
  await mkdir(join(roots.procRoot, String(pid)), {recursive: true});
  for (const name of ['stat', 'status', 'cmdline', 'io', 'cgroup']) {
    await writeFile(join(roots.procRoot, String(pid), name), await fsRead(join(roots.procRoot, String(fromPid), name)));
  }
}

test('stat 解析容忍含空格与括号的进程名', () => {
  const fields = Array(30).fill('0');
  fields[0] = 'S';
  fields[11] = '34';
  fields[12] = '21';
  fields[19] = '877';
  const parsed = parseStat(`123 (weird ) name) ${fields.join(' ')}\n`);
  assert.equal(parsed.pid, 123);
  assert.equal(parsed.name, 'weird ) name');
  assert.equal(parsed.state, 'S');
  assert.equal(parsed.utime, 34);
  assert.equal(parsed.stime, 21);
  assert.equal(parsed.startTime, 877);
  assert.throws(() => parseStat('not a stat line'), /括号/);
});

test('单次采样建立完整观察身份并保留来源', () => withSource(async source => {
  const roots = rootsOf(source);
  const snap = await sampleTree(roots);
  assert.equal(snap.meta.bootId, 'boot-1');
  assert.equal(snap.meta.timedOut, false);
  assert.deepEqual(snap.incomplete, []);
  const record = snap.processes[41];
  assert.deepEqual(record.identity, {bootId: 'boot-1', pid: 41, startTime: 500});
  assert.equal(record.name, 'worker (phase one)');
  assert.deepEqual(record.cmdline, ['worker', '--once']);
  assert.deepEqual(record.nspid.values, [41, 2]);
  assert.ok(record.nspid.source.startsWith(roots.procRoot));
  assert.equal(record.cgroup.path, '/team-a');
  assert.ok(record.cgroup.source.startsWith(roots.procRoot));
  assert.deepEqual(record.counters, {utime: 12, stime: 8, readBytes: 100, writeBytes: 20});
  assert.equal(record.completeness, 'complete');
  assert.equal(record.membership, 'consistent');
  assert.deepEqual(snap.groups['/team-a'].members, [41]);
  assert.ok(snap.groups['/team-a'].source.startsWith(roots.cgroupRoot));
}));

test('相邻快照给出有效计数增量', () => withSource(async source => {
  const roots = rootsOf(source);
  const before = await sampleTree(roots);
  await control(source, {reads: 175});
  const after = await sampleTree(roots);
  const diff = diffSnapshots(before, after);
  assert.equal(diff.aligned, true);
  const entry = diff.processes[41];
  assert.equal(entry.status, 'ok');
  assert.deepEqual(entry.deltas.readBytes, {status: 'ok', value: 75});
  assert.deepEqual(entry.deltas.utime, {status: 'ok', value: 0});
}));

test('退出后 PID 复用：增量被拒绝而不是记到旧进程头上', () => withSource(async source => {
  const roots = rootsOf(source);
  const before = await sampleTree(roots);
  await control(source, {remove: true});
  const gone = await sampleTree(roots);
  await control(source, {remove: false, start: 900});
  const reused = await sampleTree(roots);

  const vanished = diffSnapshots(before, gone);
  assert.equal(vanished.processes[41].status, 'vanished');
  assert.equal(vanished.processes[41].deltas, null);

  const appeared = diffSnapshots(gone, reused);
  assert.equal(appeared.processes[41].status, 'appeared');

  const diff = diffSnapshots(before, reused);
  const entry = diff.processes[41];
  assert.equal(entry.status, 'pid-reused');
  assert.equal(entry.deltas, null);
  assert.equal(entry.previous.startTime, 500);
  assert.equal(entry.current.startTime, 900);
  assert.equal(entry.previous.bootId, entry.current.bootId);
}));

test('计数回退不算负数也不补零', () => withSource(async source => {
  const roots = rootsOf(source);
  const before = await sampleTree(roots);
  await control(source, {reads: 40});
  const after = await sampleTree(roots);
  const entry = diffSnapshots(before, after).processes[41];
  assert.equal(entry.status, 'counter-reset');
  assert.deepEqual(entry.deltas.readBytes, {status: 'reset', previous: 100, current: 40});
  assert.deepEqual(entry.deltas.utime, {status: 'ok', value: 0});
}));

test('采样间迁组：进程增量标注归属变化，组级账本可见迁移', () => withSource(async source => {
  const roots = rootsOf(source);
  const before = await sampleTree(roots);
  await control(source, {group: 'team-b'});
  const after = await sampleTree(roots);
  const diff = diffSnapshots(before, after);
  const entry = diff.processes[41];
  assert.ok(entry.flags.includes('cgroup-moved'));
  assert.deepEqual(entry.cgroup, {from: '/team-a', to: '/team-b'});
  assert.deepEqual(entry.deltas.readBytes, {status: 'ok', value: 0});
  assert.equal(diff.groups['/team-a'].status, 'removed');
  assert.equal(diff.groups['/team-b'].status, 'added');
  assert.deepEqual(diff.groups['/team-b'].members, [41]);
}));

test('采样中迁组：自报归属与组树成员列表不一致被检出', () => withSource(async source => {
  const roots = rootsOf(source);
  await control(source, {group: 'team-b'});
  // 模拟迁组进行到一半：进程已自报 /team-b，但成员列表还没写上它。
  await writeFile(join(roots.cgroupRoot, 'team-b', 'cgroup.procs'), '');
  const mismatch = await sampleTree(roots);
  assert.equal(mismatch.processes[41].cgroup.path, '/team-b');
  assert.equal(mismatch.processes[41].membership, 'mismatch');
  // 组目录整体消失：自报归属已失效。
  await rm(join(roots.cgroupRoot, 'team-b'), {recursive: true, force: true});
  const stale = await sampleTree(roots);
  assert.equal(stale.processes[41].membership, 'stale');
}));

test('系统重启：两次观察整体不可对齐', () => withSource(async source => {
  const roots = rootsOf(source);
  const before = await sampleTree(roots);
  await control(source, {generation: 2});
  const after = await sampleTree(roots);
  assert.equal(after.meta.bootId, 'boot-2');
  const diff = diffSnapshots(before, after);
  assert.equal(diff.aligned, false);
  assert.equal(diff.reason, 'boot-changed');
  assert.deepEqual(diff.processes, {});
}));

test('读取之间文件消失与权限不足可区分，且增量不可用', () => withSource(async source => {
  const roots = rootsOf(source);
  const before = await sampleTree(roots);
  await rm(join(roots.procRoot, '41', 'io'));
  const partial = await sampleTree(roots);
  assert.equal(partial.processes[41].files.io, 'vanished');
  assert.equal(partial.processes[41].completeness, 'partial');
  const diff = diffSnapshots(before, partial);
  assert.equal(diff.processes[41].status, 'incomplete');
  assert.equal(diff.processes[41].deltas, null);
  assert.ok(diff.processes[41].missing.current.includes('io'));

  const deniedRead = async path => {
    if (path.endsWith('/io')) {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return fsRead(path);
  };
  const denied = await sampleTree({...roots, readFile: deniedRead});
  assert.equal(denied.processes[41].files.io, 'denied');
  assert.equal(denied.processes[41].completeness, 'partial');
}));

test('坏 stat 数据：无身份，两次观察不可对齐', () => withSource(async source => {
  const roots = rootsOf(source);
  const before = await sampleTree(roots);
  await writeFile(join(roots.procRoot, '41', 'stat'), 'not a stat line');
  const corrupt = await sampleTree(roots);
  assert.equal(corrupt.processes[41].files.stat, 'invalid');
  assert.equal(corrupt.processes[41].identity, null);
  const diff = diffSnapshots(before, corrupt);
  assert.equal(diff.processes[41].status, 'not-aligned');
  assert.equal(diff.processes[41].deltas, null);
}));

test('boot_id 不可读：快照降级且不可对齐', () => withSource(async source => {
  const roots = rootsOf(source);
  const noBoot = async path => {
    if (path.endsWith('boot_id')) {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return fsRead(path);
  };
  const degraded = await sampleTree({...roots, readFile: noBoot});
  assert.equal(degraded.meta.boot, 'denied');
  assert.equal(degraded.meta.bootId, null);
  assert.equal(degraded.processes[41].identity, null);
  const normal = await sampleTree(roots);
  const diff = diffSnapshots(degraded, normal);
  assert.equal(diff.aligned, false);
  assert.equal(diff.reason, 'boot-unknown');
}));

test('新进程出现与组成员变化可区分', () => withSource(async source => {
  const roots = rootsOf(source);
  const before = await sampleTree(roots);
  await addProcess(roots, 1007);
  await writeFile(join(roots.cgroupRoot, 'team-a', 'cgroup.procs'), '41\n1007\n');
  const after = await sampleTree(roots);
  const diff = diffSnapshots(before, after);
  assert.equal(diff.processes['1007'].status, 'appeared');
  assert.deepEqual(diff.groups['/team-a'].joined, [1007]);
  assert.deepEqual(diff.groups['/team-a'].left, []);
  assert.equal(after.processes['1007'].membership, 'consistent');
}));

test('采样耗时超预算后交代未完成对象', () => withSource(async source => {
  const roots = rootsOf(source);
  for (const pid of [1001, 1002, 1003]) await addProcess(roots, pid);
  const slow = async path => {
    if (/\/proc\/\d+\//.test(path)) await delay(50);
    return fsRead(path);
  };
  const snap = await sampleTree({...roots, readFile: slow, budgetMs: 55, maxOpen: 8});
  assert.equal(snap.meta.discovered, 4);
  assert.equal(snap.meta.timedOut, true);
  assert.ok(snap.meta.completed >= 1, `完成数 ${snap.meta.completed}`);
  const timedOut = snap.incomplete.filter(item => item.kind === 'process' && item.reason === 'budget-exceeded');
  assert.ok(timedOut.length >= 1, '应有未完成的进程');
  assert.equal(snap.meta.completed + timedOut.length, 4);
  for (const item of timedOut) assert.ok(item.pid > 0);
}));

test('同时打开的文件数不超过上限', () => withSource(async source => {
  const roots = rootsOf(source);
  for (const pid of [1001, 1002, 1003]) await addProcess(roots, pid);
  let active = 0;
  let peak = 0;
  const counting = async path => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      await delay(5);
      return await fsRead(path);
    } finally {
      active -= 1;
    }
  };
  const snap = await sampleTree({...roots, readFile: counting, maxOpen: 3});
  assert.equal(snap.meta.completed, 4);
  assert.ok(peak <= 3, `并发峰值 ${peak} 超过上限`);
  assert.ok(peak >= 2, `并发峰值 ${peak} 过低，门闩未生效`);
}));

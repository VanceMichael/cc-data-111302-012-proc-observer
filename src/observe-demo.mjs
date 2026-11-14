import {join} from 'node:path';
import {createSource} from './source.mjs';
import {sampleTree} from './sampler.mjs';
import {diffSnapshots} from './diff.mjs';

// 演示：在合成来源上连续采样，展示观察身份如何挡住"短作业累计几百小时"，
// 以及各类增量为何被接受或拒绝。只读采集，不做任何进程控制。
const source = await createSource();
try {
  const root = source.state.treeRoot;
  const roots = {procRoot: join(root, 'proc'), cgroupRoot: join(root, 'cgroup')};
  async function control(body) {
    const response = await fetch(source.url + '/control', {method: 'POST', body: JSON.stringify(body)});
    if (!response.ok) throw new Error(`控制失败: ${response.status}`);
  }
  const snap = () => sampleTree(roots);

  console.log('=== 只读进程观察演示：观察身份、完整度与增量裁决 ===');
  console.log(`来源树: ${root}`);

  const A = await snap();
  const a41 = A.processes[41];
  console.log('\n[1] 基线快照');
  console.log(`    boot=${A.meta.bootId} 完成=${A.meta.completed}/${A.meta.discovered} 耗时=${A.meta.durationMs}ms`);
  console.log(`    pid=41 身份=(boot=${a41.identity.bootId}, pid=41, start=${a41.identity.startTime})`);
  console.log(`    名称="${a41.name}" NSpid=${a41.nspid.values.join('→')} 组=${a41.cgroup.path} 归属校验=${a41.membership}`);
  console.log(`    计数=${JSON.stringify(a41.counters)}`);

  // 场景一：进程退出后 PID 被复用。旧脚本只认 PID，会把新进程记到已退出作业头上。
  await control({remove: true});
  await control({remove: false, start: 900});
  const B = await snap();
  const reused = diffSnapshots(A, B);
  const naiveTicks = B.processes[41].identity.startTime - A.processes[41].identity.startTime + B.processes[41].counters.utime;
  console.log('\n[2] 进程退出后 PID 41 被复用（startTime 500→900）');
  console.log(`    旧脚本（只认 PID）: 认为同一进程还在，已运行约 ${naiveTicks} tick；`);
  console.log('    复用每发生一次就虚增一段，长期累积就是"短作业运行几百小时"的记录。');
  console.log(`    本采集器: 增量被拒绝 ← ${JSON.stringify(reused.processes[41])}`);
  console.log('    拒绝原因: bootId+pid+startTime 三元组对不上，两次观察的不是同一个对象，不能硬算增量。');

  // 场景二：正常推进，增量被接受。
  await control({reads: 160});
  const C = await snap();
  const ok = diffSnapshots(B, C);
  console.log('\n[3] 正常推进（read_bytes 100→160）');
  console.log(`    增量被接受: ${JSON.stringify(ok.processes[41].deltas)}`);

  // 场景三：计数回退，只拒绝回退的那一项，其余照常。
  await control({reads: 40});
  const D = await snap();
  const reset = diffSnapshots(C, D);
  console.log('\n[4] 计数回退（read_bytes 160→40）');
  console.log(`    该计数器增量被拒绝（不算负数、不补零）: ${JSON.stringify(reset.processes[41].deltas.readBytes)}`);
  console.log(`    其余计数器照常: utime=${JSON.stringify(ok.processes[41].deltas.utime)} 进程状态=${reset.processes[41].status}`);

  // 场景四：两次观察之间迁组。
  await control({group: 'team-b'});
  const E = await snap();
  const moved = diffSnapshots(D, E);
  console.log('\n[5] 采样间迁组（/team-a→/team-b）');
  console.log(`    进程计数增量数值上仍有效，但归属已变: ${JSON.stringify(moved.processes[41].cgroup)} flags=${JSON.stringify(moved.processes[41].flags)}`);
  console.log(`    组级账本: /team-a ${JSON.stringify(moved.groups['/team-a'])} /team-b ${JSON.stringify(moved.groups['/team-b'])}`);
  console.log('    按组记账的使用方不应把这段增量直接记入任一组。');

  // 场景五：系统重启，两次观察整体不可对齐。
  await control({generation: 2});
  const F = await snap();
  const reboot = diffSnapshots(E, F);
  console.log('\n[6] 系统重启（boot_id 变化）');
  console.log(`    整体不可对齐: aligned=${reboot.aligned} reason=${reboot.reason}，不产出任何进程增量。`);

  // 场景六：进程退出。
  await control({remove: true});
  const G = await snap();
  const gone = diffSnapshots(F, G);
  console.log('\n[7] 进程退出');
  console.log(`    ${JSON.stringify(gone.processes[41])}`);

  console.log('\n=== 演示结束：被拒绝的增量均带机器可读原因，未补零、未取负 ===');
} finally {
  await source.close();
}

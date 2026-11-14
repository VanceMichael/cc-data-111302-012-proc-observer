# 观察身份、完整度与增量规则

本文档定义只读采集（`src/sampler.mjs` + `src/diff.mjs`）的领域语义。采集只读配置的 proc 树与 cgroup 树，不做进程控制，不做安全扫描。

## 观察身份

一个观察对象由三元组唯一确定：

- `bootId`：`proc/sys/kernel/random/boot_id`，内核启动身份；
- `pid`：proc 树中的进程目录名（宿主机视角）；
- `startTime`：`stat` 第 22 字段 starttime，进程启动时刻。

三者共同判断"是不是同一个观察对象"。只看 pid 会在进程退出、PID 被内核复用后，把新进程的计数记到已退出作业头上——短作业因此被累计出几百小时的运行记录。

`status` 的 `NSpid` 是宿主机到嵌套命名空间的 PID 链，原样保留在快照里（含来源路径），用于容器内外 PID 对照；身份判定始终用最外层 pid，命名空间内的 pid 不单独作数。

cgroup 归属同时记录两侧来源：进程自报的 `cgroup` 文件路径，以及 cgroup 树里 `cgroup.procs` 的成员列表。每条记录都带 `source` 路径。树路径是采集来源的内部结构，不能直接当成业务作业身份；业务身份由使用方自己的标签体系建立。

## 完整度

每个文件的读取结果分为：

- `ok`：读取并解析成功；
- `vanished`：读取之间进程退出或文件消失（ENOENT/ENOTDIR）；
- `denied`：权限不足（EACCES/EPERM）；
- `invalid`：读到内容但解析失败；
- `error`：其他读取错误。

进程级 `completeness`：全部文件 `ok` 为 `complete`，否则为 `partial` 并列出 `missing`。`stat` 不可用或无效时无法建立 identity。

归属交叉校验 `membership`：`consistent`（自报组与成员列表一致）、`mismatch`（不一致，采样中迁组的证据）、`stale`（自报的组已不存在）、`unknown`（组信息不可读）。

## 相邻快照的增量裁决

`diffSnapshots(prev, next)` 的状态：

| 状态 | 含义 | 增量 |
| --- | --- | --- |
| `ok` | 同一对象、两侧完整 | 各计数器差值（可为 0） |
| `appeared` / `vanished` | 仅一侧存在 | 无 |
| `pid-reused` | pid 相同但 startTime 不同 | 拒绝，附两侧身份 |
| `not-aligned` | 任一侧无法建立身份 | 拒绝 |
| `incomplete` | 任一侧读取不全 | 拒绝，列出缺失文件 |
| `counter-reset` | 某计数器回退 | 回退项标记 reset（附前后值），其余照常 |
| `cgroup-moved` | 归属路径变化 | 进程级增量有效但带标记，按组记账的使用方不应直接入账 |

快照级对齐失败：`boot-changed`（系统重启）、`boot-unknown`（boot_id 不可读）、`snapshot-missing`。此时不产出任何进程增量。

无法对齐的两次观察不硬算负数、不补零，只给机器可读的原因。

## 资源约束

- `maxOpen`：同时打开的文件数上限（门闩硬约束），默认 16；
- `budgetMs`：单次采样耗时预算，默认 1000ms。预算用完后未开始的对象记入快照的 `incomplete`（原因 `budget-exceeded`），`meta.timedOut` 为 true——超时后仍能交代哪些对象未完成。

## 演示与测试

`npm run demo:observe` 在合成来源上连续推进状态（PID 复用、计数回退、迁组、重启、退出），逐步展示增量为何被接受或拒绝。`test/observe.test.mjs` 用 `/control` 推进来源状态，让退出后 PID 复用与采样中迁组在合成目录上真实发生。

// 只读解析 /proc 与 cgroup 文本的纯函数。
// 解析器不触碰任何进程状态，只把内核文本变成结构化字段。

/**
 * 解析 /proc/<pid>/stat。
 * comm（第 2 字段）可以包含空格与括号，例如 "worker (phase one)"，
 * 因此必须按行内最后一个右括号切分，不能按第一个右括号或空格切分。
 */
export function parseStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 1 || close <= open) throw new Error('stat 缺少 comm 括号');
  const pid = Number(text.slice(0, open).trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('stat 的 pid 无效');
  const name = text.slice(open + 1, close);
  const rest = text.slice(close + 1).trim().split(/\s+/);
  // rest[0] 是第 3 字段 state；utime=第14字段、stime=第15字段、starttime=第22字段。
  if (rest.length < 20) throw new Error(`stat 字段不足: ${rest.length}`);
  const field = index => {
    const value = Number(rest[index]);
    if (!Number.isFinite(value)) throw new Error(`stat 第 ${index + 3} 字段非数值`);
    return value;
  };
  return {pid, name, state: rest[0], utime: field(11), stime: field(12), startTime: field(19)};
}

/** 解析 /proc/<pid>/status，提取 Name 与 NSpid（宿主机到嵌套命名空间的 PID 链，原样保留）。 */
export function parseStatus(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === 'Name') out.name = match[2].trim();
    if (match[1] === 'NSpid') out.nspid = match[2].trim().split(/\s+/).filter(Boolean).map(Number);
  }
  return out;
}

/** 解析 NUL 分隔的 /proc/<pid>/cmdline。 */
export function parseCmdline(buffer) {
  const text = buffer.toString('utf8');
  if (!text) return [];
  const parts = text.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** 解析 /proc/<pid>/io 的字节计数。 */
export function parseIo(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(\w+):\s*(\d+)\s*$/.exec(line);
    if (!match) continue;
    if (match[1] === 'read_bytes') out.readBytes = Number(match[2]);
    if (match[1] === 'write_bytes') out.writeBytes = Number(match[2]);
  }
  return out;
}

/** 解析 /proc/<pid>/cgroup，返回 v2 统一层级路径；没有 v2 行时返回 null。 */
export function parseCgroupFile(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(':');
    if (parts.length === 3 && parts[0] === '0' && parts[1] === '') return parts[2] || '/';
  }
  return null;
}

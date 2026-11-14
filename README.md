# 进程命名空间中的一致性资源观察采集

这是用于内部数据接入的 Node.js 项目。当前提供可独立启动的本地来源、单次原文读取接口以及来源契约测试；浏览器页面和仪器网关使用合成业务资料，不连接真实账户或设备。

## 环境与命令

Node.js 22.22.1 或更新的 22.x。依赖由 package-lock.json 锁定。

```sh
npm ci --ignore-scripts
npm run build
npm test
npm start
```

`npm start` 在标准输出报告来源地址。默认绑定本机回环地址并使用动态端口；可通过 `HOST` 与 `PORT` 指定监听地址和端口，例如 `HOST=127.0.0.1 PORT=8080 npm start`。按 Ctrl+C 关闭来源；动态端口避免与同机其他接入站冲突。`npm run demo` 在同一进程启动来源，读取一次目录后退出，不代表持续接收业务已经完成。`npm run demo:observe` 演示只读采样与相邻快照的增量裁决，展示 PID 复用时增量为何被拒绝。

```sh
docker build -t proc-observer:local .
docker run --rm --network none proc-observer:local
docker run --rm --network none proc-observer:local npm run demo
```

依赖在镜像构建阶段安装，运行阶段不需要公网。完整来源测试和一次目录演示通常数秒即可结束，适合在90秒以内查看真实输出。浏览器在无界面模式执行，页面交互不依赖人工鼠标。

## 目录

- `src/source.mjs`：本地来源生命周期与HTTP入口。
- `src/client.mjs`：目录读取及原始字节获取。
- `src/proc-parse.mjs`：proc/cgroup 文本解析，stat 进程名按最后一个右括号切分。
- `src/sampler.mjs`：只读采样，建立观察身份与完整度，约束文件句柄数与采样耗时。
- `src/diff.mjs`：相邻快照对齐与计数增量裁决。
- `src/observe-demo.mjs`：演示增量为何被拒绝使用。
- `fixtures/source.json`：来源初始状态。
- `docs/source-contract.md`：来源协议范围、控制与领域语义。
- `docs/observation.md`：观察身份、完整度与增量规则。
- `test/source.test.mjs`：实际来源集成测试。
- `test/observe.test.mjs`：采样与增量测试，推进来源状态复现 PID 复用与迁组。

运行时状态仅用于来源模拟，重启来源会回到 fixtures 中的值。接入业务自己的持久状态请使用 `.local/` 或明确的外部路径。来源管理入口 `/state` 和 `/control` 是本地操作设施，不能作为绕过浏览器页面的业务写入捷径。

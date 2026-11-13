# 来源协议

服务在临时目录生成合成 proc 与 cgroup 树，/inventory 的 treeRoot 给出根路径。boot_id标识启动，stat的第22字段是starttime，第14/15字段是utime/stime。进程名称为worker (phase one)，不能按首个右括号切分。status含NSpid，cgroup为v2路径；当前单次读取函数只返回原文。POST /control 可设置generation、start、reads、group及remove，重写本服务临时树，不访问宿主/proc。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。

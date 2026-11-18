# 本地 MQTT 性能基准

在仓库根目录运行。两条基准都使用带序号的定长消息。每次成功运行按场景输出一行 `PERF {JSON}`。断言失败时命令返回非零退出码。

## 应用接收队列

需要项目已有的 Node.js 和本地前端依赖。启用标记后，Vitest 在 Node 环境中把批次交给生产 Pinia store 注册的 `mqtt-message-batch` 监听器。

```bash
# 默认 500 批，每批 64 条，批间等待 20 ms，约 10 秒
MINI_MQTT_PERF=1 ./node_modules/.bin/vitest run --reporter=verbose perf/receive.test.ts

# 1 秒冒烟，或者将 1 改为 60 做持续负载
MINI_MQTT_PERF=1 MINI_MQTT_PERF_SOAK_SECONDS=1 \
  ./node_modules/.bin/vitest run --reporter=verbose perf/receive.test.ts

./node_modules/.bin/vue-tsc --noEmit -p perf/tsconfig.json
```

- `burst` 在一个 JS 执行轮次中投递当前队列容量的四倍，按每批 128 条分割。核对接纳数、模拟历史写入数和丢弃数，排空后两个待处理计数均须归零。
- `soak` 每批等待 20 ms，无补发式追赶。核对零丢弃、零处理失败、队列条数和计费字节峰值均在配置上限内。同步观测 store 的保留数，每个场景都核对最后保留的消息序号。
- 每条消息携带 128 字节 ASCII payload。Tauri IPC 和历史写入由 mock 提供，每次历史调用等待 2 ms。接收后脚本为空。前端列表渲染、真实 IPC、Rust 接收批处理和 SQLite 位于此测量边界之外。
- `offer_ms` 从构造首批消息前量到最后一批投递结束，包含生成和节奏等待。`drain_ms` 是最后一批投递后到显式排空完成的时间。`mock_persisted_per_second` 按两段总时间计算。`peak_pending_charged_bytes` 反映队列计费规则，持续负载的有界断言针对队列和 store 行数，进程 RSS 和堆大小未采样。

## 真实本地 broker 收发

需要 POSIX 环境、Python 3.11+ 以及 PATH 上的 Eclipse Mosquitto 2.x 的 `mosquitto`、`mosquitto_pub` 和 `mosquitto_sub`。Debian 系列分别由 `mosquitto` 和 `mosquitto-clients` 软件包提供。脚本自动在 `127.0.0.1` 的临时端口启动 broker，使用单独的临时配置目录，并在结束时清理子进程和配置。运行环境需要允许本机 TCP 监听和连接。

```bash
python3 perf/broker.py
python3 perf/broker.py --rate 5000 --seconds 10
```

脚本先等订阅端收到就绪探针，再按目标速率发送指定数量的 128 字节消息。订阅端逐条比对序号和完整 payload，遇到重复、缺失、乱序或内容不符即失败。最后一条数据后发送停止标记，再关闭发布端 stdin 并等待退出。订阅端收到标记且发布端退出后，继续观察 250 ms，期间必须无后续消息，broker 和订阅进程也须保持运行。

`offer_ms` 记录从负载启动到提交最后一批的时长，`drain_ms` 记录从该时刻到订阅端收到停止标记的时长，`verified_per_second` 按负载启动到核对完成的总时长计算。结果包含 Python 生成与核对、Mosquitto 命令行客户端及本地 TCP 开销，覆盖单发布者、单订阅者的 MQTT 3.1.1 QoS 0 场景。应用接收、UI 吞吐和渲染延迟需另行测量。[Mosquitto 发布命令](https://mosquitto.org/man/mosquitto_pub-1.html) · [Mosquitto 订阅命令](https://mosquitto.org/man/mosquitto_sub-1.html)

## 保存结果

保留 `PERF ` 后的 JSON 对象即可生成 JSONL。用 `boundary` 和 `scenario` 匹配同一测量边界下的多次结果。对比时保持负载参数、运行时版本和机器环境一致。

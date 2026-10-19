# 批次 D：可观测性与诊断（2026-10-19）

## 1. 指标实装

`src/main/observability/Metrics.ts` 从「仅计数器」升级为：

| 能力 | 说明 |
|---|---|
| `increment(name, value)` | 计数；忽略 0 / NaN |
| `observe(name, value)` | 延迟或大小样本；忽略负数与非有限值 |
| `snapshot()` | 计数器 + `<name>_count/_sum/_min/_max/_avg` + `uptime_ms` |
| `reset()` | 清空计数与样本，保留启动时间 |

运行时接入：

- `AgentRuntime.onToolResult` 记录 `tool_duration_ms` 样本
- `AgentRuntime.finish` 把 `metrics_snapshot` 写入 Trace，随后随 TraceStore 落到
  `<traceDir>/<sessionId>.jsonl`，重启后仍可读取

已有计数（复用原有调用点）：`runs_started/completed/failed/cancelled`、
`turns_started`、`tools_started/succeeded/failed`、`retries`、`provider_calls`。

## 2. 崩溃收集

`electron-entry.js` 启动时：

```js
crashReporter.start({ productName: 'IEXA-WIN', companyName: 'IEXA', uploadToServer: false, compress: true });
process.env.IEXA_CRASH_DIR = app.getPath('crashDumps');
```

- **只落本地**，`uploadToServer: false`，不上传任何内容
- 崩溃目录通过环境变量传给后端，诊断快照列出最近 50 个 dump 文件名
- 整体包在 `try/catch` 中，崩溃收集失败不影响启动

## 3. 诊断包

| 路由 | 作用 |
|---|---|
| `GET /api/diagnostics` | 返回脱敏快照（不读 API Key、密码、令牌） |
| `POST /api/diagnostics/export` | 生成 gzip 包（`<workspace>/.iexa-diagnostics/diagnostics-<ts>.json.gz`） |

快照内容：

```json
{
  "generatedAt": "...",
  "app": { "name": "IEXA-WIN", "version": "1.0.0", "electron": ..., "node": ..., "platform": ..., "arch": ... },
  "scope": { "workspace": "...", "project": "..." },
  "counts": { "sessions": 12, "profiles": 3, "plugins": 0, "activeAgents": 1 },
  "metrics": { "runs_started": 4, "tool_duration_ms_avg": 128, ... },
  "crash": { "directory": "...", "dumps": ["..." ] }
}
```

UI：关于页新增「诊断」分组 + 「导出诊断包」按钮，点击后显示落盘路径与大小。

## 验证

| 项 | 结果 |
|---|---|
| `tests/metrics.test.js` | **3/3** |
| `tests/diagnostics-route.test.js` | **3/3**（快照字段、gzip 可解、匿名 401/403） |
| 全量 | 见提交说明 |
| 脱敏断言 | 快照序列化文本不含 `apiKey` / `secret` / `password` / `bearer` |

> Electron 的 `crashReporter` 只能在真实桌面进程中生效，批次 D 未做自动化崩溃注入；
> 字段与目录传递通过代码审查与诊断快照的空 dump 列表验证。

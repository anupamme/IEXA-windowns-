# 批次 C：会话检查点与工具钩子（2026-10-19）

## 1. 检查点 / 回退（checkpoint / rewind）

### 设计

每次用户请求（一次 `agent.run`）涉及的文件修改，在回合结束时聚合为一个检查点：

- 每个文件只保留**本轮第一次修改前**的快照（`rollback.beforeBase64`）
- 校验哈希取**本轮最后一次修改后**的 `afterSha256`
- 回退时复用 `undoFileChanges`，因此沿用它的全部保证：
  - 路径必须仍是授权根内的真实路径（realpath 比对）
  - 当前文件内容必须等于快照记录的 `afterSha256`
  - 同一文件的写入串行化（`withFileLocks`）
  - 先全量预检，再逐个替换；中途失败可重试

### 回退语义

回退到检查点 N = 逆序撤销 N 之后的所有检查点（最新的先撤）。只有全部撤销成功才会截断历史记录；任何一个文件冲突都会中止并保留完整历史。

### 存储

`<workspace>/.iexa-checkpoints/<sessionId>.json`，原子写入（临时文件 + rename）。

| 限制 | 值 |
|---|---|
| 每会话检查点 | 20（超出丢弃最旧） |
| 单检查点文件数 | 80 |
| 单检查点快照体积 | 8 MB |
| 单文件快照 | 700 KB base64（沿用撤销快照上限） |
| sessionId 校验 | `^[A-Za-z0-9_-]+$`，防路径穿越 |

### API

```
GET  /api/checkpoints?sessionId=<id>
POST /api/checkpoints/rewind   { "sessionId": "...", "checkpointId": "cp_..." }
```

响应：`{ ok: true, restored: [...], removed: N }`。

## 2. 工具生命周期钩子（hooks）

### 配置

工作区根 `.iexa-hooks.json`：

```json
{
  "preToolUse":  { "script": ".iexa-hooks/pre.js",  "tools": ["file_write", "file_edit"], "timeoutMs": 5000 },
  "postToolUse": { "script": ".iexa-hooks/post.js" }
}
```

### 执行契约

- Node 脚本，stdin 收到一个 JSON：`{ phase, tool, args, sessionId, result? }`
- stdout 可返回 `{ "block": true, "reason": "..." }`
- **只有 preToolUse 能阻断**；postToolUse 仅作通知
- 钩子**不能改写工具参数**，已通过 schema 校验的参数就是实际执行的参数
- 超时、无效 JSON、非零退出都只记录错误，不改变工具结果；唯一例外是 preToolUse 明确 `block: true`

### 安全边界

| 项 | 规则 |
|---|---|
| 脚本位置 | 必须解析到工作区根内（`path.relative` 校验），拒绝 `../` |
| 扩展名 | `.js` / `.cjs` / `.mjs` |
| 配置大小 | 64 KB |
| stdout | 64 KB |
| 超时 | 100–30000 ms，默认 5000 |
| 未知字段 | 整条配置被忽略（fail closed） |
| 工具过滤 | `tools` 为空数组或非法名称时忽略该条 |

## 验证

| 项 | 结果 |
|---|---|
| `tests/checkpoints.test.js` | **7/7**（合并、逆序回退、无操作回退、冲突中止、新建/删除、非法 ID、20 条上限） |
| `tests/tool-hooks.test.js` | **5/5**（配置校验、pre 阻断、post 通知、超时/无效 JSON 不破坏工具） |
| 全量 | **587/587**（限并发） |

> UI 入口（历史面板 / `/rewind` 命令）安排在批次 E 与命令面板一起接入；本轮 API 已完备，可用 `curl` 直接验证。

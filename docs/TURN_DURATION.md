# 消息耗时（turn duration）

用量行现在是：

```
▮ 203,702 入 · 1,043 出 · 202,624 缓存 · 耗时 1 分 12 秒  20:51
```

「耗时」位于缓存回执之后、时间之前，从 `0 秒` 开始，按秒走。任务结束后数字冻结，
不再变动；重新打开会话时显示落盘的那个值。

## 三个时间戳

| 位置 | 含义 |
|---|---|
| `dataset.turnStartedAt` | 回合开始（用户按下发送），流式消息创建时写入 |
| `dataset.turnFinishedAt` | 收尾时刻，`finalizeAssistantMessage()` 写入 |
| `dataset.durationMs` | 定稿时长；历史消息由服务端字段还原 |

`messageTurnDuration()` 优先级：`durationMs`（已定稿）→ `turnStartedAt` 与
`turnFinishedAt` 相减 → 仍在跑就用 `Date.now()` 现算。

**为什么现算而不是累加**：切走标签页、后台节流都会让累加器漂移；用绝对时间戳相减，
无论中间发生多少次渲染、挂载、切换，秒数都准。

## 只有一个计时器

`liveTurnDurations` 是一个 `Set`，只放「正在跑」的那一个元素；间隔 1000ms 的
`setInterval` 在注册第一个元素时创建，最后一个元素出队时销毁。渲染函数的顺序是
**先注销旧节点、再重写 innerHTML、最后注册新节点**——否则 token 回执到达时重建
innerHTML 会把旧节点留在 Set 里，变成一个每秒钟往游离节点写字的泄漏。

计数器的更新成本：在真实的 24.78MB 会话（60 条 / 73,577 节点）上连续 6 秒、
601 帧，p50 10ms、p95 10ms、最长 20ms、>50ms 帧数 **0**。

## 首次绘制就要有

`renderMessageUsage(..., { pending: true })` 只画耗时，不画 `0 入 · 0 出`。
消息一创建就调用，而不是等 `usage` 事件——否则模型思考十秒期间那行是空的，
"实时看到任务时间"就无从谈起。

顺带修正：历史消息的 usage 元素过去是**先渲染再插入**，`closest('.message.assistant')`
拿到 null，导致恢复的会话看不到生成时间。现在统一改成先插入再渲染。

## 服务端

`ChatMessage.durationMs` 由 `saveSessionMessages()` 在 done / error / cancelled
三条路径写入，起点取 `/api/chat` 收到请求的时刻（`chatTurnStartedAt`），因此
附件上传时间也计入。客户端实时计数与服务端落盘值可能差几十毫秒（网络往返），
留痕以客户端为准、刷新后以服务端为准。

## 验证时顺带修掉的竞态

`loadAppearanceSettings()` 原来总是把 `--sidebar-width` / `--files-panel-width`
写到 `:root`，然后再交给 `IexaPanelWidths`。`:root` 写入会让整份文档的计算样式
失效（24MB 会话上单次 ≈128ms），而且如果外观请求在拖拽过程中才落地，就会直接
破坏「拖拽期间不碰继承属性」这条约束——`panel-resize` 用例在并发跑全量时有概率
报 `drag must not write the inherited :root property`。

现在只有面板模块尚未初始化（首次绘制）时才写 `:root`，其余时候全部走面板级属性。

## 测试

- `tests/message-usage-duration.test.js`：秒/分/时格式、首绘只有耗时、按秒推进、
  token 中途到达不重置、定稿冻结并释放计时器、历史还原、无耗时时渲染不变。
- `tests/turn-duration-persistence.test.js`：起一个本地 SSE 上游，跑真实回合，
  校验会话里助手记录的 `durationMs` ≥ 350ms、用户记录没有该字段。
- `tests/browser-message-usage.test.js`：真实 Chromium 里观察 0 秒 → 1 秒 →
  中途 token 重绘 → 定稿后等待 1.2 秒确认不再走动。

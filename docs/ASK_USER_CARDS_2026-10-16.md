# 问答交互卡片（ask_user）· 2026-10-16

助手可以在对话中用交互卡片向用户提问或请求确认，等用户回答后继续。多题卡片可逐题作答。

## 功能
- 卡片内联渲染在对话流中（挂在 `ask_user` 工具步骤之后），不打断对话阅读。
- 题型：
  - 单选（`options`）
  - 多选（`multi_select: true`）
  - 自由文本（无 `options`，或 `allow_free_text: true`）
  - 确认（`confirm` 快捷参数 → 确认/取消 两键，点选即提交）
- 多题卡片：逐题作答（上一题/跳过/下一题），支持进度点与"第 x / n 题"提示；全部作答或跳过后一次性提交。
- 完成后卡片转为只读摘要（题目 → 答案），工具结果回传给模型，助手继续执行。
- 用户可点 ✕ 取消提问（带确认框）；此时工具返回"未作答"并提示模型不要重复提问。
- 30 分钟未作答自动超时；轮任务被取消时卡片自动收口为"未作答"状态。

## 架构（复用权限对话框的 Broker 模式）
后端：
- `src/main/runtime/QuestionBroker.ts` — 待答提问桥（subscribe/list/resolve/cancelSession）+ `ask_user` 参数归一化 + 答案格式化。
- `src/main/tools/ToolDefinitions.ts` — `ask_user` 工具定义（嵌套 questions/options schema，严格校验）。
- `src/main/runtime/ToolRuntime.ts` — 注册与分发 `ask_user`；等待期间轮任务取消信号会解除等待。
- `src/main/runtime/AgentRuntime.ts` — `questionResolver` 注入；子代理提问重映射到根会话（与权限请求同策略）。
- `src/main/server.ts` — 会话 SSE 发送 `question_required`、订阅生命周期清理、`cancelSessionAgent` 同步清退。
- `src/main/api/RuntimeRoutes.ts` — 三个路由（见下）。

前端：
- `src/renderer/components/QuestionCard.js` + `QuestionCard.css` — 卡片组件（状态机：awaiting → submitting → submitted / closed）。作答/取消后卡片自动折叠为单行摘要（预览行显示答案或结果），点 chevron 或预览行展开、再点收起。
- `src/renderer/app.js` — `question_required` SSE 分支、挂载到工具步骤组、`tool_state`/`tool_result` 终态收口、`handleCancelled` 兜底、会话切回时 `syncPending` 对账（断线重连恢复）。
- `src/renderer/index.html` — 引入脚本与样式。

## HTTP 接口
- `GET /api/questions?sessionId=` → 待答提问列表（断线恢复用）。
- `POST /api/questions/answer` `{ id, answers: [{ id, selected: [], freeText?, skipped? }] }` → 提交作答。
- `POST /api/questions/cancel` `{ id }` → 取消提问（工具按"未作答"返回）。

## 事件流
1. 模型调用 `ask_user` → 工具执行挂起（`awaiting_approval` 之外的普通等待，不发权限弹窗）。
2. 服务端通过会话 SSE 推送 `question_required` → 前端在工具步骤后渲染卡片。
3. 用户提交 → `POST /api/questions/answer` → broker 解析 → 工具返回格式化答案 → Agent 继续。
4. 异常路径：卡片取消 / 轮任务取消 / 会话取消 → `resolve(null)` → 工具返回"提问未完成…"。
5. 断线恢复：切换会话时前端对账 `GET /api/questions`，未在列表中的本地待答卡片收口为"已结束"。

## 测试
- `tests/question-broker.test.js` — Broker 生命周期、abort/超时/清退、参数归一化、答案格式化。
- `tests/question-routes.test.js` — 三个路由的真实 HTTP 行为（含 400/404 分支）。
- `tests/question-card.test.js` — jsdom 卡片交互：逐题作答、单次提交载荷、跳过、终点态、确认即交、syncPending 对账、自动折叠与手动展开/收起。
- `tests/question-tool.test.js` — ToolRuntime 全链路：等待→作答→格式化；取消→"未作答"；无解析器/缺参数的兜底文案。
- `tests/browser-question-card.test.js` — 真实浏览器（headless Chrome）：提交后自动折叠、chevron/预览行展开、取消折叠、计算样式断言（含操作行/圆点隐藏回归），并输出截图。

## 随行修复（本项目原有问题，非本功能引入）
- `tests/helpers/transcript-harness.cjs` — 补 `refreshToolGroupSummary` 模拟（自 55e78ff 起三个 renderer 顺序测试因缺该函数而报错）。
- `src/renderer/services/TranscriptView.js` — `restore()` 中 `old` 快照的捕获时机提前导致被复用的 `.tool-steps` 分组在末尾被误删（历史恢复时首个工具行丢失）；现改为在采纳循环之后捕获。
- `tests/runtime-cancellation-route.test.js` — 上下文补充 `questionBroker`（`/api/cancel` 现在同步清退待答提问，新增断言）。
- `src/renderer/components/QuestionCard.css` — 补 `.question-card-actions[hidden]` / `.question-card-dots[hidden]` 的显式 `display:none`：作者 `display` 规则会压过 UA 的 `[hidden]` 规则，此前终态卡片的操作行/进度圆点在视觉上未真正隐藏。

## 生效方式
后端为 TypeScript，需要重新 `npm run build` 并重启应用进程；渲染层文件（src/renderer）随应用重启生效。测试命令：`npm test`。

## 系统提示词指引补充（2026-10-16 晚）

需求：让模型知道「需要用户回答选择题时，要用问答卡片工具提问」，而不是只在回复正文里用文字问。

实现（`src/main/agent/SystemPrompt.ts`，两处）：
1. 「核心能力」工具清单新增 `**ask_user**` 条目（此前工具清单未列出该工具）：「需要用户做选择、勾选、确认或给出关键决定时，弹出交互问答卡片向用户提问并等待作答（支持单选 / 多选 / 自由文本 / 确认，多题可依次作答）。」
2. 「任务沟通与澄清」新增规则：「需要用户回答选择题（做选择、确认、取舍、参数/环境选择等）时，应使用 **ask_user** 工具弹出问答卡片向用户提问并等待作答；不要用纯文本代替卡片向用户提这类选择题，用户作答后按其答案继续执行。」

覆盖范围：主会话与子代理共用 `buildSystemPrompt`（子代理仅在尾部追加身份块），两侧同时生效；工具表（`makeAgentTools()`）无需变更——`ask_user` 本就无条件进入清单。

测试：`tests/tool-routing-prompt.test.js` 新增用例——工具清单引入 ask_user（位于「你可以使用以下工具」之后）、沟通节含选择题走卡片规则、`makeAgentTools()` 暴露 ask_user 且描述承诺卡片交互。

验证：定向 5 文件 24/24；全量 549 项 548 过（唯一失败=固有 flaky `browser-session-concurrency`，单独复跑通过）；`npm run build` 通过，dist 已含新文本。

注意：主进程提示词变更需**重启应用**生效；重启后每会话首轮会重建一次前缀缓存（提示词新增约 200 字符），之后照常命中。

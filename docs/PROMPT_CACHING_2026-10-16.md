# 提示词缓存排查与修复（2026-10-16）

> 用户反馈："token 消耗相比别的 agent 工具大很多，缓存不行。"

## 一、实测证据

| 编号 | 证据 |
|---|---|
| **E1** | `workspace/.iexa-token-usage.json` 台账：**16,354 次请求 / 12.02 亿输入 token**，25 个模型记录中 `cacheReadInputTokens` 与 `cacheCreationInputTokens` **全部为 0** —— 缓存统计从未被采集。 |
| **E2** | 单会话审计（`workspace/tmp/cache-audit.cjs`，sess_1792123829061）：**389 次调用 / 6,954 万输入 token**，其中 **98.5% 是重复发送的上下文**（增量内容仅 103 万）。→ 消费主体 = 每轮重复发送的前缀，便宜与否完全取决于提供商前缀缓存是否命中。 |
| **E3** | 旧实现把"每轮重生成的 durable session context（~11KB）"拼进 **system prompt 尾部**（`AgentLoop.run()` + `server.ts` 每轮 `setSessionContext`）。→ 每个用户轮次的**请求头都变化**，前缀缓存在第 0 字节即失配，整个会话按全价重算。 |
| **E4** | OpenAI 系 Provider（DeepSeek/中转/自定义全走它）**从不解析缓存回执**：DeepSeek 的 `prompt_cache_hit_tokens`、OpenAI 的 `prompt_tokens_details.cached_tokens` 全部被丢弃（`LLMUsage`/`CostTracker` 早有字段与累加逻辑，但没有任何数据源）。 |

## 二、修复（本次落地）

1. **`src/main/agent/AgentLoop.ts` — context placement 机制**
   - 每轮漂移的根会话上下文（默认 `'message'` 放置）改乘**新用户消息的头块**；`system + tools + history` 逐字节稳定，历史严格追加式扩展。
   - 一次性写入、终身稳定的**子代理身份信封**显式 `'system'` 放置（保持"`You are sub-agent …` 在系统提示词"的既有契约）。
2. **`src/main/providers/OpenAIProvider.ts` — 缓存回执解析（chat + responses 双路径）**
   - `prompt_cache_hit_tokens`（DeepSeek）→ `prompt_tokens_details.cached_tokens`（OpenAI）→ `cache_read_input_tokens`（兼容中转）逐级取值，映射到 `usage.cacheReadInputTokens`。
   - **0 命中显式上报**（能区分"端点不缓存"与"没统计"）；数值截断到 prompt 规模以内。
3. **`src/main/runtime/AgentRuntime.ts`** — trace `provider_usage` 事件附带 `cacheReadInputTokens`（`.iexa-traces/*.jsonl` 每次调用可见）。
4. 台账（`.iexa-token-usage.json`）与 `/api/token-usage` 的现有字段从此有真实数据源。

## 三、验证记录

- 新增测试：`tests/durable-context-tail.test.js`（3 项：前缀逐字节稳定 / 严格追加式扩展 / system 放置）＋ `tests/openai-cache-usage.test.js`（4 项：DeepSeek 方言 / OpenAI 方言 / 0 命中显式 / 越界截断）。
- `tests/prompt-context.test.js` 同步更新（durable 标记不再允许出现在系统提示词）。
- 全量回归 **540 项：539 过**，唯一失败为固有 flaky（browser-session-concurrency，单独复跑通过）。

## 四、生效后怎么验证（重启应用后）

```bash
node workspace/tmp/cache-audit.cjs              # 最新会话
node workspace/tmp/cache-audit.cjs <sessionId>  # 指定会话
```

- `provider-reported cache reads` 明显 > 0 → 端点支持前缀缓存且已命中（对比增量行估算命中率）。
- **恒为 0 或无回执** → 端点（多为第三方中转）本身不做缓存；换官方 DeepSeek 端点或支持缓存的中转才有红利。

## 五、固定基线（另一条降耗线索）

每次请求的固定部分：基础提示词 + 6 个内置技能正文（合计 **~46KB**，其中 xiaoliu-pojia 18.8KB）+ 工具定义 + durable context（~11KB/轮）。会话首个请求即 25K tokens。若端点不缓存，这部分按每次请求全价计费 —— 可在技能侧调整单个 SKILL.md 的 `systemPrompt` 标记（关闭全文注入、改走按需 `file_read` 渐进披露）来控制。

## 六、备注

- 缓存命中与否由端点决定；IEXA 侧已做到"请求头稳定 + 回执可见"两项最大化。
- main 进程改动：重启应用后生效。

## 七、UI 显示补充（2026-10-16 追加）

用户要求：聊天里每条回复下方的用量行、以及「Token 用量」页，都要能看到缓存数据（不能只显示输入/输出）。

- **聊天用量行**（`.message-usage`，app.js `renderMessageUsage`）：新增第 4 个参数 `cacheReadTokens`，渲染为 `80,739 入 · 19,398 出 · 79,104 缓存`。
  - 端点明确回报 0 时显示「0 缓存」（直观区分"没命中"与"没上报"）；端点无回执字段时隐藏该段；旧消息无字段时同样隐藏。
  - 实时路径：SSE `usage` 事件（含 `cacheReadInputTokens`）→ `handleUsage`；历史重载路径：`msg.usage.cacheReadInputTokens`（server.ts 的 `lastUsage` 已扩展持久化该字段）。
- **Token 用量页**（`renderTokenUsage`）：每个模型卡片的「缓存」栏改为**恒定显示**（= 缓存读取+缓存写入），不再在 0 时隐藏。
- 验证：`tests/message-usage-cache.test.js`（6 项）＋ `tests/browser-message-usage.test.js`（真实 Chrome 端到端，1 项）。
- 生效：渲染层刷新即生效；服务端新字段持久化随下次大退重启（之后新产生的消息在历史重载时也带缓存段）。

## 八、死代码清理（2026-10-16 晚）

用途量显示排查时暴露的「同名覆盖」死代码，本次全部清除（纯渲染层改动，刷新即生效）。

**清除项（app.js）**：
1. `handleUsage` 重复定义：删除被覆盖的旧数据集版（原 3733-3739，从不执行），以及仅被它喂食的 `renderPendingMessageUsage`（原 3713-3731，因 dataset 无写入方而永远提前 return）与两处调用点（原 2186、3892）；`dataset.usage*`（inputTokens / outputTokens / cacheReadTokens）管道随之移除。实时渲染仍走唯一 `handleUsage`（直接渲染 + 刷新 Token 页），历史渲染调用点（1255 行）与缓存段参数不变。
2. `formatContextTokensForDisplay` 逐字节重复定义（原 5477 / 5482）：删除一份；唯一调用点（模型下拉的上下文窗口标注）不变。

**防回归（tests/message-usage-cache.test.js 新增 2 个用例）**：
- `usage rendering keeps a single handler and the dead pending path stays removed`
- `app.js keeps no duplicate top-level function declarations`

**验证**：
- `node --check src/renderer/app.js` 通过。
- AST 扫描：app.js 349 个顶层函数声明、0 重复；全渲染层 25 个文件（除 vendor）0 重复。
- jsdom 7/7；真实浏览器端到端 1/1（实测：唯一 `handleUsage` 存在、`renderPendingMessageUsage` 不存在、实时调用渲染 `111 入 · 22 出 · 33 缓存`）。
- 全量回归 548 项：547 过；唯一失败为固有负载型 flaky `browser-session-concurrency`，单独复跑通过。

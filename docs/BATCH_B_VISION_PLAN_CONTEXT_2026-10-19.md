# 批次 B：原生读图、规划模式、上下文仪表（2026-10-19）

## 1. `read_image` 原生多模态

### 背景

`read_image` 原本只在「文本模型 + 配置了视觉代理」时动态注册，走 `VisionFallback`
把图片转成文字描述。原生视觉模型反而没有这个工具，agent 无法主动查看工作区里的
截图、设计稿、报错图。

### 实现

新文件 `src/main/tools/ImageTools.ts`：

| 能力 | 说明 |
|---|---|
| 原生通道 | 返回 `imageData` + `imageMimeType`；`AgentLoop` 已把它作为独立 `imageData` part，OpenAI（`image_url` / `input_image`）、Anthropic（base64 block）、Gemini（inline data）适配器都能序列化 |
| 格式校验 | 用 magic bytes 识别 PNG/JPEG/GIF/WebP/BMP，扩展名与内容不一致直接拒绝 |
| 大小上限 | 5 MB（base64 膨胀约 4/3，贴近提供商单图上限） |
| 路径边界 | `resolveScopedPathAsync` + 工作区根/项目根双根；符号链接解析到根内允许、根外拒绝 |
| 元数据 | 读取尺寸（`imageDimensions`）、格式、大小，写进工具输出 |

注册逻辑（`server.ts`）：

```
if (vision profile && text-only chat model)   → 视觉代理（原行为，risk: low）
else if (modelSupportsVision(provider, model)) → 原生 read_image（新）
else                                           → 不注册
```

`ToolRuntime.registerDynamicTool` 增加 `options` 参数，使动态工具可以声明
`risk/parallelSafe/cancellable/requiresApproval`。

## 2. 规划模式（只读）

- `PermissionMode` 扩展为 `'plan' | 'ask' | 'risk' | 'full'`。
- `PermissionManager.authorize` 在 plan 模式下走白名单：只读工具直接放行，
  其余在**任何审批弹窗之前**拒绝，并写入审计行（`decision: deny`）。
- 只读白名单：`project_instructions`、`todo_write`、`ask_user`、`file_read`、
  `grep`、`glob`、`memory_get`、`web_search`、`browser_fetch`、`display_file`、
  `read_image`，以及 `desktop_control` 的只读动作（`list_windows`/`observe`/
  `frame`/`session_state`/`find_element`/`read_focused`/`wait`/`wait_change`）。
- UI：权限菜单新增「仅规划（只读）」，蓝色强调色；后端
  `normalizePermissionMode` 接受 `plan`，沿用现有设置持久化通道。

## 3. 上下文仪表

`ContextStatus` 本身已带 `compactThreshold`，此前只用于内部判断。现在：

- 环形进度中央显示百分比（`#contextProgressPercent`，7.5px，tabular-nums）。
- Tooltip 追加「自动压缩阈值 N%」，与 `usedTokens/contextWindow` 一起展示。
- `near-limit` / `exhausted` 状态下百分比跟随警告/错误色。

## 验证

| 项 | 结果 |
|---|---|
| `tests/image-tools.test.js` | **6/6**（格式嗅探、扩展名冲突、超限、越界、根内/根外链接） |
| `tests/plan-mode.test.js` | **5/5**（白名单、写工具拒绝、只读桌面动作、审计、ToolRuntime 集成） |
| 全量 | **575/575**（限并发） |
| 真实浏览器 | plan 选项存在、菜单可开、切换后 label=`仅规划（只读）`、`data-permission-mode=plan`、百分比元素可见（0%） |

截图：`workspace/tmp/batchb_plan_mode.png`。

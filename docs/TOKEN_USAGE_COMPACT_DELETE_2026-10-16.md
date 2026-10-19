# Token 用量页：紧凑卡片 + 记录删除（2026-10-16）

## 需求
1. 每张模型卡片改小，宽屏下一排可显示多张（不再单列大卡片）。
2. 用量记录可删除（单条 + 清空全部），避免历史记录永久堆积。

## 实现
### 前端（渲染层）
- `src/renderer/app.js`
  - `renderTokenUsage()`：卡片头部改为 `.token-usage-model-id` / `.token-usage-model-side` 双栏结构；右侧新增删除按钮（`data-ui-action="deleteTokenUsage"`，`data-ui-arg` 为记录 key）。
  - 统计格从 3 列（4 项换行留空）改为 4 列单行；渲染时同步切换「清空全部」按钮显隐（无记录时隐藏）。
  - 新增 `deleteTokenUsage(key)` / `clearTokenUsage()`：先走 `IexaDialogs.confirm` 确认，再调用 DELETE 接口并刷新。
  - `rendererActions` 注册两个新动作（沿用既有 `data-ui-action` 事件委托）。
- `src/renderer/index.html`：工具栏右侧新增「清空全部」按钮 `#tokenUsageClearAll`（默认 hidden）。
- `src/renderer/styles.css`
  - `.token-usage-list` 改为 `repeat(auto-fill, minmax(min(340px,100%),1fr))` 网格（宽屏两列，窄屏单列）。
  - 卡片整体紧凑化（内边距/字号/间距缩小；高度约 240px → 111px）。
  - 新增删除按钮与「清空全部」按钮样式；空状态占满整行。
  - `#view-token-calculator > .settings-container` 加宽到 `min(100%, 920px)`，为双列留出空间。

### 后端
- `src/main/server.ts`
  - `DELETE /api/token-usage`：清空全部记录（写空数组）。
  - `DELETE /api/token-usage/:key`：删除单条（key = `provider:model:profileId`，URL 编码传输）；非法编码返回 400 且不改动存储。
  - 移动端路由守卫（`routeAllowedForDevice`）：read-only 设备禁止对 `/api/token-usage` 做非 GET 操作。

### 测试
- 新增 `tests/token-usage-delete.test.js`：真实服务器 + HTTP 驱动两条删除路由（单条 / 清空 / 无效 key / 不存在 key no-op）。
- 扩充 `tests/message-usage-cache.test.js`：删除按钮标记、清空按钮显隐、动作注册与路由接线断言。

## 验证
- `npm run build` 通过；全量测试 **553/553**。
  - 首轮全量曾挂 `browser-session-concurrency`（既有负载型 flaky，断言点为 L81 会话切换竞态，与本次改动无关；单跑 3 次全过、重跑全量全绿）。
- 真实浏览器端到端检查（脚本：`workspace/tmp/tokenui_check.cjs`）：
  - 4 张卡片 432×111px，宽屏 **2 张/行**，4 个删除按钮，清空按钮可见；
  - 实际点击删除 → 确认框 → UI 4→3、API 3、磁盘文件 3；
  - 实际点击清空 → 确认框 → UI 0、文件 0、按钮自动隐藏。

## 生效方式
重启应用（`start-electron.bat` 启动时会先 `npm run build`；后端 dist 需重启进程，渲染文件随应用重启加载）。

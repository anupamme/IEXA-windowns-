# 批次 J — 侧栏拖拽卡顿（2026-10-19）

## 现象

拖动侧栏分隔条时整窗掉帧。用户截图里那条蓝色边就是 `.panel-resizer`
（`::before` 在 hover / 拖拽时展开为 3px accent 线）——它本身没有渲染问题，
问题是**每移动一次指针都会触发一次全文档样式重算**。

## 归因（逐项实测，真实工作区 34,822 个节点 / 23 条消息）

| 写入方式 | 单次耗时（中位数） |
|---|---|
| `:root` 上写 `--sidebar-width` | **129.6 ms** |
| `:root` + `@property` 类型化 | **127.1 ms**（没有帮助） |
| `.sidebar` 上写同名变量 | **14.5 ms** |
| `localStorage.setItem` | 0 ms |

`--sidebar-width` 是**继承**的自定义属性。写在 `:root` 上等于告诉浏览器
「整棵树的继承值都变了」，34,822 个节点全部重新解析样式。`@property` 注册成
`<length>` 也不行（127 ms），说明 Chrome 仍然要走完整的继承传播。

于是 240 次 `pointermove` ≈ 240 × 130 ms：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 样式重算总时长 | **23,319 ms** | **29 ms** |
| 布局总时长 | 2,708–3,054 ms | **78–83 ms** |
| 长任务总时长 | **30,916 ms** | **0** |
| > 32 ms 的帧 | 201 / 264 | **1 / 297** |
| 最差帧间隔 | 210 ms | **40 ms** |

## 四处改动

### 1. 变量作用域从 `:root` 收窄到面板（`app.js`）

`apply()` 现在把自定义属性写到 `.sidebar` / `.files-panel` 自身。变量仍然继承给
面板的子树（约 40 个节点），但不再惊动整个文档。

`readWidth()` / `currentAppearance()` 相应改为读面板的计算值；
`loadAppearanceSettings()` 通过新增的 `window.IexaPanelWidths` 钩子同步，
保证「启动设置 → 面板」单向一致，`:root` 只保留为样式表默认值。

### 2. 拖拽期间固定正文列宽度（`app.js`）

宽度变化会让每条消息重新折行；34k 节点的转录一次 reflow ≈ 13 ms，60fps 直接被吃掉。
按下时把 `#chatMessages` 的内联宽度锁在当前值，拖拽期间只动 `.sidebar`
（40 个节点），松手时一次性恢复。

单独验证：固定列后同样的 240 次移动，布局从 **3,054 ms → 57 ms**，
> 32ms 的帧从 **183 / 264 → 2 / 267**。

### 3. 指针事件合帧 + 只在松手时落盘（`app.js`）

- `pointermove` 用 `requestAnimationFrame` 合并，一帧最多一次写入。
- 拖拽中不再调用 `localStorage.setItem` 和 `scheduleAppearanceSave()`，
  松手时统一提交一次。
- 拖拽监听器移到 `window` 上并加 `blur` 兜底：即使浏览器取消 pointer capture
  （Alt-Tab、触摸中断、右键菜单），拖拽状态也不会卡住。

### 4. 去掉 `body.is-resizing *`（`styles.css`）

原来靠通配选择器 + `!important` 给整个文档设 `cursor: col-resize`，每次样式重算
都要拿这条选择器匹配 34k 个节点。改为一个全屏 `.panel-drag-shield`
（`position: fixed`），拖拽时插入、结束时隐藏——顺带也挡住了拖拽中的误选中。

## 验证

| 项 | 结果 |
|---|---|
| 新增测试 | `tests/panel-resize.test.js` |
| 断言 | 拖拽中 `:root` 变量不变、正文列保持宽度、松手只提交一次、双击复位、方向键 ±16、刷新后宽度恢复 |
| 反向验证 | 把 live 写入改回 `:root` → 测试失败（`drag must not write the inherited :root property`） |
| 全量回归 | **630 / 630** |
| 构建 | `npm run build` exit 0 |
| 视觉 | 拖拽中蓝色分隔线跟随光标，正文列裁切不重排；松手后一次性重排 |

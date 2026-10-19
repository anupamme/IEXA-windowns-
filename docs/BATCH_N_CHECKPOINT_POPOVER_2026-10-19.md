# 批次 N — 检查点面板：层级与视口（2026-10-19）

## 现象

检查点面板（`#checkpointPopover`）在部分区域点击会落到背后的侧栏 / 对话上。

## 归因（真实浏览器实测）

面板是 `position: absolute; right: 0; bottom: calc(100% + 10px)`，挂在
`.checkpoint-wrap` 里——也就是**输入区内部**。输入区自己是一个层叠上下文，
它的层叠顺序低于侧栏。

面板固定 360px 宽，右对齐到工具条按钮。窗口一窄，它就向左伸出输入区：

| 视口 | 面板 rect | 面板盒内 3px 网格扫描的漏点 |
|---|---|---|
| 900×600 | `l=16 t=198 360×340` | **13794 点中大量**落到 `#sidebar` / `.nav-btn` / `.search-box` |
| 1000×700 | `l=-23 t=298 360×340` | 左侧 **−23px 在视口外**，0–244 全在侧栏下面 |
| 1200×800 | `l=414 t=398` | 仅四角 16 点（圆角缺口） |

关键证据：900×600 时 `elementFromPoint(200, 400)` 返回 `#sidebar`，
而面板的可见部分就在那里——**面板被侧栏盖住**，点击自然落到侧栏按钮上。
1000×700 时面板左边还跑到了视口外（`l=-23`），根本点不到。

另外，批次 L 的保护用的是 `stopPropagation`。它在 document 捕获阶段能阻止事件
继续下探，但仍会放行**同一节点上后注册的捕获监听**；`stopImmediatePropagation`
才是完整做法。

## 修复

### 1. 移出输入区的层叠上下文（`app.js` + `styles.css`）

打开时把面板 `appendChild` 到 `<body>`，CSS 改为 `position: fixed`，
由 `positionCheckpointPopover()` 按按钮的 `getBoundingClientRect()` 计算位置：

- 右边缘对齐按钮，宽度 `min(360, 视口宽 - 16)`；
- 左右各留 8px，**永不越出视口**；
- 优先向上展开，上方空间不足则翻到下方；
- `renderCheckpoints()` 是异步的，列表高度只有渲染完才确定，所以 `.then()` 里重新定位；
- `resize` 时若面板开着，重新定位。

`z-index: 1200`，高于侧栏与输入区。

### 2. 外部点击判定跟着改（`app.js`）

关闭监听原本判断 `event.target.closest('.checkpoint-wrap')`。面板被 portal 到
body 后不再命中外层，若不改，**点面板内部任意位置都会把它关掉**。
改为 `.checkpoint-wrap, #checkpointPopover`。

### 3. 保护升级（`app.js`）

`installPopoverHitGuard` 现在：
- 覆盖 `pointerdown / mousedown / pointerup / mouseup / click / dblclick / auxclick / contextmenu`；
- 用 `preventDefault + stopImmediatePropagation`。

## 验证

`tests/checkpoint-popover.test.js`（真实 Chromium，900×600 / 1200×800 / 560×700 三档）：

| 断言 | 结果 |
|---|---|
| `position: fixed` 且父节点是 `<body>` | ✅ |
| 面板四边都在视口内（留 8px） | ✅ |
| 按圆角形状分类的 3px 网格（>2000 点）**零漏点** | ✅ |
| 圆角处真实点击：背后元素收到 **0** 次点击 | ✅ |
| 圆角处真实点击：面板保持打开 | ✅ |
| 圆角处真实点击：导航视图未切换 | ✅ |
| 点面板内「刷新」不会关闭面板 | ✅ |
| 面板外点击仍能正常关闭 | ✅ |
| 全程无渲染异常 | ✅ |

反向验证（`workspace/tmp/verify-checkpoint.cjs`）：

| 回退项 | 失败信息 |
|---|---|
| 去掉 portal | `900x600: the panel must be portalled out of the composer` |
| 去掉视口夹紧 | `560x700: panel starts at -62, outside the margin` |
| 关掉命中保护 | `900x600: a corner click reached nav-btn behind the panel` |
| 外部点击判定只认 `.checkpoint-wrap` | `900x600: clicking inside the panel closed it` |

批次 L 的 `tests/popover-surface.test.js` 同步复验通过（保护逻辑改动后仍成立）。

全量回归 **634 / 634**，`npm run build` exit 0。

## 截图

`workspace/tmp/checkpoint-fixed.png` — 900×600：面板整体浮在侧栏之上，
`elementFromPoint` 中心返回面板本身，四边完整在视口内。

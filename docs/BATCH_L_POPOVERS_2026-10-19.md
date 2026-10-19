# 批次 L — 输入区浮层：不透明与全框命中（2026-10-19）

## 现象

模型选择器与上下文压缩两个下拉面板：有时看不清（文字与背景糊在一起，
面板边界要仔细看才找得到），并且在面板边缘点击会落到背后的聊天内容上。

## 归因（真实浏览器实测）

两个菜单共用同一条浮层规则：

```css
background: color-mix(in srgb, var(--mac-surface-solid) 88%, transparent);
border-color: var(--mac-hairline);
backdrop-filter: saturate(140%) blur(22px);
```

### 1. 看不清

88% 不透明意味着 12% 的底层内容直接透上来，再叠 22px 背景模糊。
深色主题下面板名义色 `#232326`，与页面 `#1c1c1f` 混合后实际渲染约 `#2a2a2d`：

| | 值 |
|---|---|
| 面板实际填充 vs 页面 | **1.19 : 1** |
| 描边（`--border` #303034）vs 页面 | 1.44 : 1 |
| 面板 alpha | **0.88**（Chromium 实测 `color(srgb 0.137 0.137 0.149 / 0.88)`）|
| backdrop-filter | `saturate(1.4) blur(22px)` |

对比度 1.19:1 意味着面板和页面几乎同色，边界完全依赖一层很淡的阴影；
背后的消息、文件行、附件缩略图会直接映在面板上。这就是"有时候看不清楚"。

### 2. 点到背后

浮层是圆角矩形。圆角缺口里的像素**在边界盒内、但不属于元素命中区域**：

- 3px 网格扫描模型菜单 7740 个点，**9 个点**返回 `#chatMessages` / `.welcome`；
- 上下文菜单 7227 个点，**6 个点**返回 `#chatMessages` / `.quick-btn` / `#modelBar`；
- 用 `Input.dispatchMouseEvent` 在左上角缺口真实点击，`#chatMessages` 的
  pointerdown + click 都收到了事件 → 点击确实落到了背后。

9 个点看着不多，但四个角正好压在快捷操作按钮、输入框和消息列表上，
用户看到的是"面板的一部分"，点下去却触发了背后的控件。

## 修复

### 1. 不透明浮层（`workbench.css` + `styles.css`）

新增三枚浮层令牌，跟随主题：

| 令牌 | 浅色 | 深色 |
|---|---|---|
| `--popover-bg` | `#fff` | `#2c2c31` |
| `--popover-border` | `#d9d9df` | `#4a4a52` |
| `--popover-shadow` | `0 14px 36px #0f172a1f, 0 3px 10px #0f172a12` | `0 18px 44px #00000073, 0 3px 10px #00000059` |

共用规则改为 100% 不透明的 `var(--popover-bg)`，描边改用 `--popover-border`，
并**移除 backdrop-filter**（背景不透明后模糊已不可见，只白付 GPU）。
非工作台皮肤回退到 `--mac-surface-solid`（本身也是实色）。

结果：深色面板 vs 页面 1.19 → **2.6 : 1**，描边 1.44 → **1.98 : 1**，
标题文字 vs 面板 **11 : 1**（浅色 15 : 1）。

### 2. 全框命中保护（`app.js`）

`installPopoverHitGuard()` 在 document 捕获阶段拦截 `pointerdown` / `click`：
若指针落在任一**已打开**浮层的边界盒内、但事件目标不在浮层内（即圆角缺口），
`preventDefault + stopPropagation` 吞掉事件。面板范围内点击再也不会作用到背后。

覆盖 `.model-selector-menu`、`.thinking-level-menu`、`.context-compaction-menu`、
`.permission-mode-menu`、`.files-context-menu`、`.text-context-menu`、
`.slash-menu`、`.checkpoint-popover`。浮层关闭时 `getClientRects()` 为空，直接跳过。

## 验证

`tests/popover-surface.test.js`（真实浏览器，深色 + 浅色 × 模型/上下文/权限三个菜单）：

- `backgroundColor` alpha **必须为 1**
- `backdrop-filter` **必须为 none**
- 描边 ≥ 1px，且描边 vs 页面对比度 ≥ 1.3:1
- 标题文字 vs 面板对比度 ≥ 4.5:1
- 距边 16px 内缩的 5px 网格，**每一个点**最上层元素都属于面板
- **控制组**：面板外点击聊天区 → `#chatMessages` 收到 2 次事件（证明探针有效）
- **角点点击**：`(left+2, top+2)` 实测命中 `#chatMessages`（证明确实是缺口），
  真实点击后 `#chatMessages` **0 次**、面板保持打开
- 真实点击选项中心 → 事件目标在面板内

反向验证（脚本 `workspace/tmp/verify-popover.cjs`，替换后断言文本确实变化）：

| 回退项 | 失败信息 |
|---|---|
| 换回 88% 半透明 + backdrop-filter | `#modelSelectorMenu (dark): popover is translucent (alpha 0.88)` |
| 注释掉 `installPopoverHitGuard()` | `corner click reached the transcript (chatMessages)` |

全量回归 **632 / 632**，`npm run build` exit 0。

## 备注

`--popover-*` 只作用于真正的浮层。输入区（`.chat-input-area`）本身仍是半透明毛玻璃，
这是设计意图，且它不覆盖可读内容，故未改动。

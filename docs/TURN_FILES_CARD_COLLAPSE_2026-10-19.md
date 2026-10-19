# 本轮文件修改卡片：补上折叠（2026-10-19）

## 原来的设计

卡片结构是固定的三段：

```
[图标] 已编辑 7 个文件                 +3 −16
  文件行 × N
  ─────────────────────────────
  状态   [撤销] [审查]
  （差异详情，默认隐藏）
```

表头是普通 `div`，没有交互。只有「审查」按钮能展开/收起下面的差异块，**文件列表本身没有任何收起方式**。一次改动 7 个文件就占掉大半屏，而且一旦出现在历史里就永远展开着。

## 改法

表头改成真正的 disclosure 按钮：

- `button.turn-deliverables-heading`，带 `aria-expanded` 与 `aria-controls`；
- 点击折叠/展开文件列表与差异块，右侧箭头旋转（下 → 右）；
- **操作行（撤销 / 审查）不隐藏**，折叠后仍然可以撤销；
- 「审查」按钮文字随状态切换：展开差异时为「收起」，关闭时为「审查」；
- 在折叠状态下点「审查」或某个文件行，会先展开卡片再显示对应差异；
- 折叠时若差异是打开的，一并关闭，避免下次展开时残留半屏内容；
- 状态记在消息元素上（`_deliverablesCollapsed`），流式重渲染不会把用户刚收起的卡片又弹开。

结构变成：

```
<button class="turn-deliverables-heading">   ← 折叠开关
   图标  已编辑 N 个文件   +a −d   ⌄
</button>
<div class="turn-deliverables-body">          ← 折叠目标
   文件行 × N
   差异详情
</div>
<div class="turn-change-actions">             ← 始终可见
   状态  [撤销] [审查]
</div>
```

## 样式

```css
.turn-deliverables-heading{width:100%;border:0;background:transparent;text-align:left;cursor:pointer}
.turn-deliverables-heading:hover{background:var(--bg-hover)}
.turn-deliverables-chevron{transform:rotate(45deg);transition:transform .18s ease;opacity:.55}
.turn-deliverables.is-collapsed .turn-deliverables-chevron{transform:rotate(-45deg)}
.turn-deliverables.is-collapsed .turn-deliverables-body{display:none}
```

箭头用两条边框拼成，不依赖图标集；`focus-visible` 有独立描边。

## 验证

`tests/browser-file-delivery.test.js` 增加 9 条断言（真实 Chromium，1175×839）：

| 断言 | 结果 |
|---|---|
| 表头是 `BUTTON`，初始 `aria-expanded=true` | ✅ |
| 点击后卡片带 `is-collapsed`、`aria-expanded=false` | ✅ |
| 折叠后 `.turn-deliverables-body` 计算样式为 `display:none` | ✅ |
| 折叠后「撤销」仍在布局中（`offsetParent !== null`） | ✅ |
| 折叠后整卡高度 < 110px | ✅ |
| 再次点击恢复，文件行仍为 2 | ✅ |
| 差异展开时折叠卡片 → 差异同步关闭，「审查」文字变回「审查」 | ✅ |
| 折叠状态下点「审查」→ 卡片展开且差异显示 | ✅ |
| 全程无渲染异常 | ✅ |

截图：`.iexa-artifacts/plan-20260917-ui-review/file-summary-collapsed.png`（折叠，卡片约 90px 高）
与 `file-summary-dark.png`（展开）。

全量回归 **642 / 642**，`npm run build` exit 0。

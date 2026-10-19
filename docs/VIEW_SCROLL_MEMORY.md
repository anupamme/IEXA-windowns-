# 视图切换后的滚动位置

## 现象

从设置、技能、任务中心切回「对话」，消息区每次都停在**第一条对话消息**，而不是刚才看到的位置。
滚到底再切走切回也一样。

## 原因

`d268ef4`（渲染性能修复）把非活动视图从 `display: none` 改成了保活方案：

```css
.view { position:absolute; top:0; left:0; width:0; height:0; content-visibility:hidden; }
```

目的很明确——`display:none` 会丢弃整个子树的计算样式，切回 6.8 万节点要重算 ~160ms 样式 +
~100ms 布局。保活方案把这段开销砍到 35ms + 62ms。

副作用是：**零高度意味着聊天区没有可滚动溢出的内容**，浏览器于是把 `scrollTop` 钳到 0。
实测（真实 Chromium，60 条夹具）：

```
隐藏前    {"top":11643,"client":672,"height":12315,"gap":0}
隐藏中    {"top":0,"client":160171,"height":160171}      ← 盒子塌缩
切回来    {"top":0,"gap":11643}                          ← 停在第一条
```

`display:none` 反而没有这个问题：元素不参与布局，浏览器会原样保留它的 `scrollTop`。
所以这是保活改动的回归，不是滚动逻辑本身坏了。

## 修法

离开聊天视图前记下两件事，回来后在下一帧还原：

```js
chatViewScrollMemory = {
  sessionId: currentSessionId,
  top: visibleChatMessages.scrollTop,
  atBottom: isChatNearBottom(),   // 跟读最新 vs 停在历史中间
};
```

- `atBottom` 为真 → 回来时 `scrollToBottom(true)`，隐藏期间新到的消息也能跟随
- 否则 → 精确还原 `scrollTop`，并把 `isNearChatBottom` 重算回 false
- `sessionId` 校验 → 在设置页里切到别的会话，旧偏移不会串到新会话
- 恢复走一层 `requestAnimationFrame`，等视图重新拿到几何

另外给 `scroll` 监听加了保护：视图非激活时直接 return。隐藏期间浏览器钳位会触发一次
`scroll` 事件，那不是用户滚动，放过去会把「停在历史中间」误标成「跟读最新」。

## 验证

`tests/browser-view-scroll.test.js`（真实 Chromium，60 条夹具）：

1. 滚到底 → 切设置 → 切回：`gap < 4`，不是 `top 0`
2. 停在 900px → 切走切回：`top` 精确回到 900，`isNearChatBottom === false`
3. 跟读状态下切走 → 隐藏期间 `addMessage()` 追加消息 → 切回：仍在底部
4. 停在中段 → 切到设置 → 切到另一个会话 → 切回：不还原旧偏移（`top 0`，消息数是新会话的）

全量 **660 / 660**。视图保活带来的性能收益不变（`browser-render-performance` 仍通过）。

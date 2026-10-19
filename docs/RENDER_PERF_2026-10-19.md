# 消息发送与页面切换卡顿：定位与修复（2026-10-19）

## 结论先说

三处独立卡顿，全部与「消息条数」无关，只与**当前会话体积**有关。用户当时打开的就是
`sess_1792142888675`：57 条消息、22.7 MB、1,700+ 次工具调用，渲染成 67,925 个 DOM 节点、
1,509 个工具块、5,317 个 `<pre>`、转录高度 164,656px。

| 场景 | 修复前最长单帧 | 修复后最长单帧 |
|---|---|---|
| 冷切进入该会话 | 1,310 ms | 290 ms |
| 回合结束后元数据同步 | 850 ms | 10 ms（0 次重建） |
| settings → chat | 430 ms | 150 ms |
| 发送单条消息 | 10 ms | 10 ms（本来就好） |
| 流式输出 90 批 @33ms | 20 ms | 30 ms（本来就好） |

## 一、切换会话：单帧冻结 1.3 秒

`switchSession()` 拿到历史后 `clearChat()`，然后**在一个同步循环里**把全部消息
`addMessage()` 进活文档，中间不交还主线程。浏览器要一次性布局 6.8 万节点，那一帧被占满。

改法：渲染循环按**时间预算分帧**，一批超过 8ms 就 `await requestAnimationFrame`，让出后
继续；同时保留 `viewEpoch` 取消语义（切换被抢占时把 `historyReady` 复位，避免留下半截
转录）。

```js
let batchStartedAt = performance.now();
for (let messageIndex = 0; messageIndex < msgs.length; messageIndex++) {
  if (performance.now() - batchStartedAt > 8) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    if (viewEpoch !== sessionViewEpoch || visibleSessionId !== id) {
      targetRuntime.historyReady = false;
      return;
    }
    batchStartedAt = performance.now();
  }
  ...
}
```

预算调到 4ms 反而更差（310ms），因为长帧来自单条巨型消息的 Markdown 解析，不是批量大小，
所以保留 8ms。

## 二、发送后整块重建：850 毫秒

`handleDone()` → `syncConversationMetadata()`，只要服务端在该会话上报告了变化，就会
`refreshCurrentSessionHistory()` → `reloadSessionView()`，把 runtime 整个删掉、重新拉一遍
22.7 MB JSON、重新渲染全部消息。

原来靠 `protectLiveTurnDom()` 的 **5 秒时间窗**挡着。实测：

- 窗口内同步 → 10ms ✅
- 窗口过期后同步 → 820ms ❌

而服务端常在 `done` 事件之后才落盘（工具结果、turn 摘要），5 秒挡不住。

改法：**用内容比对代替时间窗**。DOM 里已有的消息条数与 store 的 `messageCount` 一致，就说明
转录已经是权威的，直接跳过重建：

```js
const storeCount = nextSessions.find(s => s.id === currentSessionId)?.messageCount;
const domMatchesStore = Number.isInteger(storeCount) && storeCount === countRenderedMessages(currentSessionId);
...
} else if (liveDomOwned || (!forceCurrentRefresh && domMatchesStore)) {
  // keep the live DOM
}
```

真发生变化（追加/分支重置）条数就对不上，仍会刷新。强制刷新（跨设备同步等）不受影响。

## 三、切换页面：431 毫秒

`.view { display: none }` 会**丢弃整个子树的计算样式**。从设置切回聊天时，6.8 万节点要全部
重新算样式再重新布局。实测拆分：

```
settings → chat   布局 104ms + 样式 159ms = 任务 431ms
```

改法：视图保持挂载，用 `content-visibility: hidden` 跳过布局与绘制，同时把非活动视图
做成零尺寸盒子，避免它接管点击与悬停：

```css
.view { display:flex; flex:1; overflow:hidden; position:absolute; top:0; left:0; width:0; height:0; content-visibility:hidden; }
.view.active { position:relative; width:auto; height:auto; content-visibility:visible; }
```

```
settings → chat   布局 62ms + 样式 35ms = 任务 175ms
```

中途试过两条弯路，都实测否掉了：

- `content-visibility: hidden` 但保留 `inset: 0` 满尺寸 → 元素盒子仍在，**吞掉点击和悬停**，
  5 个真实浏览器用例失败（popover 打不开、lightbox 打不开、hover 态不生效）。
- 改用 `visibility: hidden` → 它是继承属性，切换时子树照样要重算，样式重算回到 153ms，
  而且 `chat → settings` 也变成 150ms（原本 42ms），净亏。
- 加 `inert` 属性修好点击，但 `inert` 切换本身又带来 ~140ms 重算。

## 四、`content-visibility: auto` 被否掉

`.message` 上开 `content-visibility: auto` 一开始看着很美（冷切 1220ms → 450ms），但那是
因为消息已经渲染过一次、尺寸被记住了。分帧渲染落地后 A/B 实测：

| | 最差单帧 | 冷切后 scrollHeight | 滚到顶后 |
|---|---|---|---|
| `auto` | 280 ms | 4,581 px | 9,575 px（涨 4,994） |
| `visible` | 280 ms | 164,656 px | 164,656 px（不变） |

分帧之后它不再省帧，却把滚动条高度估成真实值的 1/36，向上滚动时不断增长。**保留真实几何**，
规则改回 `visible` 并写清原因。

## 五、顺带修掉的初始化误写入

`normalize()` 在启动时调用 `apply(..., persist=true)`，把刚从 localStorage 读出来的默认值
又写回去，和首次拖拽抢时序，导致 `panel-resize` 用例约 15% 概率报
`nothing is persisted mid-drag`。改成初始化/窗口 resize 只应用、不持久化，6/6 稳定。

## 验证

新增 `tests/browser-render-performance.test.js`（真实 Chromium，可移植夹具）：

- 40 条消息的转录必须跨帧绘制，且至少有一帧是**部分渲染**（证明不再单帧阻塞）
- 切完 `atBottom`，消息数正确
- 条数一致时元数据同步 **不调用** `reloadSessionView`
- 真追加消息后必须刷新（防止比对把真变化挡掉）
- 切到设置再切回：`#view-chat` 的 `content-visibility` 随之切换、非活动时宽度为 0、
  返回后 `elementFromPoint` 命中的仍是 `view-chat`（不被兄弟视图遮挡）

真实 23MB 会话复测：冷切 `atBottom: true`、`scrollHeight 164,656`（几何真实），
流式 30ms、滚动 10ms，全程无 >50ms 帧。

全量 **643 / 643**，`npm run build` exit 0。

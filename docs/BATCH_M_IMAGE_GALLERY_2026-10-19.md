# 批次 M — 图片预览图廊：多图切换 + 缩放（2026-10-19）

## 需求

同一会话里出现多张图片时，希望能在预览里左右切换，并且可以放大缩小看细节。

## 原状

```js
function openImagePreview(src, name) {
  imagePreviewImage.src = src;   // 一次只装一张
  ...
}
```

灯箱只有一个 `<img>`，看下一张必须关掉、回到对话、再点下一个缩略图。
`openImagePreview` 有四个调用点（用户附件、工具内联图、`display_file` 产物图、
正文 markdown 图），各自把 `src` 和名字传进来，彼此不知道对方存在。

## 实现

### 1. 会话级图廊（`app.js`）

打开任意一张图时，按 **DOM 顺序** 扫描当前会话：

```js
const IMAGE_PREVIEW_HOSTS =
  '.message-image-attach, .tool-result-image, .tool-artifact-image, .message-content';
```

四个调用点改为把**被点击的 `<img>` 元素**一起传进去（第三个参数），
于是 `openImagePreview` 能用元素身份精确定位当前是第几张，
而不是靠 `src` 字符串比较（同一张图可能在会话里出现两次）。

被扫描的图片会过滤掉 32px 以下的（markdown 里的小图标不该进胶片条）。

### 2. 切换

| 入口 | 行为 |
|---|---|
| 左右箭头按钮 | 上一张 / 下一张，**首尾循环** |
| `←` / `→` | 同上 |
| `Home` / `End` | 跳到第一张 / 最后一张 |
| 底部胶片条 | 点击任意缩略图直接跳转，当前项描边高亮并自动滚入视野 |

计数徽标 `2 / 3` 常驻标题栏；只有一张图时计数、箭头、胶片条全部隐藏
（`hidden` + `:disabled { display: none }`），不显示成灰掉的死按钮。

相邻图片在切换时预加载（`new Image()`），快速连按不会闪白。

### 3. 缩放

| 操作 | 行为 |
|---|---|
| 滚轮 / 触控板捏合 | 以**光标位置为锚点**缩放，1×–8× |
| `+` / `=` / `↑` | 放大 1.25× |
| `-` / `_` / `↓` | 缩小 1.25× |
| `0` | 回到适应窗口 |
| 双击 / 双击触屏 | 1× ⇄ 2.5× |
| 拖动 | 放大后平移，边界自动夹紧，不会把图拖出视野 |

标题栏中间的百分比按钮显示当前倍率，点击即复位。
缩放用 `transform: translate() scale()`（合成器友好，不触发重排），
平移边界按 `offsetWidth/offsetHeight × zoom` 与舞台尺寸实时计算。

`touch-action: none` 阻止浏览器把手势当成页面滚动。

### 4. 手势状态兜底

`pointerup` 同时挂在 `window` 和 `blur` 上：即使指针在窗口外抬起、
或浏览器取消了 pointer capture，`is-panning` 状态也不会卡住
（沿用批次 J 的教训）。

## 验证

`tests/image-gallery.test.js`（真实 Chromium，3 张 1600×1200 SVG + 单图会话）：

| 断言 | 结果 |
|---|---|
| 真实点击缩略图打开，计数 `1 / 3` | ✅ |
| 胶片条 3 项，激活项跟随 | ✅ |
| `→` 前进、`←` 后退 | ✅ |
| 首张按上一张 → `3 / 3`（循环） | ✅ |
| 滚轮缩放 scale > 1.2，标签同步 | ✅ |
| 缩放以光标为锚点（translate ≠ 0） | ✅ |
| 拖拽平移改变 translate，松手清除 `is-panning` | ✅ |
| 复位回 1× 且 `transform` 被清空 | ✅ |
| `-` 在 1× 时禁用 | ✅ |
| 胶片条跳转并重置缩放 | ✅ |
| `Esc` 关闭并**把焦点还给缩略图** | ✅ |
| 单图会话：计数/胶片条/箭头全部隐藏 | ✅ |
| 全程无渲染异常 | ✅ |

反向验证（`workspace/tmp/verify-gallery.cjs`，逐项破坏并断言文本确实变化）：

| 回退项 | 失败信息 |
|---|---|
| `collectConversationImages` 恒返回 null | `counter starts on the clicked image` |
| 删除 wheel 监听 | `wheel should zoom in (scale 1)` |
| `ArrowRight` 分支置空 | `ArrowRight advances` |
| 平移只写回原坐标 | `dragging should pan the zoomed image` |

全量回归 **633 / 633**，`npm run build` exit 0。

## 截图

- `workspace/tmp/gallery-fit.png` — 第 2/3 张，适应窗口，胶片条高亮
- `workspace/tmp/gallery-zoom.png` — 252%，光标锚点放大后平移

# 批次 O — HTML 预览改成实时渲染窗口（2026-10-19）

## 需求

HTML 预览要像 WorkBuddy 那样，是一个**会自己更新**的渲染窗口，而不是一次性截图。

## 原状

| 现状 | 问题 |
|---|---|
| `openHtmlPreview` 只设置一次 `iframe.src` | 文件改了要手动点刷新 |
| 全屏模态遮罩 + `backdrop-filter` | 预览时看不到对话，也没法一边让 agent 改一边看 |
| 单一 iframe | 重载瞬间会白屏一下 |
| 没有运行时通道 | 无法知道预览页滚到哪、有没有脚本报错 |

## 实现

### 1. 服务端：变更探测 + 运行时注入（`src/main/server.ts`）

**`GET /api/fs/preview-stat/:scope/:path`** → `{ exists, mtimeMs, size }`

只做 `stat`，不读文件。渲染层用它判断"要不要重载"，20 MB 的页面不会为了发现没变化而重新下载。

**运行时注入**：`?iexa_runtime=1` 时，在文档里注入一段 `<script data-iexa-runtime>`：

- `scroll`（rAF 合并）→ 回报滚动位置；
- `error` / `unhandledrejection` → 回报脚本错误；
- 监听父页面的 `scroll` / `report` 命令。

注入点选在 `<meta charset>` 与 `<head>` **之后、页面自身脚本之前**——错误监听必须早于会抛错的脚本；同时不能把 charset 声明挤出前 1024 字节的编码嗅探窗口。

**只对 UTF-8 文档注入**：注入意味着按 UTF-8 重编码并改写 `Content-Length`。若文档声明了非 UTF-8（如 GBK），或没有声明且含非 ASCII 字节，就**原样流式返回**。这类页面只是没有滚动/错误通道，字节绝不被改写。

### 2. 非模态浮窗（`index.html` + `styles.css`）

- 遮罩层 `pointer-events: none`、无背景、无 backdrop-filter：**窗口之外照常点击对话**；`aria-modal` 移除，改为普通 `role="dialog"`；
- 窗口 `position: fixed`、`z-index: 2400`、`pointer-events: auto`；
- 标题栏可拖动，双击复位居中；右下角保留原生 `resize` 把手；
- 位置与尺寸存 `localStorage`，每次打开按当前视口夹紧（8px 边距）；
- 拖拽时给窗口加 `.is-dragging`，把 iframe 的命中测试关掉——**iframe 是独立文档，光标移进去就会吞掉 pointermove**，不关的话拖动在离开标题栏 43px 后就断。

### 3. 双缓冲渲染（`app.js`）

两个 iframe 交替：

```
隐藏帧加载新文档 → load 事件 → 回报滚动位置 → 60ms 后交换 is-active
```

- 旧帧在新帧就绪前一直可见，**不闪白**；
- 交换前把旧文档的 `scrollY` 发给新帧（此时它还透明），**更新不跳回顶部**；
- 相邻两次写入用 180ms 去抖合并，一轮里改十个文件只渲染一次；
- 加载中再有变更只记 `queued`，当前渲染完成后再补一次。

### 4. 交互与状态

| 控件 | 行为 |
|---|---|
| 工具栏「实时」 | 开关自动重渲染，偏好持久化；暂停时手动刷新仍可用 |
| 状态栏 | `预览已就绪` / `已更新 17:31:05` / `文件已删除，显示上次渲染` / `实时已暂停` |
| 错误徽标 | `1 个脚本错误`（红色，hover 看详情），左侧状态点同步变红 |
| `Esc` | 关闭并把焦点还给打开前的元素 |

### 5. 轮询而不是文件监听

文件可能被 agent 工具、外部编辑器、git、构建脚本改写。`fs.watch` 需要把这些来源全部接进一条链路，还会有重命名/编辑器原子写导致的丢事件；本机 `stat` 每 700 ms 一次开销可以忽略，且对"谁写的"完全无感。

## 验证

`tests/html-preview-live.test.js`（真实 Chromium，重写磁盘文件驱动）：

| 断言 | 结果 |
|---|---|
| 不带参数时预览**逐字节**返回原文件 | ✅ |
| 带 `iexa_runtime=1` 时含运行时 | ✅ |
| 非 UTF-8（GBK）文档即使带参数也**逐字节不变** | ✅ |
| 首次渲染 v1 | ✅ |
| 改写文件后自动渲染 v2，状态含「已更新」 | ✅ |
| 两个 iframe、恰好一个 `is-active` | ✅ |
| 交换过程中活动帧数**从不为 0**（不闪白） | ✅ |
| 重载后滚动位置保持 ≥600px | ✅ |
| v3 抛错 → `1 个脚本错误` 徽标 | ✅ |
| 暂停实时 → 2.6s 内不自动重载 | ✅ |
| 暂停下手动刷新仍生效 | ✅ |
| 拖动标题栏移动 ≥100px 且几何写入 localStorage | ✅ |
| 窗口外点击不被遮罩拦截 | ✅ |
| `Esc` 关闭 | ✅ |
| 渲染层全程无异常 | ✅ |

反向验证（`workspace/tmp/verify-live-preview.cjs`，逐项破坏并断言测试确实变红）：

| 回退项 | 失败信息 |
|---|---|
| 去掉去抖后的重载调用 | `timed out waiting for live re-render` |
| 去掉滚动恢复命令 | `a live update must keep the reader's scroll position` |
| 关掉运行时注入 | `the live preview must carry the runtime channel` |
| 遮罩恢复 `pointer-events: auto` | `the preview overlay must not intercept the app` |

全量回归 **635 / 635**，`npm run build` exit 0。


## 备注

- 预览仍然受 `sandbox allow-scripts`（无 `allow-same-origin`）+ `connect-src 'none'` 约束，运行时只能 `postMessage`，拿不到父页面任何东西。
- 自动**打开**预览（agent 产出 HTML 就弹窗）没有做——那属于会话行为，会和用户正在看的页面抢位置。

# 批次 H — 存储与检索性能（2026-10-19）

## 背景

成熟度审查列出两项「不成熟项」：会话检索每次都要解析整份 transcript，
持久化备份每次保存都要复制一遍负载。实测数据说明了问题的量级：

| 项目 | 实测 |
|---|---|
| 会话总数 | 12 |
| 会话总体积 | **39.0 MB** |
| 最大单会话 | **37.4 MB**（19 条消息，其中 1 条含 388 个工具调用） |
| 该会话可检索正文 | 约 37 KB |
| 旧搜索路径单次成本 | **123 ms**（read 75 ms + parse 47 ms）+ 全量 `toLowerCase` |
| 旧保存路径备份成本 | 与负载等量的 `copyFile`，最大会话每次约 37 MB |

结论：搜索成本与「工具输出体积」成正比，而工具输出根本不参与搜索；
备份成本与「负载体积」成正比，而硬链接可以做到 O(1)。

## 1. 备份改为硬链接（`src/main/persistence/JsonStore.ts`）

- 新增 `backupByLink` / `backupByLinkSync`，阈值 **1 MiB**：
  - ≥ 1 MiB：`link()` 建硬链接；文件系统不支持（FAT/exFAT、跨卷）时回退 `copyFile`。
  - < 1 MiB：直接复制。小文件复制成本可忽略，且能免疫「就地写入」。
- 语义约束写进注释：**调用方必须用「临时文件 + rename」替换，不能就地覆写**，
  否则硬链接会让 `.bak` 同时变化。`JsonStore` 与 `writeTextAtomic` 都满足该约束。
- 顺带修复：写失败时清理临时文件，避免残留 `.tmp`。

## 2. 会话检索索引（`src/main/search/SessionSearchIndex.ts`）

设计取舍：**不引入数据库**。索引按会话存为单文件 JSON，只保留
`[消息序号, 角色, 时间戳, 正文]`，工具调用、rollback、thinking 全部丢弃。

- 失效判断：`size:mtimeMs` 指纹 + 标题；未变化直接跳过（`skipped`）。
- 版本号 `v: 1`：记录结构变化时旧索引自然失效并重建，无需迁移脚本。
- 查询：按空白分词、支持引号短语、多词 AND、大小写不敏感；中文按子串匹配
  （不使用 FTS5 trigram，因为 trigram 需要 ≥3 字符，2 字中文查询会失效）。
- 损坏容忍：单条记录解析失败只影响该会话，下次 sync 重建。
- 安全：会话 id 必须匹配 `[A-Za-z0-9_-]{1,128}`，与 `SessionManager` 一致。
- 服务端接线（`server.ts`）：`/api/search` 先走索引；索引异常时回退到原有线性扫描，
  响应新增 `tookMs` 与每条 `matches[].index/timestamp`（向后兼容的增量字段）。

### 实测（真实工作区，39 MB）

| 指标 | 结果 |
|---|---|
| 首次建索引 | **138 ms**（39 MB 读入 + 提取） |
| 后续搜索 | **0–1 ms** |
| 无变化 re-sync | **0 ms**（2/2 skipped） |
| 索引体积 | **77.7 KB**，占源体积 **0.195%** |
| 端到端 `/api/search` | 首次 3 ms，后续 1 ms |

## 3. 搜索结果跳转（渲染层）

- 每条命中片段现在带 `data-ui-action="openSearchHit"` 与 `会话id:消息序号`。
- `openSearchHit()`：切换会话 → 轮询等待 `.message[data-message-index]` 出现
  （最多 4 s）→ 居中滚动 → 播放 2.2 s 高亮。
- 标题命中（`index = -1`）保持原行为：只切会话。
- 支持键盘：片段可聚焦，Enter/Space 触发跳转。
- 遵循 `prefers-reduced-motion`：关闭动画，仅保留描边。

## 4. 已尝试并回滚：渲染层拆分

原计划把 `app.js`（8595 行）按章节拆成 6 个顺序加载的 classic script。
按行号切分后浏览器实测出现：

```
ReferenceError: stopProcessing is not defined
  at app.chat.js:76
```

原因：**函数声明只在同一脚本内提升**。单文件时 `stopProcessing` 在
`app.chat.js` 顶层注册监听器时已提升可用；跨脚本后该函数尚未定义。

这不是边界选错就能修好的个别问题：classic script 之间只共享全局词法环境，
不共享提升。可行的替代方案是「AST 抽取顶层语句到 boot 函数」或引入打包器，
两者都会改变现有零构建的渲染层管线。

决策：**回滚拆分**，保留单文件，并把该约束记录在此，避免后续重复踩坑。
本批次不交付有语义风险的重构。

## 验证

| 项 | 结果 |
|---|---|
| 新增测试 | `json-store-backup` 8、`session-search-index` 10、`search-api` 4、`browser-search-jump` 1 |
| 真实浏览器 | 搜索 → 命中片段 → 跳转 → 高亮，消息序号与内容均匹配，零渲染异常 |
| 全量回归 | **628 / 628** |
| 构建 | `npm run build` exit 0 |

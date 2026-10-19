# 批次 P — 撤销快照移出会话文件（2026-10-19）

## 现象

单个会话 `sess_1792142888675.json` 长到 **82.8 MB**，同目录还有一份等大的 `.bak`。项目从 2.6 GB 清到 1.2 GB 后，运行一段时间又会长回去——因为应用每次保存都把整份会话复制一次。

## 归因

一开始以为是图片，实测不是。JSON 里 217 个超过 50 KB 的字符串，**204 个是 `toolCalls[].result.fileChange.rollback.beforeBase64`**：

```
0.54 MB  $[33].toolCalls[114].result.fileChange.rollback.beforeBase64
0.54 MB  $[33].toolCalls[81].result.fileChange.rollback.beforeBase64
...
```

共 **315 个撤销快照**，解码后 46.3 MB，base64 编码后约 62 MB。每次 `edit_file` 都把被改文件的**完整旧内容**存进消息，用来支撑「撤销这一轮」。编辑越多次，会话越大，且每次保存都整份复制。

## 修复

### 1. 内容寻址的快照存储（`src/main/session/RollbackStore.ts`）

- 保存时遍历消息，把 `rollback.beforeBase64` 解码 → gzip → 写到
  `workspace/.iexa-sessions/rollbacks/<sha256>.bin.gz`；
- 消息里只留 `{ version, beforeExists, beforeRef, afterSha256 }`；
- 同一内容只落一个文件（sha256 命名，天然去重）；
- 写入用「临时文件 + rename」，两个进程同时写同一份内容也不会损坏。

### 2. 撤销时才回填（`server.ts`）

- `saveMessages()` 写入前调用 `encodeRollbacks()`；
- `/api/sessions/:id/turns/:turnId/undo` 在 `loadMessages()` 之后调用 `hydrateRollbacks()`，还原该轮的 `beforeBase64` 再走原有校验。

其余路径不需要字节：`clientMessages()` 本来就把 `rollback` 换成 `hasRollback` 布尔值发给渲染层；AgentLoop 只读 `result.output`，从不碰快照。

### 3. 迁移脚本（`scripts/migrate-rollbacks.cjs`）

对已有会话就地重写，跳过没有内联快照的文件；写入前复查大小与 mtime，检测到并发修改就跳过；成功后删掉旧的 `.bak`。可重复执行。

## 结果

| | 迁移前 | 迁移后 |
|---|---|---|
| `sess_1792142888675.json` | 82.8 MB | **20.6 MB** |
| `.bak` | 82.7 MB | 删除（下次保存约 20 MB，且 ≥1 MB 时走硬链接，不占额外空间） |
| 快照存储 | — | 10.9 MB / 317 个文件 |
| 该会话磁盘合计 | 165.5 MB | **31.5 MB** |
| 全部会话 JSON | 84.1 MB | 22.3 MB |

压缩比 4.2:1（JS 源码），去重后 315 个快照 → 317 个文件（两个小会话也有快照）。

## 验证

`tests/session-rollback-store.test.js`（7 项）：

| 断言 | 结果 |
|---|---|
| 编码后消息里没有 `beforeBase64`，只有 64 位 `beforeRef` | ✅ |
| 磁盘文件 gunzip 后与原字节完全一致 | ✅ |
| 编码后的 JSON 小于原体积的 1/10 | ✅ |
| 重复编码幂等、相同内容只落一个文件 | ✅ |
| 回填后 `beforeBase64` 与原值逐字节相同 | ✅ |
| 快照文件缺失时不抛异常，留给 `undoUnavailable` 报告 | ✅ |
| 空快照与非快照对象原样保留 | ✅ |

真实数据：

- 迁移后会话内 **315 个 `beforeRef`、0 个内联 base64**；
- 317 个快照逐一解压并校验 sha256，**0 个损坏**；
- 对 18 个含文件修改的回合跑真实 `undoUnavailable()`：**15 个通过**，3 个报「同一文件的多次修改之间有其他写入」——这是内容层面的既有状态（校验只比较前后字节哈希，与存储方式无关），迁移不会制造也不会消除它。

全量回归 **642 / 642**，`npm run build` exit 0。

## 生效

重启应用。迁移后的文件已经是新格式，旧版本读不了 `beforeRef`（会把撤销按钮判为不可用），所以这次改动需要和重启一起生效。

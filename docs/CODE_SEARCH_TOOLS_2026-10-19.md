# 本地代码检索工具：grep / glob（2026-10-19，批次 A）

## 背景

工具集原本只有 13 个工具，没有本地代码检索能力。agent 要在大仓库定位符号，只能
`shell_execute` 跑 `Select-String`/`findstr`，输出难控、易冲爆上下文、跨平台不一致。

本轮补齐 Claude Code / Cursor / Cline 同级的两个基础检索工具。

## 实现

### 新文件 `src/main/tools/SearchTools.ts`

两个工具共用一套有界遍历器：

| 约束 | 值 |
|---|---|
| 单文件大小 | 1 MiB（超出跳过） |
| 文件数 | 5000 |
| 目录数 | 5000 |
| 目录项 | 50 000 |
| 深度 | 64 |
| 并发读 | 8 |
| 整体超时 | 120 s（与调用方 AbortSignal 合并） |

安全边界：

- 不跟随符号链接 / junction（`entry.isSymbolicLink()` 直接跳过）
- `O_NOFOLLOW | O_NONBLOCK` 打开文件，读前 `lstat` + 读时 `fstat` 双重校验
- 二进制检测：前 8 KiB 含 NUL 即跳过
- 路径经 `PathSandbox` 解析，越界（`../`、UNC、设备名）直接拒绝
- 跳过 `.git`、`node_modules`、`dist`、`build`、`coverage`、`target` 等依赖/构建目录
- 跳过 `*.pem`、`*.key`、`id_rsa*`、含 `secrets/credentials/token` 的文件名
- 解析工作区根 `.gitignore`：注释、`!` 取反、目录规则、`/` 锚定、`**`/`*`/`?`/`{a,b}`

### 工具签名

```
grep  pattern required; path?, glob?, ignore_case?, fixed_strings?,
      context_lines? (0-3), max_results? (1-500, default 100)
glob  pattern required; path?, limit? (1-1000, default 200)
```

输出格式：

```
src/main/server.ts:1215: if (pathname === '/api/chat') {
[grep: 1 match(es) in 92 file(s), 57ms]
```

`glob` 按 mtime 降序，行尾附统计。超限时追加 `[grep: stopped at N matches; ...]` /
`[glob: stopped at N files; ...]`，提示 agent 收窄条件。

### 注册

- `risk`: `low`（只读，risk 模式不触发审批）
- `parallelSafe: true`、`cancellable: true`
- UI：`TOOL_LABELS` / `TOOL_ICONS` / `toolKind` / `toolMeta` 与 `ChatActivityView`
  的活动名均已接入（`搜索代码` / `查找文件`）

## 验证

| 项 | 结果 |
|---|---|
| 新增测试 | `tests/search-tools.test.js` **10/10** |
| 相关回归 | tool-registry / tool-routing / file-tools **14/14** |
| 全量 | `node --test --test-concurrency=3` **564/564** |
| 真实仓库 grep | `class ToolRegistry` → 57 ms / 92 文件 / 1 命中 |
| 真实仓库 glob | `src/**/*.ts` → 40 ms / 92 文件 |
| 越界拒绝 | `path: '../escape'` → `success: false` |
| 二进制/依赖跳过 | `node_modules`、`.git`、`*.dat` 均未出现在默认结果中 |

> 注：显式把 `path` 指向 `node_modules` 时仍会搜索（显式路径优先于默认跳过），
> 与 ripgrep 行为一致。

## 随行清理

- 删除被误跟踪的空文件 `$null`（0 B）与空目录 `-p/`（PowerShell 重定向误创建）
- `.gitignore` 增加 `/$null`、`/-p/` 防止复发
- 删除未跟踪的 `test-token-ui.log`

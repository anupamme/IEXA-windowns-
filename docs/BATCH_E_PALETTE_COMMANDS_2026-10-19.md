# 批次 E：命令面板、斜杠命令与桌面通知（2026-10-19）

## 1. 命令面板（Ctrl / Cmd + K）

13 个动作，输入即过滤，`↑/↓` 选择，`Enter` 执行，`Esc` 或点击背景关闭。

| 动作 | 行为 |
|---|---|
| 新建任务 | 等同「新建会话」按钮 |
| 打开对话 / 技能 / 任务中心 / MCP / 插件 / 设置 / 外观 / Token 用量 | 切换左侧视图 |
| 检查点与回退 | 打开检查点面板 |
| 切换到只读规划模式 / 帮我批准 | 调用 `setPermissionMode` 并持久化 |
| 导出诊断包 | 调用 `/api/diagnostics/export` |

实现要点：

- 单个全局 `keydown` 监听，避免和输入框快捷键冲突
- 面板是 `position: fixed` 覆盖层，`hidden` 时不参与布局
- 过滤匹配 label 与 id，大小写不敏感

## 2. 斜杠命令

原 `/` 菜单只列技能（输入辅助）。现在优先列系统命令，再列技能：

| 命令 | 行为 |
|---|---|
| `/help` | 把命令清单插入输入框 |
| `/new` | 新建会话 |
| `/model` | 打开模型选择器 |
| `/plan` | 切换到只读规划模式 |
| `/rewind` | 打开检查点面板 |
| `/diagnostics` | 导出诊断包 |

交互细节：

- 命令项与技能项统一渲染，用 `data-kind` 区分（`command` / `skill`）
- 键盘 `Tab` / `Enter` / 方向键在两类条目间一致工作
- 执行命令后清空当前 `/xxx` 触发片段，不残留文本

## 3. 桌面通知

`notifyIfHidden(title, body)`：

- 只在 `document.visibilityState !== 'visible'` 时触发（窗口在前台不打扰）
- 首次调用时若权限为 `default`，请求一次权限
- 触发点：`done` 事件（任务完成/取消）、`permission_required`（等待审批）
- 点击通知聚焦窗口

## 4. 会话全文搜索

已存在，无需新增：`/api/search` 遍历会话消息内容与标题，返回 `session + matches[]`，
左栏搜索框 `performSearch()` 已渲染高亮片段。

## 验证

| 项 | 结果 |
|---|---|
| 真实浏览器 | Ctrl+K → 面板 13 项 → 过滤「诊断」1 项 → Esc 关闭 |
| 斜杠命令 | 输入 `/plan` → 菜单出现系统命令 → 点击后 `data-permission-mode=plan`、label「仅规划（只读）」、输入框清空 |
| 全量回归 | 见提交说明 |

截图脚本：`workspace/tmp/palette_check.cjs`。

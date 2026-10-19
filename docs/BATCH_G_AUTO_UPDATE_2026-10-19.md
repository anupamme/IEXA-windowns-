# 批次 G：自动更新与 NSIS 打包（2026-10-19）

## 形态切换

原发布链路是自制的 `create-installer.ps1`（stub + 7z 拼接），与 `electron-updater`
不兼容。本轮切换到 **electron-builder + NSIS**：

| 项 | 值 |
|---|---|
| 打包器 | `electron-builder` 26.15.3（devDependency） |
| 更新器 | `electron-updater` 6.8.9（runtime dependency） |
| 目标 | `nsis`，非 oneClick，可选安装目录 |
| 产物名 | `IEXA-WIN-Setup-${version}.exe`（显式 artifactName，避免空格与清单不一致） |
| 发布通道 | GitHub Releases：`bidalu9-crypto/IEXA-windowns-` |

## 更新服务

`src/main/update/UpdateService.ts`（可注入 adapter，纯状态机）：

```
disabled → idle → checking → available | not-available
                → downloading (percent) → downloaded → install
                → error (message)
```

- `autoDownload = false`：**下载必须用户确认**，不会偷跑流量
- `autoInstallOnAppQuit = true`
- 未打包（`app.isPackaged === false`）时状态为 `disabled`，不触碰 adapter
- 启动后延迟 15 秒静默检查一次
- `dispose()` 可取消定时器并停止状态发布

`electron-entry.js`：

- `createUpdateService()` 在托盘创建后初始化
- 托盘菜单新增「检查更新」：按当前状态执行检查 / 下载 / 重启安装，并用原生对话框确认
- 状态变化更新托盘 tooltip，并向渲染进程发送 `update-status`

## 版本流程

```powershell
npm version patch            # 或 minor / major
npm run dist:builder         # 本地打包，--publish never
npm run release:builder      # 需要 GH_TOKEN，--publish always 上传 Release
```

`latest.yml` 由 electron-builder 生成，包含 `version`、`path`、`sha512`、`size`。

## 打包中遇到的两个坑

1. **`node-pty` 重复编译失败**：electron-builder 默认执行 `@electron/rebuild`，
   本机缺少 MSVC 的 Spectre 缓解库（`MSB8040`）。但 `node-pty` 1.1.0 已带
   N-API 预编译产物（`prebuilds/win32-x64/*.node`），因此设置
   `"npmRebuild": false` 跳过重编译。
2. **Electron 下载超时**：缓存里只有 v28/v40/v41，没有 v44.3.0，electron-builder
   尝试在线下载并超时。改用 `"electronDist": "node_modules/electron/dist"`
   复用本地已安装的 44.3.0 运行时。

## 验证

| 项 | 结果 |
|---|---|
| `tests/update-service.test.js` | **7/7**（状态机、静默检查、错误、禁用、install 前置条件、dispose） |
| 打包 | `npx electron-builder --win nsis --publish never` **exit 0** |
| 产物 | `IEXA-WIN-Setup-1.0.0.exe` 117.11 MB + `.blockmap` + `latest.yml` |
| 清单一致性 | `latest.yml` 的 `sha512` 与安装包实测 SHA-512 **完全一致**；`path` 文件名与实际文件一致 |
| 全量 | **606/606** |
| 运行时依赖审计 | `npm audit --omit=dev` → **0 vulnerabilities**（升级 `dompurify` 3.4.17、`overrides` 固定 `brace-expansion` 2.1.7） |

> 补充：`electron-builder` 及其 devDependencies 仍会报告的告警只存在于开发工具链，
> 不进入安装包；`--omit=dev` 已确认运行时为 0。

## 未完成 / 后续

- **真实 OTA 需要一次实际发版**：`npm version` → tag → `release:builder`（需 `GH_TOKEN`），
  然后在旧版本客户端里验证「检查 → 下载 → 重启安装」全链路。本轮只验证到
  「能产出带正确清单的安装包」。
- **代码签名按用户决定跳过**：安装包未签名，SmartScreen 会提示；如需签名，
  在 `build.win` 增加 `certificateFile` / `certificatePassword`。
- 自制安装器 `create-installer.ps1` 保留未删除，但不再是发布路径。

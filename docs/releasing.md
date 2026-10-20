# 发布与自动更新

应用通过 GitHub Releases 分发，并用 Tauri 的 updater 插件在应用内检查更新。

## 一次性配置

### 1. 把签名私钥填进 GitHub Secrets

签名密钥对已经生成在本机（**不在仓库里**）：

```
C:\Users\PC\.tauri\moseek-updater.key            ← 私钥，不要提交、不要外传
C:\Users\PC\.tauri\moseek-updater.key.pub        ← 公钥，已写进 src-tauri/tauri.conf.json
C:\Users\PC\.tauri\moseek-updater-password.txt   ← 口令，同上，不要提交
```

在仓库 **Settings → Secrets and variables → Actions** 里新建两个 Secret：

| Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件的**全部内容**（含 `untrusted comment:` 那一行，多行一起复制） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 本机 `moseek-updater-password.txt` 里的口令 |

`GITHUB_TOKEN` 不用配，工作流自动拿到。

> **口令为什么不写在这份文档里。** 这个仓库是公开的，而口令是任何一份逃出这台机器的私钥副本（备份、云同步的家目录、支持包）上唯一的保护。写在这里等于公开它。口令只在 `~/.tauri/moseek-updater-password.txt` 和你的密码管理器里。
>
> **这条规则是有代价换来的**：上一版把口令直接写在这份文档里，仓库又是公开的，等于把这把密钥的一半保护公开发布了。2026-10-20 因此轮换了整个密钥对。**永远不要把任何 Secret 的值写进仓库。**

> **密码为什么不能是空的。** Tauri CLI 只在 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` **非空**时才使用它，空字符串在 shell 里等同于「没设置」（实测：PowerShell 根本不会把空字符串传给子进程），于是 CLI 会转去**交互式提示输入密码**——在 CI 上就是一个永远等不到输入的构建。给密钥设密码让本地与 CI 走同一条路径。

> **私钥丢了就无法再发布可用的更新**：已装用户只接受用这把私钥签名的安装包，换新密钥必须让用户手动重装一次。请把 `moseek-updater.key` 与口令一起备份到安全的地方。

### 1b. 轮换过密钥之后（2026-10-20 那次）

- 旧密钥对留在 `~/.tauri/moseek-updater.key.old` / `.pub.old` 和 `~/.tauri/backup-<时间戳>/`，**确认新流程跑通后请删除**，别让它继续躺在磁盘上。
- 在 GitHub Secrets 里把两个值都换成新的；旧的 Secret 值不会自动失效，必须手动覆盖。
- `tauri.conf.json` 里的 `pubkey` 已同步为新公钥。**它必须与 Build 用的私钥成对**，否则更新装不上。
- 已安装的旧版本只认旧公钥，所以它们会收到「无法验证更新」。要让它们迁移，只能在下一个版本里同时接受两把钥匙（updater 插件不支持），或者让用户手动重装一次。这一次我们接受手动重装。

### 2. 确认仓库地址

`src-tauri/tauri.conf.json` 里的更新端点与公钥：

```json
"updater": {
  "pubkey": "…",
  "endpoints": ["https://github.com/aeroray/Moseek/releases/latest/download/latest.json"]
}
```

`releases/latest/download` 永远指向最新一个正式发布，所以**每次发版都不用改这里**。

## 每次发版的流程

```bash
# 1. 改版本号（三处一起改：package.json / Cargo.toml / tauri.conf.json）
node scripts/sync-version.mjs 1.0.0

# 2. 写这一版的发布说明（文件名必须与标签一致）
#    编辑 docs/releases/v1.0.0.md —— 只有发版时才需要这个文件
#    目录约定见 docs/releases/README.md

# 3. 提交
git add -A
git commit -m "Release v1.0.0"

# 4. 打标签并推送（推送标签即触发发布）
git tag v1.0.0
git push origin main
git push origin v1.0.0
```

> **发布说明是发版动作的一部分，不是长期文档。** 目前项目尚未正式发版，`docs/releases/`
> 里除了一份约定说明之外是空的。等到真正要发版时再写那唯一一份 `<标签>.md`——在此之前
> 不需要预先准备，工作流也不会因为目录为空而误触发（它只在推送 `v*` 标签时运行）。

工作流会：校验版本号与标签一致 → 读取发布说明 → 构建并签名安装包 → 创建 GitHub Release → 上传 `latest.json`。

**两个平台行并行构建**：Windows 产出 NSIS 安装包，macOS 只出 Apple 芯片那一份（`aarch64-apple-darwin`）。它们不会互相覆盖 `latest.json` —— tauri-action 会先读回已有清单，再合并进自己那一条平台记录。

**不支持 Intel Mac，这是有意的。** 工作流里没有 `x86_64-apple-darwin` 这一行：多一个架构就要多一条工具链、多一个待验证产物、多一条升级清单记录，而这个项目没有 Intel 机器可测。`latest.json` 因此只会有 `darwin-aarch64` 一个 macOS 键——Intel Mac 看到的是「没有更新」，而不是一个装上去用不了的包。

如果以后要加回 Intel：在 `release.yml` 的 matrix 里恢复 `x86_64-apple-darwin` 那一行即可，其余步骤不需要改（`targets: ${{ matrix.target }}` 和 `args` 都会自动带上）。

### 关于签名

这里有两套完全不同的签名，别混淆：

| | 用途 | 成本 |
|---|---|---|
| **minisign**（`TAURI_SIGNING_PRIVATE_KEY`） | 给**自动更新**的载荷签名，应用只安装能验证通过的更新 | 免费，自己生成 |
| **Apple 证书** | 让 macOS 信任应用本体（Gatekeeper） | **需要每年 99 美元的开发者账号** |

本项目**不使用 Apple 证书**：`tauri.macos.conf.json` 里设了 `signingIdentity: "-"`，即 ad-hoc 签名。这是开源免费软件的合理取舍——代价是 macOS 用户首次打开时需手动放行（右键 →「打开」，或在「系统设置 → 隐私与安全性」里点「仍要打开」）。README 的下载说明应告知这一点。

## 版本号为什么必须一致

版本号写在三个文件里，构建前会互相校验：

| 文件 | 作用 |
|---|---|
| `package.json` | 前端显示的版本（经 `__APP_VERSION__` 注入） |
| `src-tauri/Cargo.toml` | 二进制编译成的版本 |
| `src-tauri/tauri.conf.json` | 安装包与 `latest.json` 里的版本 |

三者不一致时，应用显示的版本、安装包实际装的版本、更新比较用的版本会各不相同，症状是**明明不是最新版却显示「已是最新版本」**，或者**更新装完又提示有新版本**。工作流在构建前就会因此失败，这比发出去再发现便宜得多。

## 应用内的更新流程

1. **设置中心 → 关于 → 检查更新**：请求 `latest.json`，有新版就显示版本号与更新说明。
2. **立即安装**：下载安装包 → **校验 minisign 签名**（与 `tauri.conf.json` 里的公钥比对）→ 静默运行安装程序 → 自动重启应用。

签名校验失败会中止安装并报错。这是关键防线：更新端点返回的 `latest.json` **本身没有签名**，只有安装包有——所以「能下载到」不等于「是我们发布的」。

## 本地构建（不打标签）

```bash
# 需要私钥才能产出签名，否则 updater 无法使用。
# 口令从环境变量读，绝不写死在命令里——这条命令会进 shell 历史。
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\moseek-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-Host "签名口令" -MaskInput
pnpm tauri build
```

不用传 `--bundles`：产出哪些包由平台配置决定，CLI 会自动读 `tauri.windows.conf.json` 或 `tauri.macos.conf.json`。

- Windows 产物：`src-tauri/target/release/bundle/nsis/`，含 `Moseek_<版本>_x64-setup.exe` 与同名 `.sig`。
- macOS 产物：`src-tauri/target/release/bundle/dmg/` 与 `.../macos/`（Apple 芯片）。

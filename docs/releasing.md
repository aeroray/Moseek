# 发布与自动更新

应用通过 GitHub Releases 分发，并用 Tauri 的 updater 插件在应用内检查更新。

## 一次性配置

### 1. 把签名私钥填进 GitHub Secrets

签名密钥对已经生成在本机（**不在仓库里**）：

```
C:\Users\PC\.tauri\moseek-updater.key       ← 私钥，不要提交、不要外传
C:\Users\PC\.tauri\moseek-updater.key.pub   ← 公钥，已写进 src-tauri/tauri.conf.json
```

在仓库 **Settings → Secrets and variables → Actions** 里新建两个 Secret：

| Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件的**全部内容**（含 `untrusted comment:` 那一行，多行一起复制） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `moseek-updater` |

`GITHUB_TOKEN` 不用配，工作流自动拿到。

> **密码为什么不是空的。** 密钥生成时设了密码 `moseek-updater`，这是有意的：Tauri CLI 只在
> `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` **非空**时才使用它，空字符串在 shell 里等同于「没设置」
> （实测：PowerShell 根本不会把空字符串传给子进程），于是 CLI 会转去**交互式提示输入密码**——
> 在 CI 上就是一个永远等不到输入的构建。给密钥设密码让本地与 CI 走同一条路径。

> **私钥丢了就无法再发布可用的更新**：已装用户只接受用这把私钥签名的安装包，换新密钥必须让用户手动重装一次。请把 `moseek-updater.key` 与密码一起备份到安全的地方。

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
node scripts/sync-version.mjs 0.2.0

# 2. 写这一版的发布说明（文件名必须与标签一致）
#    编辑 docs/releases/v0.2.0.md

# 3. 提交
git add -A
git commit -m "Release v0.2.0"

# 4. 打标签并推送（推送标签即触发发布）
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

工作流会：校验版本号与标签一致 → 读取发布说明 → 构建并签名 NSIS 安装包 → 创建 GitHub Release → 上传 `latest.json`。

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
# 需要私钥才能产出签名，否则 updater 无法使用
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\moseek-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "moseek-updater"
pnpm tauri build --bundles nsis
```

产物：`src-tauri/target/release/bundle/nsis/`，含 `Moseek_<版本>_x64-setup.exe` 与同名 `.sig`。

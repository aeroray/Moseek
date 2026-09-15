# Moseek — 工作区长期记忆

Moseek 是 Windows 优先的桌面媒体资源操作台（React + Vite + TS + Tauri 2 + Rust）。
项目自身有一套记忆系统：**改动前先读 `docs/memory/manifest.md` 与 `brief.md`，决策记录写进
`docs/memory/decisions.md`**（`AGENTS.md` 强制要求）。本文件只放跨会话的环境与协作事实。

## 本机环境（会浪费大量时间，务必先看）

- **`mise` 的 shims 已损坏**，`pnpm` / `cargo` / `rustc` 直接调用会报
  `mise ERROR cannot find binary path`。必须用绝对路径：
  - pnpm：`C:\Users\PC\AppData\Local\mise\installs\pnpm\11.5.0\pnpm.exe`
  - cargo：`C:\Users\PC\.cargo\bin\cargo.exe`
  - ffmpeg（可生成测试流）：`C:\Users\PC\AppData\Local\mise\installs\ffmpeg\8.1.1\Library\bin\ffmpeg.exe`
- **Rust 链接需要手工补环境**（否则 `LNK1181: cannot open input file 'kernel32.lib'`，
  或 Git Bash 的 GNU `link.exe` 抢先导致 `link: missing operand`）：
  - `PATH` 追加：VS BuildTools 的 `VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64`
    与 Windows Kits 的 `bin\10.0.26100.0\x64`
  - `LIB` 设为：MSVC `lib\x64` + SDK `Lib\10.0.26100.0\um\x64` + `Lib\10.0.26100.0\ucrt\x64`
  - 这些路径**不要写进仓库**，只在本机命令里用。
- **火绒安全在运行**（`HipsDaemon.exe` / `HipsTray.exe`），会拦截 rustc 增量编译目录的写盘，
  曾导致 rustc ICE（`encode_metadata` panic，exit 101）。已通过
  `src-tauri/Cargo.toml` 的 `[profile.dev] incremental = false` 规避。
  建议把项目目录加入火绒「信任区」，否则 Vite 文件监听等高频写盘也可能被拦。
- PowerShell 工具在本机不稳定（常无输出）；`Bash` 里调用 `powershell.exe` 会被安全策略拒绝。
  优先用 Bash + 直接调用 `*.exe`。

## 常用命令

- 前端：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build`
- Rust：`cargo test`（在 `src-tauri/`）/ `cargo clippy --all-targets` / `cargo fmt`
- 提交前四件套：`typecheck`、`lint`、`test`、`cargo test`，并跑一次 `cargo fmt --check`。

## 协作偏好

- 用户偏好**根因分析 + 证据**，不接受"大概是"：定位问题时要给出实测数据（命令输出、DOM 测量、
  对照实验），而不是推测。
- 用户会主动要求清理 AI 测试残留（临时预览页、截图、验证日志）。收尾时自行清理，
  不要往仓库里留 `preview-tmp/`、`harness*`、`*.png` 之类的产物；`verification-logs/` 也不要留。
- 结论性发现要写进 `docs/memory/decisions.md`（英文，与既有条目风格一致）。

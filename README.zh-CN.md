# 拾影 · Moseek

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows · macOS](https://img.shields.io/badge/Platform-Windows%20%C2%B7%20macOS-0078D4.svg)](#下载)

简体中文 · [English](README.md)

桌面端播放器：导入一份 TVBox / CatVod 风格的配置，就能看影视和电视直播。
**配置里的代码一律不执行：远程脚本、JAR、爬虫全部拒绝。**

![拾影的影视界面](docs/images/library.png)

## 特性

- **看影视与电视直播** —— 分类浏览、搜索、选集；频道分组、节目单、线路测试。HLS 与 FLV 都能播。
- **先识别，再使用** —— 每个源导入时判定类型与可用性：能用的直接用，不能用的说明原因，不悄悄丢弃。
- **导入前先看清** —— 配置读进来会先列出全部内容（影视源 / 直播源 / 解析源），勾选后才导入。
- **一套配置** —— 多次导入自动合并去重；收藏、足迹、观看进度与配置分开保存。
- **网络请求统一把关** —— 全部经 Rust 网络层：只允许公网 HTTP/HTTPS，本机与内网地址、危险协议一律拒绝，重定向逐跳校验。播放器取字节也走这一层；唯一的例外是原生 MP4 由系统播放器自行连接，因此在交给它之前会先经过同一套校验。

## 下载

到 [Releases](https://github.com/aeroray/Moseek/releases) 下载 Windows 安装包（NSIS）或 macOS 的 `.dmg`。应用内置自动更新，新版本发布后会自动提示。

> **macOS 用户**：安装包只做了 ad-hoc 签名、未做公证——免费开源项目不该为此承担 Apple 开发者年费。首次打开请**右键点应用 →「打开」**，或到**「系统设置 → 隐私与安全性」**里点「仍要打开」。之后即可正常启动。

> **升级到 1.0.0 之前装过旧版本的话**：更新签名密钥在 1.0.0 轮换了，旧版本会提示「无法验证更新」，需要手动下载 1.0.0 安装一次。之后自动更新恢复正常。

## 从源码构建

需要 [Node.js](https://nodejs.org) 22+、[pnpm](https://pnpm.io) 11+ 和 [Rust](https://rustup.rs)。

```bash
pnpm install
pnpm tauri dev     # 开发运行
pnpm tauri build   # 产出安装包（src-tauri/target/release/bundle/）
```

其他命令：`pnpm test`（单测）、`pnpm lint`、`pnpm typecheck`、`pnpm build`（仅前端）。

> **开发预览不加载原生 MP4**：`pnpm tauri dev` 之外，纯浏览器预览（`pnpm dev`）没有 Rust 网络层，原生 `<video>` 分支因此拒绝播放并提示「无法校验媒体地址」。HLS 与 FLV 不受影响。这是刻意的——没有策略层可校验时，宁可不播。媒体行为请以桌面应用为准。

## 范围

- 只做桌面端：Windows 与 macOS（Apple 芯片 / Intel 各自出包），不做移动端。
- 不自带任何源；需要你自己的配置文件，请使用合法获得的。

## 技术栈

Tauri 2 · Rust · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui · Plyr / hls.js / mpegts.js

## 参与

问题与建议欢迎提到 [Issues](https://github.com/aeroray/Moseek/issues)。

## 许可证

[MIT](LICENSE)

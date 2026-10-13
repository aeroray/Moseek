# 拾影 · Moseek

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows · macOS planned](https://img.shields.io/badge/Platform-Windows%20%C2%B7%20macOS%20planned-0078D4.svg)](#下载)

简体中文 · [English](README.md)

桌面端播放器：导入一份 TVBox / CatVod 风格的配置，就能看影视和电视直播。
**配置里的代码一律不执行：远程脚本、JAR、爬虫全部拒绝。**

![拾影的影视界面](docs/images/library.png)

## 特性

- **看影视与电视直播** —— 分类浏览、搜索、选集；频道分组、节目单、线路测试。HLS 与 FLV 都能播。
- **先识别，再使用** —— 每个源导入时判定类型与可用性：能用的直接用，不能用的说明原因，不悄悄丢弃。
- **导入前先看清** —— 配置读进来会先列出全部内容（影视源 / 直播源 / 解析源），勾选后才导入。
- **一套配置** —— 多次导入自动合并去重；收藏、足迹、观看进度与配置分开保存。
- **网络请求统一把关** —— 全部经 Rust 网络层，本机与内网地址、危险协议会被拒绝。

## 下载

到 [Releases](https://github.com/aeroray/Moseek/releases) 下载 Windows 安装包（NSIS）。应用内置自动更新，新版本发布后会自动提示。

## 从源码构建

需要 [Node.js](https://nodejs.org) 22+、[pnpm](https://pnpm.io) 11+ 和 [Rust](https://rustup.rs)。

```bash
pnpm install
pnpm tauri dev     # 开发运行
pnpm tauri build   # 产出安装包（src-tauri/target/release/bundle/）
```

其他命令：`pnpm test`（单测）、`pnpm lint`、`pnpm typecheck`、`pnpm build`（仅前端）。

## 范围

- 只做桌面端：目前支持 Windows，macOS 在计划中；不做移动端。
- 不自带任何源；需要你自己的配置文件，请使用合法获得的。

## 技术栈

Tauri 2 · Rust · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui · Plyr / hls.js / mpegts.js

## 参与

问题与建议欢迎提到 [Issues](https://github.com/aeroray/Moseek/issues)。

## 许可证

[MIT](LICENSE)

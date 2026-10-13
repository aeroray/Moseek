# 拾影 · Moseek

[English](README.en.md) · 简体中文

一个 Windows 桌面影音播放器：导入一份 TVBox / CatVod 风格的配置，看影视库和电视直播。
**只运行声明式配置，不执行任何远程脚本、JAR 或爬虫。**

![影视库](docs/images/library.png)

## 特性

- **影视库与电视直播** —— CMS 分类浏览、搜索，直播频道分组播放；HLS 与 FLV 流都支持。
- **源安全分级** —— 每个源导入时自动识别类型与可用性：能用的直接用，不能用的明确说明原因，不悄悄丢弃。
- **导入即所见** —— 配置读进来先列出全部内容（影视源 / 直播源 / 解析源），勾选后才导入。
- **一本配置** —— 多次导入合并去重成一套配置；收藏、足迹、观看进度与配置分开存取。
- **网络出 Rust** —— 所有请求（页面、节目单、媒体流、海报）都走同一个 Rust 策略网关，Webview 不直接联系媒体服务器。

## 截图

| | |
|---|---|
| ![配置中心](docs/images/config.png) | ![源详情](docs/images/source-detail.png) |
| 配置中心：源列表、测试、启停 | 源详情：只读展示，点「编辑」修改 |
| ![导入配置](docs/images/import.png) | ![我的收藏](docs/images/favorites.png) |
| 导入：列出内容，勾选后导入 | 收藏与足迹：接着上次看 |

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

## 它不做什么

- 不执行远程脚本、JAR、爬虫——这类源会被识别并**拒绝**，不是静默失败。
- 不做移动端。
- 不内置任何源；没有配置它什么都没有。请使用你合法获得的配置文件。

## 技术栈

Tauri 2 · Rust · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui · Plyr / hls.js / mpegts.js

## 许可证

[MIT](LICENSE)

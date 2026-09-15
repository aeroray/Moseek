# Phase 3 Research

更新时间：2026-09-15

## 结论

第 3 阶段不直接把 CatVod Android JAR、远程 JS 或 Spider 放进 Moseek 主进程。第一步采用独立的 QuickJS-NG 运行时协议：只接收本地显式提交的脚本，使用 JSON Lines 通信，并设置脚本大小、内存、栈和执行时间限制。

## 参考实现

- [rquickjs](https://github.com/DelSkayn/rquickjs)：MIT；基于 QuickJS-NG，提供 Runtime/Context、内存限制、栈限制、中断处理和自定义模块加载器。它适合做现有 JS 源的兼容层，但不是浏览器，也不自带网络或 DOM API。其 Windows MSVC 支持在当前文档中仍标为实验状态。
- [QuickJS-NG](https://github.com/quickjs-ng/quickjs)：MIT；原生 API 提供 `JS_SetMemoryLimit`、`JS_SetMaxStackSize` 和 `JS_SetInterruptHandler`，适合作为独立进程内核。
- [Wasmtime](https://github.com/bytecodealliance/wasmtime)：Apache-2.0；通过 Store limiter、fuel、epoch interruption 控制 Wasm 的内存和 CPU。它更适合未来定义稳定的 Wasm 插件 ABI，不直接兼容 CatVod JS。
- [Extism](https://github.com/extism/extism)：BSD-3-Clause；在 Wasmtime 之上提供插件 ABI、Host Functions、受限 HTTP 和 manifest 资源限制。适合未来的跨语言插件生态。
- [CatVodSpider](https://github.com/FongMi/CatVodSpider)：GitHub 页面未显示可直接复用的许可证；可参考 Spider 的站点方法和数据契约，不复制实现或 JAR。
- [CatVodSpider-PC](https://github.com/kknifer7/CatVodSpider-PC)：Java PC 模板，适合参考开发流程和热更新调试，不适合作为 Moseek Rust 运行时依赖。
- [FreeBox](https://github.com/kknifer7/FreeBox)：GPL-3.0；源审计、批量测试和 PC/移动端分层值得借鉴，但不能把 GPL 实现直接混入当前项目。
- [openlist-tvbox-gateway](https://github.com/outlook84/openlist-tvbox-gateway)：AGPL-3.0；值得参考凭据留在网关、签名播放地址、目录/搜索/字幕接口和配置热重载；不直接复制代码。
- [Tauri sidecar](https://v2.tauri.app/develop/sidecar/)：外部二进制需要按目标架构打包，并通过显式 shell capability 运行；适合承载脚本运行时或浏览器嗅探器。

## 采用的边界

1. 初始 JS 运行时不暴露文件系统、Shell、DOM、`fetch` 或任意网络 API。
2. 运行时协议接受 `{ script, entry, input, httpHosts }`，返回 `{ ok, value, error }`；`httpHosts` 缺省或为空时没有网络 API。
3. 远程配置里的 JS、JAR 和 Spider 继续保持 blocked；只有未来显式导入并经过信任/哈希校验的本地脚本才能进入运行时。
4. 下一步若兼容 CatVod 请求流程，只增加主进程提供的 `http_get` Host API，并复用 Moseek 的 URL、响应大小、重定向和私网策略。
5. JAR 不进入主进程；若未来支持，只能作为独立、用户明确安装的 sidecar，并做版本、哈希、协议和权限校验。

## 下一步顺序

1. 增加本地脚本源档案：文件导入、SHA-256、用户启用确认、版本和删除回滚；不让远程配置直接变成可执行脚本。
2. 定义 CatVod 输出归一化：把 `getCategory`、`getHome`、`getSearch`、`getDetail` 和 `parseIframe` 的返回值映射到 Moseek 的 `CatalogPage`、`VodItem` 和播放解析模型。
3. 将脚本源纳入能力审计：记录脚本入口、HTTP host-call 数、耗时、超时和失败阶段。
4. 再考虑 sidecar 进程复用与取消；当前每次执行独立启动，边界清晰但启动成本较高。

当前已完成：本地文件导入、SHA-256 去重、入口函数和 HTTP allowlist 保存、默认停用、软删除/撤销、按档案 ID 执行，以及 sidecar/HTTP 超时保护。

绑定链也已接通：配置中心可以把 JS 源绑定到本地档案；首页/搜索、详情和非 HTTP 选集分别调用 `getHome`/`getSearch`、`getDetail` 和 `parseIframe`，统一经过 CatVod 输出归一化。

当前兼容边界：脚本源会独立调用 `getCategory`，`parseIframe` 的 headers 可传给 HLS 播放器，sidecar 会处理常见的命名 `export function`/`export async function`；暂不提供完整 ES Module import、DOM 或默认文件系统能力。

请求头边界：脚本档案可配置 `User-Agent`、`Referer` 和 `Cookie`，值会经过长度/换行校验；列表只展示 header 名称，不回显 Cookie 内容，其他请求头会被拒绝。

Cookie 存储：Windows 桌面版本使用系统 Credential Store 保存 Cookie，SQLite 只保留 `hasCookie` 标记和非敏感请求头；旧档案启动时会尝试迁移明文 Cookie。

## 暂不采用

- 不采用 Deno Core 作为新基础；其独立仓库已归档并合并回 Deno。
- 不嵌入 OpenList/AList 源码；它们是 AGPL 项目，且网盘凭据和媒体代理更适合作为独立网关。
- 不使用浏览器 WebView 作为通用 JS 沙箱；浏览器自动化只保留在用户手动启动的嗅探伴侣边界内。

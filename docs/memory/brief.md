# Project Brief

拾影 (Shiying / Moseek) 是一个面向 Windows 优先的桌面端影视资源聚合工作台与多源流媒体播放器，Slogan 为「万千影视，一拾即得」。它连接并整合多元化的视听生态：支持透明 TVBox/CatVod 配置导入、普通 CMS/直播源探测分类、影视聚合检索与多线路秒开、HLS 原生硬件加速直播、以及受沙盒保护的安全执行边界。

前端采用 React 19 + Vite + TypeScript + Tailwind CSS v4 + 精致紧凑的「极光黑曜 (Cinematic Obsidian)」黑曜石暗色影院级 UI 设计规范，搭配 Tauri 2 作为桌面壳体与 Rust 高性能媒体/网络/存储层。

播放地址解析的既定顺序：直链 → **扫描播放页内嵌的媒体地址**（源自己的主机，不执行脚本、不经第三方）→ 并发的第三方解析服务兜底。影视库进入观看页只预加载与呈现播放器，**不自动播放**，且「足迹」只在真正开始播放后写入。

窗口标题为三段式：`Moseek · 拾影 · 万千影视，一拾即得`（`tauri.conf.json` 与 `index.html` 必须一致）。「系统设置」页与「配置中心」共用同一套版式：`max-w-6xl` 居中列、固定头部、带图标的标签行、每标签一张卡（卡片按内容高度、滚动在标签内）。

清除类的破坏性操作统一走 `src/components/clear-records-dialog.tsx`（足迹 / 我的收藏 / 系统设置三处共用）：默认全选的复选框 + 随选择范围变化的确认按钮文字。store 里 `clearHistory(kind?)` 与 `clearFavorites(kind?)` 对称——影视与电视直播各自是独立字段，**传 kind 只清那一边**。

配置采用**合并**模型：删除一个源只把它从当前配置（原始文本 + 源快照）移除，**不记录「这个源是用户不要的」**，因此之后导入的文件里若仍有该源，它会作为新源被加回来；导入时同一源仍在则跳过、不产生第二行。清理源时要同时过滤 `favorites`、`liveFavorites` 与 `history`（三者都以 sourceKey 关联）。

配置中心里**列表计数与原文条数不必然相等**：没有 `url`/`api` 的条目（如只有嵌套 `channels` 的 TVBox 重定向项）被解析器判为 `invalid`，不进列表。列表显示的是**可用（`enabled && supported`）**的源数。

`normalized_config` **只保留 6 个顶层键**（`sites`/`lives`/`parses`/`blockedFields`/`configDialect`/`schemaVersion`），**导出用的就是它**，所以 `ads`/`flags`/`doh`/`rules`/`ijk`/`hosts`/`proxy`/`wallpaper`/`warningText`/`spider`/`logo` 这 11 项**Moseek 不读取、导出也不带**（实测占原文 18% 字节）。它们只对 TVBox 客户端有意义，可在「原始配置 → 可视化 → 其他设置」一键清理。`parses` 则**必须保留**——它是播放兜底链路的一环（地址是播放页而非媒体文件时由 Rust `resolve_playback` 使用），但每次解析**按文件顺序最多试 12 个**，重复地址会白占名额，可用「去掉重复地址」清理。

删除源时**按身份（`api + ext`）匹配原文条目，不按 `key`**：raw 与源列表的 `key` 是两套独立生成、且已经分叉的命名空间（无 key 的条目被解析器编号为 `live-1`，被合并后缀成 `-2`，两边零重叠），按 `key` 匹配会让删除漏掉原文，用户看到的就是「删了但原始配置里还在」。身份相同时**先比 key、再比 name，每个原文条目最多被认领一次**（身份并不唯一：`xgapp` 与 `骑骑影院` 就是同一 `api + ext`）。原文里「列表早已没有」的残留也会一并清理，但只在列表确实描述着这份原文时才做。**合并不得为没有 `key` 的条目生成 key**——那会把 keyless site 的 `capability` 从 `invalid` 静默升级为 `supported`（`classifySource` 的 `hasRequiredFields` 读原始 `key`），等于让导入把不可用的源变成可执行。

配置中心的第四个标签页是 **「源健康」**（原「解析报告」；逻辑在 `src/features/config/config-report.ts`），回答的是**「这些源能不能用」**而不是「解析器看到了什么」。它把 `sources` **划分**成互斥的 7 组（可用 / 待测试 / 测试失败 / 无内容 / 配置无效 / 已阻止 / 未适配），分组用**源列表自己的词**（`statusFacetLabels` / `executionFacetLabels`），所以数字在列表里找得到；每行**整行可点**，点了就切到源列表并套上对应的筛选。判定顺序是**先判可测性再判测速结果**（没有可用适配器的源根本没有测速结果，反过来会把它们全归进「待测试」）。无人的组不显示，**只有「可用」在 0 时保留**——「没有任何源被确认可用」是这页最重要的一句话。

报告**必须从已保存的 `rawConfig` 实时推导**，不能存快照：原来的 `report = parseResult ?? parseConfigText(rawConfig)` 里 `parseResult` 由导入对话框写入，而对话框**连解析失败的结果也会存**、且关闭/删除源都不清除，于是「导入一段坏 JSON 被拒绝后，报告会宣称这份好配置无法解析」。注意**普通删除会掩盖这个 bug**（`rawConfig` 一变就触发 draft-reset effect 重新解析、顺手修好了快照），所以只测「删一个源」的回归测试**在旧代码上照样通过**——必须用「导入失败后报告仍正常」这个路径才能区分。报告读 `rawConfig` 而非 `editorText` 是刻意的：它描述已保存的版本，未保存的改动由「保存改动」按钮体现。**问题清单按 message 归组、按条目名而非数组下标称呼**（`parses.41` 这种下标是这页原先最劝退的地方）。

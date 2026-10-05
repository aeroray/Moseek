import type { SourceRecord, SourceType } from "@/types/moseek";

export type AdapterExecution =
  | "enabled"
  | "needs-adapter"
  | "blocked";

export type AdapterId =
  | "builtin-cms"
  | "builtin-live"
  | "http-extension"
  | "http-parser"
  | "js-extension"
  | "html-http"
  | "spider-runtime"
  | "remote-jar"
  | "drpy-js"
  | "xbpq"
  | "csp-appmao"
  | "csp-panda"
  | "csp-xyqhiker"
  | "private-protocol"
  | "unknown";

export interface AdapterProfile {
  id: AdapterId;
  label: string;
  execution: AdapterExecution;
  operations: string[];
  reason: string;
  sourceType: SourceType;
}

const profiles: Record<AdapterId, Omit<AdapterProfile, "id" | "sourceType">> = {
  "builtin-cms": {
    label: "内置 CMS 适配器",
    execution: "enabled",
    operations: ["搜索", "分类", "详情", "播放线路", "选集"],
    reason: "普通 HTTP CMS API 使用 Moseek 统一数据模型。",
  },
  "builtin-live": {
    label: "内置直播适配器",
    execution: "enabled",
    operations: ["频道", "分组", "节目单", "播放"],
    reason: "M3U、TXT、JSON 直播源通过 Rust 解析器处理。",
  },
  "http-extension": {
    label: "HTTP 扩展适配器",
    execution: "enabled",
    operations: ["搜索", "分类", "详情", "播放线路", "选集"],
    reason: "使用受限的 HTTP 字段映射，不执行远程代码。",
  },
  "http-parser": {
    label: "HTTP 解析适配器",
    execution: "enabled",
    operations: ["GET 解析", "POST 解析", "播放地址校验"],
    reason: "通过受限的 HTTP/HTTPS GET 或 JSON POST 解析接口返回播放地址。",
  },
  "js-extension": {
    label: "JS 扩展源",
    execution: "blocked",
    operations: ["分类", "首页", "搜索", "详情", "iframe 解析"],
    // This used to promise that binding a local script archive would make the source run. That
    // feature is gone, so the sentence now states the fact that remains: Moseek does not execute
    // these sources, and nothing the user can do in the app changes that. Naming a switch that no
    // longer exists would send them looking for it.
    reason: "小猫/CatVod JS 源需要脚本运行时，Moseek 不执行远程脚本，只记录和展示配置。",
  },
  "html-http": {
    label: "声明式 HTML 适配器",
    execution: "enabled",
    operations: ["列表", "搜索", "详情", "播放链接"],
    reason: "只请求 HTML 并按 CSS 选择器读取字段，不执行页面 JavaScript。",
  },
  "remote-jar": {
    label: "远程 JAR 依赖",
    execution: "blocked",
    operations: [],
    reason: "远程 JAR 只记录和展示，不下载、不加载、不执行。",
  },
  "drpy-js": {
    label: "Drpy JS 适配器",
    execution: "blocked",
    operations: [],
    // **The old reason said "未提供 JS 沙箱", which was false twice over.** A QuickJS sandbox has
    // existed since the script-runtime sidecar was added, and it is not what is stopping these
    // sources anyway: measured on the author's configuration, 9 of the 10 distinct script addresses
    // are unusable — 404, a dead host, or a host that will not serve the file — and only one of the
    // 56 sources has a script that can be fetched at all. Telling the reader a sandbox is missing
    // sends them looking for a switch that would change nothing.
    //
    // What actually blocks a drpy source is that running it needs a host API layer the sandbox does
    // not provide: `request`, `pdfa`/`pdfh`/`pd`/`jsp` (drpy's selector engine), `CryptoJS`,
    // `getProxyUrl` and the `assets://` module scheme. The per-source truth — whether the script is
    // even reachable — is what 检测脚本地址 reports.
    reason:
      "drpy 脚本需要 request、pdfa/pdfh、CryptoJS 等宿主 API 才能运行；此外脚本地址本身也常常已经失效，可点「检测脚本地址」确认。",
  },
  "spider-runtime": {
    label: "Spider 运行时",
    execution: "blocked",
    operations: [],
    reason: "Spider 需要隔离运行时，当前只记录和展示配置字段。",
  },
  xbpq: {
    label: "XBPQ / XYQHiker 适配器",
    execution: "enabled",
    operations: ["列表", "搜索", "详情", "播放链接"],
    reason:
      "按 URL 模板与文本标记读取页面，不执行脚本或 JAR；嗅探词用于在页面中定位直链。",
  },
  "csp-appmao": {
    label: "csp_AppMao 适配器",
    execution: "blocked",
    operations: [],
    reason: "配置载荷为加密数据，密钥在配套 JAR 中，不执行远程代码就无法读取。",
  },
  "csp-panda": {
    label: "csp_Panda 适配器",
    execution: "enabled",
    operations: ["列表", "搜索", "详情", "播放链接"],
    reason:
      "与 XBPQ 同属声明式配置（键值对形式），按 URL 模板与文本标记读取页面，不执行脚本或 JAR。",
  },
  "csp-xyqhiker": {
    label: "csp_XYQHiker 适配器",
    execution: "enabled",
    operations: ["列表", "搜索", "详情", "播放链接"],
    reason:
      "与 XBPQ 同属声明式配置，按 URL 模板与文本标记读取页面，不执行脚本或 JAR。",
  },
  "private-protocol": {
    label: "私有协议适配器",
    execution: "needs-adapter",
    operations: [],
    reason: "proxy:// 等 TVBox 私有协议需要单独适配器，当前不执行。",
  },
  unknown: {
    label: "未知适配器",
    execution: "needs-adapter",
    operations: [],
    reason: "无法确认安全的执行边界，默认不执行。",
  },
};

export const adapterRegistry: AdapterProfile[] = [
  createProfile("builtin-cms", "cms"),
  createProfile("builtin-live", "live"),
  createProfile("http-extension", "cms"),
  createProfile("http-parser", "parser"),
  createProfile("js-extension", "cms"),
  createProfile("html-http", "cms"),
  createProfile("spider-runtime", "cms"),
  createProfile("remote-jar", "cms"),
  createProfile("drpy-js", "parser"),
  createProfile("xbpq", "parser"),
  createProfile("csp-appmao", "parser"),
  createProfile("csp-panda", "parser"),
  createProfile("csp-xyqhiker", "parser"),
  createProfile("private-protocol", "parser"),
  createProfile("unknown", "parser"),
];

/**
 * Names the CSP/script family for a source, or null when nothing identifies one.
 *
 * Both the key and the api are checked. TVBox gives every one of these families the same
 * `type: 3` shape and lets the operator name the source freely, so the implementation marker
 * lives in whichever field the packager used: `api: "csp_XBPQ"` with an arbitrary `key` such as
 * `fok` is common, and so is `key: "csp_XBPQ"`. Reading only the key misclassified every source
 * of the first kind as a generic spider or a remote-JAR dependency.
 *
 * This used to be written out twice — once for `siteProtocol === "spider"` and once for
 * everything else — with the two copies free to drift.
 */
function remoteScriptFamily(key: string, api: string): AdapterId | null {
  const haystack = `${key} ${api}`;
  if (haystack.includes("drpy")) return "drpy-js";
  if (haystack.includes("xbpq")) return "xbpq";
  if (haystack.includes("appmao")) return "csp-appmao";
  if (haystack.includes("panda")) return "csp-panda";
  if (haystack.includes("xyqhiker")) return "csp-xyqhiker";
  return null;
}

export function getAdapterProfile(
  source: Pick<
    SourceRecord,
    "key" | "api" | "jar" | "sourceType" | "siteProtocol" | "capability"
  >,
): AdapterProfile {
  const key = source.key.toLowerCase();
  const api = source.api.toLowerCase();
  const family = remoteScriptFamily(key, api);
  let id: AdapterId;

  if (source.sourceType === "live") {
    // **A live source is only runnable when its address is one the loader can fetch.** This branch
    // used to answer `builtin-live` unconditionally, and that single answer caused three separate
    // contradictions for a source addressed `./FM.json`:
    //
    // - `isTestableLiveSource` read the execution and said yes, so the row offered a 测试 button and
    //   an 启用 switch; the test then returned `blocked` and the status column read 未执行 — an
    //   address that cannot be requested, presented as a source merely not yet tried.
    // - The 状态 column falls back to `getAdapterProfile(...).execution` for an untestable source,
    //   so it rendered 可执行 directly beside the 适配器 column's 没有可用适配器.
    // - The adapter tab counted these sources as 可执行, inflating that figure.
    //
    // Measured against the author's real database: all 19 sources in that state are live entries
    // whose address is a relative path (`./FM.json`, `./lib/tv/ipv6.m3u`) or a bare token (`yqk`,
    // `csp_MQiTV`, `直播链接自定义`). `private-protocol` is the profile the parser already implies
    // for them — it stores `needs-adapter` with the note 「直播源使用非 HTTP 协议，需要单独适配器，
    // 当前不执行」, which is this profile's own wording.
    id = isFetchableLiveUrl(source.api) ? "builtin-live" : "private-protocol";
  } else if (source.siteProtocol === "http-extension") {
    id = "http-extension";
  } else if (source.siteProtocol === "js-extension") {
    id = "js-extension";
  } else if (source.siteProtocol === "html-http") {
    id = "html-http";
  } else if (family) {
    id = family;
  } else if (source.siteProtocol === "spider") {
    // Only reached when the key names no known family: a bare `type: 3` spider, or one whose
    // only implementation hint is the JAR it wants to download.
    id = source.jar ? "remote-jar" : "spider-runtime";
  } else if (source.jar) {
    id = "remote-jar";
  } else if (
    api.startsWith("proxy://") ||
    source.capability === "needs-adapter"
  ) {
    id = "private-protocol";
  } else if (source.sourceType === "cms" && /^https?:\/\//i.test(source.api)) {
    id = "builtin-cms";
  } else if (
    source.sourceType === "parser" &&
    /^https?:\/\//i.test(source.api)
  ) {
    id = "http-parser";
  } else {
    id = "unknown";
  }

  return createProfile(id, source.sourceType);
}

export function adapterStatusLabel(execution: AdapterExecution) {
  // These must match the words the adapter tab uses for its counts and filter. A reader who
  // clicks "可执行 3 个源" then has to find those three rows, so the badge cannot say 已启用.
  //
  // `needs-adapter` reads 无法适配, not 待适配. The old word promised that support was coming, and
  // measured against the author's configuration that promise was false for every source carrying it:
  // the implementation is compiled into the TVBox client, the payload is encrypted with the key in a
  // JAR, the config points at TVBox's own loopback server, or the address is simply dead. 待适配
  // describes a queue the user is waiting in; 无法适配 describes a state they can act on — delete it,
  // or find another source.
  return {
    enabled: "可执行",
    "needs-adapter": "无法适配",
    blocked: "已阻止",
  }[execution];
}

function createProfile(id: AdapterId, sourceType: SourceType): AdapterProfile {
  return { id, sourceType, ...profiles[id] };
}

/**
 * Whether Moseek has a code path that can actually run this source.
 *
 * **The adapter registry is the authority here, not the stored capability.** These are two answers
 * to two different questions, and asking the wrong one produced a contradiction the user could see:
 * a row reading 部分支持 in the status column while the adapter column said 没有可用适配器. The stored
 * capability records what the parser concluded at import time and is never revisited; the adapter
 * registry is derived from the source as it is now. When they disagree, the live derivation is the
 * one describing the code that would run.
 *
 * Measured on the author's database, 93 of 355 stored capabilities were stale, and 60 sources with a
 * working adapter were untestable purely because their stored capability predated the XBPQ support
 * that now handles them. Those 60 were also missing from the movie library while switched on.
 *
 * `invalid` remains a hard stop: it means the record is missing the fields needed to build a
 * request at all, so no adapter can help.
 */
export function isTestableCmsSource(source: SourceRecord) {
  if (source.sourceType !== "cms" || source.capability === "invalid") {
    return false;
  }
  return getAdapterProfile(source).execution === "enabled";
}

/**
 * Whether a live source's address is one the loader can actually fetch.
 *
 * Mirrors `is_fetchable_live_url` in `src-tauri/src/adapters.rs`, which is the authority: it is the
 * check the live loader and `test_live_source` both apply. A relative path (`./FM.json`), a bare
 * token (`yqk`, `csp_MQiTV`) and a private scheme (`proxy://…`) are all refused there.
 */
export function isFetchableLiveUrl(api: string) {
  const trimmed = api.trim();
  if (!trimmed) return false;
  if (/^(javascript|data|file|shell):/i.test(trimmed)) return false;
  return /^https?:\/\//i.test(trimmed);
}

export function isTestableLiveSource(source: SourceRecord) {
  if (source.sourceType !== "live" || source.capability === "invalid") {
    return false;
  }
  // **The address has to be fetchable, and `getAdapterProfile` is where that is decided.** It used
  // to answer `builtin-live` / `enabled` for any live source — including one addressed `./FM.json`
  // — so this returned true and the row offered a 测试 button and a 启用 switch; the test then came
  // back `blocked` and the status column read 未执行. Measured on the author's configuration, all 19
  // sources in that state were live entries with a relative or bare address.
  //
  // The rule lives in the registry rather than here so that every reader agrees: the 状态 column
  // falls back to the same `execution`, and the adapter tab counts by it. Keeping a second copy of
  // the check here is what let the two columns disagree before.
  return getAdapterProfile(source).execution === "enabled";
}
export function isTestableSource(source: SourceRecord) {
  return isTestableCmsSource(source) || isTestableLiveSource(source);
}

/**
 * Whether a source belongs in the movie library.
 *
 * The only gate is `enabled`. Passing an audit is not a requirement to be listed: auditing is a
 * check the user chooses to run, and a source they have chosen to keep enabled should be
 * selectable whether or not they have run it. Sources that fail or come back empty are switched
 * off by the test run itself, which is what removes them from here.
 *
 * This used to be two functions — one requiring `testStatus === "passed"`, with the other as a
 * fallback when nothing had passed yet. Once the gate became `enabled` alone the two were
 * identical, so the fallback was dead code that ran the same filter twice.
 */
export function isMovieLibrarySource(source: SourceRecord) {
  return source.enabled && isTestableCmsSource(source);
}

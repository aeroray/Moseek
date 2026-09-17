import type { SourceRecord, SourceType } from "@/types/moseek";

export type AdapterExecution =
  | "enabled"
  | "partial"
  | "needs-adapter"
  | "blocked";

export type AdapterId =
  | "builtin-cms"
  | "builtin-live"
  | "http-extension"
  | "http-parser"
  | "js-extension"
  | "local-script"
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
    reason: "识别小猫/CatVod JS 源契约，但当前没有启用脚本沙箱。",
  },
  "local-script": {
    label: "本地脚本适配器",
    execution: "enabled",
    operations: ["分类", "首页", "搜索", "详情", "iframe 解析"],
    reason:
      "用户明确绑定并启用本地脚本档案后，完整调用 CatVod 入口；脚本执行受 sidecar、哈希和 HTTP allowlist 限制。",
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
    reason: "未提供 JS 沙箱，远程 JavaScript 默认禁止执行。",
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
  createProfile("local-script", "cms"),
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
    | "key"
    | "api"
    | "jar"
    | "sourceType"
    | "siteProtocol"
    | "capability"
    | "scriptArchiveId"
  >,
): AdapterProfile {
  const key = source.key.toLowerCase();
  const api = source.api.toLowerCase();
  const family = remoteScriptFamily(key, api);
  let id: AdapterId;

  if (source.sourceType === "live") {
    id = "builtin-live";
  } else if (
    source.scriptArchiveId !== null &&
    source.scriptArchiveId !== undefined
  ) {
    id = "local-script";
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
  return {
    enabled: "已启用",
    partial: "部分启用",
    "needs-adapter": "待适配",
    blocked: "已阻止",
  }[execution];
}

function createProfile(id: AdapterId, sourceType: SourceType): AdapterProfile {
  return { id, sourceType, ...profiles[id] };
}

export function isTestableCmsSource(source: SourceRecord) {
  if (source.sourceType !== "cms" || source.capability === "invalid") {
    return false;
  }
  const profile = getAdapterProfile(source);
  if (source.scriptArchiveId !== null && source.scriptArchiveId !== undefined) {
    return profile.id === "local-script";
  }
  return source.capability === "supported" && profile.execution === "enabled";
}

export function isTestableLiveSource(source: SourceRecord) {
  if (source.sourceType !== "live" || source.capability !== "supported") {
    return false;
  }
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

import type {
  CapabilityStatus,
  SourceRecord,
  SourceType,
} from "@/types/moseek";

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
    execution: "partial",
    operations: ["HTTP 地址解析"],
    reason: "只允许明确的 HTTP/HTTPS 解析接口，不执行私有协议。",
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
    label: "XBPQ 适配器",
    execution: "needs-adapter",
    operations: [],
    reason: "需要专用字段映射和隔离适配器，当前不会执行。",
  },
  "csp-appmao": {
    label: "csp_AppMao 适配器",
    execution: "needs-adapter",
    operations: [],
    reason: "特定 CSP 扩展尚未实现，当前只展示配置字段。",
  },
  "csp-panda": {
    label: "csp_Panda 适配器",
    execution: "needs-adapter",
    operations: [],
    reason: "特定 CSP 扩展尚未实现，当前只展示配置字段。",
  },
  "csp-xyqhiker": {
    label: "csp_XYQHiker 适配器",
    execution: "needs-adapter",
    operations: [],
    reason: "特定 CSP 扩展尚未实现，当前只展示配置字段。",
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

export function getAdapterProfile(
  source: Pick<
    SourceRecord,
    "key" | "api" | "jar" | "sourceType" | "siteProtocol" | "capability"
  >,
): AdapterProfile {
  const key = source.key.toLowerCase();
  const api = source.api.toLowerCase();
  let id: AdapterId;

  if (source.sourceType === "live") {
    id = "builtin-live";
  } else if (source.siteProtocol === "http-extension") {
    id = "http-extension";
  } else if (source.siteProtocol === "spider") {
    if (key.startsWith("drpy_js_") || key.includes("drpy")) {
      id = "drpy-js";
    } else if (key.includes("xbpq")) {
      id = "xbpq";
    } else if (key.includes("appmao")) {
      id = "csp-appmao";
    } else if (key.includes("panda")) {
      id = "csp-panda";
    } else if (key.includes("xyqhiker")) {
      id = "csp-xyqhiker";
    } else if (source.jar) {
      id = "remote-jar";
    } else {
      id = "spider-runtime";
    }
  } else if (key.startsWith("drpy_js_") || key.includes("drpy")) {
    id = "drpy-js";
  } else if (key.includes("xbpq")) {
    id = "xbpq";
  } else if (key.includes("appmao")) {
    id = "csp-appmao";
  } else if (key.includes("panda")) {
    id = "csp-panda";
  } else if (key.includes("xyqhiker")) {
    id = "csp-xyqhiker";
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

export function adapterMatchesCapability(
  profile: AdapterProfile,
  capability: CapabilityStatus,
) {
  if (profile.execution === "blocked")
    return capability === "blocked" || capability === "partial";
  if (profile.execution === "needs-adapter")
    return capability === "needs-adapter";
  return capability === "supported" || capability === "partial";
}

export function isTestableCmsSource(source: SourceRecord) {
  if (
    source.sourceType !== "cms" ||
    source.capability !== "supported"
  ) {
    return false;
  }
  return getAdapterProfile(source).execution === "enabled";
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

export function isMovieLibrarySource(source: SourceRecord) {
  return (
    source.enabled &&
    isTestableCmsSource(source) &&
    source.testStatus === "passed"
  );
}

import JSON5 from "json5";

import {
  RawConfigSchema,
  type RawLive,
  type RawSite,
} from "@/features/config/config-schema";
import { getAdapterProfile } from "@/lib/adapters";
import type { CapabilityStatus, SourceRecord } from "@/types/moseek";

export interface ParseIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
  line: number | null;
  column: number | null;
}

export interface ParseResult {
  ok: boolean;
  sources: SourceRecord[];
  normalizedConfig: string;
  liveCount: number;
  issues: ParseIssue[];
}

export interface ConfigTextTransformResult {
  ok: boolean;
  text: string;
  changes: string[];
  issue: ParseIssue | null;
}

const emptyCounts = {
  supported: 0,
  partial: 0,
  "needs-adapter": 0,
  blocked: 0,
  invalid: 0,
};

export function countParsedCapabilities(sources: SourceRecord[]) {
  return sources.reduce<typeof emptyCounts>(
    (counts, source) => {
      counts[source.capability] += 1;
      return counts;
    },
    { ...emptyCounts },
  );
}

export function parseConfigText(rawText: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON5.parse(rawText);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法解析配置文本";
    const position = extractPosition(message);
    return {
      ok: false,
      sources: [],
      normalizedConfig: "",
      liveCount: 0,
      issues: [
        {
          severity: "error",
          path: "$",
          message,
          line: position.line,
          column: position.column,
        },
      ],
    };
  }

  const validation = RawConfigSchema.safeParse(parsed);
  if (!validation.success) {
    return {
      ok: false,
      sources: [],
      normalizedConfig: "",
      liveCount: 0,
      issues: validation.error.issues.map((issue) => ({
        severity: "error" as const,
        path: issue.path.length > 0 ? issue.path.join(".") : "$",
        message: issue.message,
        line: null,
        column: null,
      })),
    };
  }

  const siteSources = validation.data.sites.map((site, index) =>
    classifySource(site, index),
  );
  const liveSources = validation.data.lives.map((live, index) =>
    classifyLiveSource(live, index),
  );
  const sources = [...siteSources, ...liveSources];
  const normalizedSources = sources.map((source) => {
    const adapter = getAdapterProfile(source);
    return {
      ...source,
      adapterId: adapter.id,
      adapterName: adapter.label,
      adapterExecution: adapter.execution,
      adapterOperations: adapter.operations,
    };
  });
  const rootRecord = validation.data as Record<string, unknown>;
  const blockedRootFields = Object.keys(rootRecord).filter(
    (key) =>
      key === "spider" ||
      key === "ijk" ||
      key.startsWith("csp_") ||
      key.startsWith("drpy_js_"),
  );
  const issues: ParseIssue[] = blockedRootFields.map((field) => ({
    severity: "warning",
    path: field,
    message: "检测到未执行字段，Moseek 只记录和展示，不会运行远程代码。",
    line: null,
    column: null,
  }));
  siteSources.forEach((source, index) => {
    if (source.capability === "invalid") {
      issues.push({
        severity: "error",
        path: `sites.${index}`,
        message: source.capabilityNote,
        line: null,
        column: null,
      });
    } else if (source.capability !== "supported") {
      issues.push({
        severity: "warning",
        path: `sites.${index}`,
        message: source.capabilityNote,
        line: null,
        column: null,
      });
    }
  });
  liveSources.forEach((source, index) => {
    if (source.capability === "invalid") {
      issues.push({
        severity: "error",
        path: `lives.${index}`,
        message: source.capabilityNote,
        line: null,
        column: null,
      });
    } else if (source.capability !== "supported") {
      issues.push({
        severity: "warning",
        path: `lives.${index}`,
        message: source.capabilityNote,
        line: null,
        column: null,
      });
    }
  });

  return {
    ok: true,
    sources,
    normalizedConfig: JSON.stringify(
      {
        schemaVersion: "0.1",
        sites: normalizedSources.filter(
          (source) => source.sourceType !== "live",
        ),
        lives: normalizedSources.filter(
          (source) => source.sourceType === "live",
        ),
        parses: validation.data.parses,
        blockedFields: blockedRootFields,
      },
      null,
      2,
    ),
    liveCount: validation.data.lives.length,
    issues,
  };
}

export function formatConfigText(rawText: string): ConfigTextTransformResult {
  try {
    const parsed = JSON5.parse(rawText);
    return {
      ok: true,
      text: JSON.stringify(parsed, null, 2),
      changes: ["已按 JSON 结构重新排版"],
      issue: null,
    };
  } catch (error) {
    return {
      ok: false,
      text: rawText,
      changes: [],
      issue: createParseIssue(error),
    };
  }
}

export function repairConfigText(rawText: string): ConfigTextTransformResult {
  let repairedText = rawText;
  const changes: string[] = [];

  if (repairedText.startsWith("\uFEFF")) {
    repairedText = repairedText.slice(1);
    changes.push("移除文件 BOM");
  }

  const trimmedText = repairedText.trim();
  if (trimmedText !== repairedText) {
    repairedText = trimmedText;
    changes.push("清理首尾空白");
  }

  const fencedText = repairedText.match(
    /^```(?:json5?|javascript)?\s*\r?\n([\s\S]*?)\r?\n```$/i,
  )?.[1];
  if (fencedText !== undefined) {
    repairedText = fencedText.trim();
    changes.push("移除 Markdown 代码围栏");
  }

  if (repairedText.endsWith(";")) {
    repairedText = repairedText.slice(0, -1).trimEnd();
    changes.push("移除根配置末尾分号");
  }

  const escapedText = escapeNewlinesInsideStrings(repairedText);
  if (escapedText !== repairedText) {
    repairedText = escapedText;
    changes.push("转义字符串中的换行");
  }

  try {
    JSON5.parse(repairedText);
    return {
      ok: true,
      text: repairedText,
      changes: changes.length > 0 ? changes : ["未发现可自动修正的问题"],
      issue: null,
    };
  } catch (error) {
    return {
      ok: false,
      text: rawText,
      changes,
      issue: createParseIssue(error),
    };
  }
}

function createParseIssue(error: unknown): ParseIssue {
  const message = error instanceof Error ? error.message : "无法解析配置文本";
  const position = extractPosition(message);
  return {
    severity: "error",
    path: "$",
    message,
    line: position.line,
    column: position.column,
  };
}

function escapeNewlinesInsideStrings(text: string) {
  let result = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quote) {
      if (character === "\\") {
        result += character;
        const nextCharacter = text[index + 1];
        if (nextCharacter !== undefined) {
          result += nextCharacter;
          index += 1;
        }
      } else if (character === quote) {
        result += character;
        quote = null;
      } else if (character === "\r" || character === "\n") {
        result += "\\n";
        if (character === "\r" && text[index + 1] === "\n") {
          index += 1;
        }
      } else {
        result += character;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      result += character;
    } else {
      result += character;
    }
  }

  return result;
}

function classifySource(site: RawSite, index: number): SourceRecord {
  const key = site.key ?? `invalid-${index + 1}`;
  const name = site.name ?? `未命名源 ${index + 1}`;
  const api = site.api ?? "";
  const siteType = normalizeSiteType(site.type);
  const keyLower = key.toLowerCase();
  const apiLower = api.toLowerCase();
  const serializedSite = JSON.stringify(site).toLowerCase();
  const hasRequiredFields = Boolean(site.key && site.name && site.api);
  const hasRemoteScript =
    keyLower.startsWith("csp_") ||
    keyLower.startsWith("drpy_js_") ||
    serializedSite.includes('"spider"') ||
    serializedSite.includes('"script"');
  const hasDangerousProtocol = /^(javascript|data|file|shell):/i.test(api);
  const hasPrivateProtocol = !/^https?:\/\//i.test(api);
  const hasJar = Boolean(site.jar);
  const hasSpiderAdapter =
    siteType === 3 ||
    hasJar ||
    keyLower.startsWith("csp_") ||
    keyLower.startsWith("drpy_js_") ||
    serializedSite.includes('"spider"') ||
    serializedSite.includes('"script"');
  const siteProtocol = getSiteProtocol(siteType, hasSpiderAdapter);

  let capability: CapabilityStatus;
  let capabilityNote: string;

  if (!hasRequiredFields) {
    capability = "invalid";
    capabilityNote =
      "缺少 key、name 或 api 必填字段，无法建立安全的资源源记录。";
  } else if (
    siteType === 3 ||
    hasJar ||
    hasDangerousProtocol ||
    hasRemoteScript
  ) {
    capability = "blocked";
    capabilityNote =
      siteType === 3
        ? "检测到 TVBox type=3 Spider 运行时，Moseek 只记录和展示，不会执行。"
        : hasJar
          ? "检测到远程 JAR 依赖，Moseek 只记录和展示，不会下载或执行。"
          : "检测到远程脚本或危险协议，Moseek 默认阻止执行。";
  } else if (apiLower.startsWith("proxy://") || hasPrivateProtocol) {
    capability = "needs-adapter";
    capabilityNote = "检测到私有或非 HTTP 协议，需要单独适配器，当前不执行。";
  } else {
    capability = "supported";
    capabilityNote = "普通 HTTP API，可进入搜索、分类、详情和播放地址流程。";
  }

  return {
    key,
    name,
    sourceType: "cms",
    siteType,
    siteProtocol,
    api,
    ext: site.ext,
    jar: site.jar,
    epg: site.epg,
    searchable: site.searchable ?? capability === "supported",
    filterable: site.filterable ?? capability === "supported",
    capability,
    capabilityNote,
    enabled: capability === "supported",
    lastCheckedAt: "刚刚",
    requestCount: 0,
  };
}

function normalizeSiteType(value: RawSite["type"]): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isInteger(parsed) ? parsed : null;
}

function getSiteProtocol(
  siteType: number | null,
  hasSpiderAdapter: boolean,
): SourceRecord["siteProtocol"] {
  if (hasSpiderAdapter || siteType === 3) return "spider";
  if (siteType === 0) return "xml-http";
  if (siteType === 4) return "http-extension";
  if (siteType === 1 || siteType === null) return "json-http";
  return "unknown";
}

function classifyLiveSource(live: RawLive, index: number): SourceRecord {
  const key = live.key ?? `live-${index + 1}`;
  const name = live.name ?? `直播源 ${index + 1}`;
  const api = live.url ?? live.source ?? live.api ?? "";
  const normalizedApi = api.toLowerCase();
  const hasRequiredFields = Boolean(name && api);
  const hasDangerousProtocol = /^(javascript|data|file|shell):/i.test(api);
  const hasPrivateProtocol = !/^https?:\/\//i.test(api);

  let capability: CapabilityStatus;
  let capabilityNote: string;
  if (!hasRequiredFields) {
    capability = "invalid";
    capabilityNote = "直播源缺少 name 或 url/api 字段。";
  } else if (hasDangerousProtocol) {
    capability = "blocked";
    capabilityNote = "直播源使用危险协议，Moseek 默认阻止执行。";
  } else if (hasPrivateProtocol || normalizedApi.startsWith("proxy://")) {
    capability = "needs-adapter";
    capabilityNote = "直播源使用非 HTTP 协议，需要单独适配器，当前不执行。";
  } else {
    capability = "supported";
    capabilityNote = "支持通过 Rust 网络层解析 M3U、TXT 或 JSON 直播频道。";
  }

  return {
    key,
    name,
    sourceType: "live",
    api,
    ext: live.ext,
    epg: live.epg,
    searchable: capability === "supported",
    filterable: capability === "supported",
    capability,
    capabilityNote,
    enabled: capability === "supported",
    lastCheckedAt: "刚刚",
    requestCount: 0,
  };
}

function extractPosition(message: string) {
  const match = message.match(/(?:at|位置)\s+(\d+):(\d+)/i);
  return {
    line: match ? Number(match[1]) : null,
    column: match ? Number(match[2]) : null,
  };
}

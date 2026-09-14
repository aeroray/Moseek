import JSON5 from "json5";

import { RawConfigSchema, type RawSite } from "@/features/config/config-schema";
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

  const sources = validation.data.sites.map((site, index) => classifySource(site, index));
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
  sources.forEach((source, index) => {
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

  return {
    ok: true,
    sources,
    normalizedConfig: JSON.stringify(
      {
        schemaVersion: "0.1",
        sites: sources,
        lives: validation.data.lives,
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

function classifySource(site: RawSite, index: number): SourceRecord {
  const key = site.key ?? `invalid-${index + 1}`;
  const name = site.name ?? `未命名源 ${index + 1}`;
  const api = site.api ?? "";
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

  let capability: CapabilityStatus;
  let capabilityNote: string;

  if (!hasRequiredFields) {
    capability = "invalid";
    capabilityNote = "缺少 key、name 或 api 必填字段，无法建立安全的资源源记录。";
  } else if (hasDangerousProtocol || hasRemoteScript) {
    capability = "blocked";
    capabilityNote = "检测到远程脚本或危险协议，Moseek 默认阻止执行。";
  } else if (hasJar) {
    capability = "partial";
    capabilityNote = "API 部分可用；存在远程 JAR 依赖，Moseek 不会下载或执行。";
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
    sourceType: capability === "supported" || capability === "partial" ? "cms" : "parser",
    api,
    ext: site.ext,
    jar: site.jar,
    searchable:
      site.searchable ??
      (capability === "supported" || capability === "partial"),
    filterable: site.filterable ?? capability === "supported",
    capability,
    capabilityNote,
    enabled: capability === "supported" || capability === "partial",
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

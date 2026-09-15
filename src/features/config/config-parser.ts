import JSON5 from "json5";

import {
  RawConfigSchema,
  type RawLive,
  type RawSite,
} from "@/features/config/config-schema";
import { getAdapterProfile } from "@/lib/adapters";
import type {
  CapabilityStatus,
  ParseServiceRecord,
  SourceDialect,
  SourceRecord,
} from "@/types/moseek";

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
  parseServices: ParseServiceRecord[];
  configDialect: SourceDialect;
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
      parseServices: [],
      configDialect: "tvbox",
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

  const normalizedInput = normalizeConfigShape(parsed);
  const validation = RawConfigSchema.safeParse(normalizedInput.value);
  if (!validation.success) {
    return {
      ok: false,
      sources: [],
      parseServices: [],
      configDialect: normalizedInput.dialect,
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
    classifySource(site, index, normalizedInput.dialect),
  );
  const liveSources = validation.data.lives.map((live, index) =>
    classifyLiveSource(live, index),
  );
  const duplicateKeyIssues = ensureUniqueSourceKeys([
    { section: "sites", sources: siteSources },
    { section: "lives", sources: liveSources },
  ]);
  const sources = [...siteSources, ...liveSources];
  const parseServices = normalizeParseServices(validation.data.parses);
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
  const issues: ParseIssue[] = [
    ...duplicateKeyIssues.map((duplicate) => ({
      severity: "warning" as const,
      path: `${duplicate.section}.${duplicate.index}`,
      message: `检测到重复 key「${duplicate.originalKey}」，已自动改为唯一标识「${duplicate.uniqueKey}」，避免测试和启停状态互相影响。`,
      line: null,
      column: null,
    })),
    ...blockedRootFields.map((field) => ({
      severity: "warning" as const,
      path: field,
      message: "检测到未执行字段，Moseek 只记录和展示，不会运行远程代码。",
      line: null,
      column: null,
    })),
  ];
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
  parseServices.forEach((service, index) => {
    if (service.capability === "invalid") {
      issues.push({
        severity: "error",
        path: `parses.${index}`,
        message: service.capabilityNote,
        line: null,
        column: null,
      });
    } else if (service.capability !== "supported") {
      issues.push({
        severity: "warning",
        path: `parses.${index}`,
        message: service.capabilityNote,
        line: null,
        column: null,
      });
    }
  });

  return {
    ok: true,
    sources,
    parseServices,
    configDialect: normalizedInput.dialect,
    normalizedConfig: JSON.stringify(
      {
        schemaVersion: "0.2",
        configDialect: normalizedInput.dialect,
        sites: normalizedSources.filter(
          (source) => source.sourceType !== "live",
        ),
        lives: normalizedSources.filter(
          (source) => source.sourceType === "live",
        ),
        parses: parseServices,
        blockedFields: blockedRootFields,
      },
      null,
      2,
    ),
    liveCount: validation.data.lives.length,
    issues,
  };
}

export function parseParseServices(configText: string): ParseServiceRecord[] {
  try {
    const value = JSON.parse(configText) as { parses?: unknown };
    return normalizeParseServices(value.parses);
  } catch {
    return [];
  }
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

function classifySource(
  site: RawSite,
  index: number,
  configDialect: SourceDialect,
): SourceRecord {
  const key = site.key ?? site.id ?? `invalid-${index + 1}`;
  const name = site.name ?? `未命名源 ${index + 1}`;
  const api = site.api ?? "";
  const siteType = normalizeSiteType(site.type);
  const sourceDialect = getSourceDialect(site, configDialect);
  const keyLower = key.toLowerCase();
  const apiLower = api.toLowerCase();
  const serializedSite = JSON.stringify(site).toLowerCase();
  const hasRequiredFields = Boolean(site.key && site.name && site.api);
  const hasJsExtension = isJsExtensionSource(site, sourceDialect);
  const hasHtmlSource = isHtmlSource(site);
  const hasHtmlMapping = hasHtmlSource && hasHtmlAdapterConfig(site);
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
  const siteProtocol = getSiteProtocol(
    siteType,
    hasSpiderAdapter,
    hasJsExtension,
    hasHtmlSource,
  );

  let capability: CapabilityStatus;
  let capabilityNote: string;

  if (!hasRequiredFields) {
    capability = "invalid";
    capabilityNote =
      "缺少 key、name 或 api 必填字段，无法建立安全的资源源记录。";
  } else if (hasHtmlSource && !hasHtmlMapping) {
    capability = "needs-adapter";
    capabilityNote =
      "声明式 HTML 源缺少有效的 itemSelector 或 fields 映射，当前只记录配置。";
  } else if (
    siteType === 3 ||
    hasJar ||
    hasJsExtension ||
    hasDangerousProtocol ||
    hasRemoteScript
  ) {
    capability = "blocked";
    capabilityNote = hasJsExtension
      ? "检测到小猫/CatVod JS 扩展源，Moseek 当前只保留契约和元数据，不执行远程脚本。"
      : siteType === 3
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
    scriptArchiveId: normalizeOptionalNumber(site.scriptArchiveId),
    sourceDialect,
    siteType,
    siteProtocol,
    api,
    logo: site.logo,
    description: site.description ?? site.desc,
    nsfw: site.nsfw ?? false,
    status: site.status ?? true,
    ext: site.ext,
    extra: site.extra,
    jar: site.jar,
    epg: site.epg,
    searchable: site.searchable ?? capability === "supported",
    filterable: site.filterable ?? capability === "supported",
    capability,
    capabilityNote,
    testStatus: "untested",
    enabled: (site.status ?? true) && capability === "supported",
    lastCheckedAt: "刚刚",
    requestCount: 0,
  };
}

function ensureUniqueSourceKeys(
  sourceGroups: Array<{
    section: "sites" | "lives";
    sources: SourceRecord[];
  }>,
) {
  const usedKeys = new Set<string>();
  const nextSuffixByBase = new Map<string, number>();
  const duplicates: Array<{
    section: "sites" | "lives";
    index: number;
    originalKey: string;
    uniqueKey: string;
  }> = [];

  sourceGroups.forEach(({ section, sources: groupedSources }) => {
    groupedSources.forEach((source, index) => {
      const originalKey = source.key;
      let suffix = nextSuffixByBase.get(originalKey) ?? 2;
      let uniqueKey = originalKey;

      while (usedKeys.has(uniqueKey)) {
        uniqueKey = `${originalKey}-${suffix}`;
        suffix += 1;
      }

      nextSuffixByBase.set(originalKey, suffix);
      usedKeys.add(uniqueKey);
      if (uniqueKey === originalKey) return;

      source.key = uniqueKey;
      duplicates.push({
        section,
        index,
        originalKey,
        uniqueKey,
      });
    });
  });

  return duplicates;
}

function normalizeSiteType(value: RawSite["type"]): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) ? parsed : null;
}

function getSiteProtocol(
  siteType: number | null,
  hasSpiderAdapter: boolean,
  hasJsExtension: boolean,
  hasHtmlSource: boolean,
): SourceRecord["siteProtocol"] {
  if (hasJsExtension) return "js-extension";
  if (hasHtmlSource) return "html-http";
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
    sourceDialect: "tvbox",
    api,
    logo: live.logo,
    status: live.status ?? true,
    ext: live.ext,
    epg: live.epg,
    searchable: capability === "supported",
    filterable: capability === "supported",
    capability,
    capabilityNote,
    testStatus: "untested",
    enabled: (live.status ?? true) && capability === "supported",
    lastCheckedAt: "刚刚",
    requestCount: 0,
  };
}

function normalizeConfigShape(parsed: unknown): {
  value: unknown;
  dialect: SourceDialect;
} {
  if (Array.isArray(parsed)) {
    return {
      value: {
        sites: parsed.map(normalizeSiteShape),
        lives: [],
        parses: [],
      },
      dialect: "kitty",
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { value: parsed, dialect: "tvbox" };
  }

  const object = parsed as Record<string, unknown>;
  const sites = Array.isArray(object.sites) ? object.sites : [];
  const data = Array.isArray(object.data) ? object.data : [];
  const hasSites = Object.prototype.hasOwnProperty.call(object, "sites");
  const hasKittyShape = Object.prototype.hasOwnProperty.call(object, "data");
  const normalizedSites =
    hasSites && !Array.isArray(object.sites)
      ? object.sites
      : [...sites, ...data].map(normalizeSiteShape);
  return {
    value: {
      ...object,
      sites: normalizedSites,
    },
    dialect: hasKittyShape ? (sites.length > 0 ? "mixed" : "kitty") : "tvbox",
  };
}

function normalizeSiteShape(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const site = value as Record<string, unknown>;
  return {
    ...site,
    key:
      site.key ??
      (typeof site.id === "string" || typeof site.id === "number"
        ? String(site.id)
        : undefined),
  };
}

function getSourceDialect(
  site: RawSite,
  configDialect: SourceDialect,
): SourceDialect {
  const extra = parseObject(site.extra);
  if (extra && typeof extra.js === "object" && extra.js !== null) {
    return "kitty";
  }
  return configDialect === "mixed" ? "mixed" : configDialect;
}

function isJsExtensionSource(site: RawSite, sourceDialect: SourceDialect) {
  const extra = parseObject(site.extra);
  return (
    sourceDialect === "kitty" &&
    (normalizeSiteType(site.type) === 1 ||
      (extra !== null && typeof extra.js === "object" && extra.js !== null))
  );
}

function isHtmlSource(site: RawSite) {
  const type =
    typeof site.type === "string" ? site.type.toLowerCase() : site.type;
  return type === 5 || type === "html" || Boolean(getHtmlAdapterConfig(site));
}

function hasHtmlAdapterConfig(site: RawSite) {
  const config = getHtmlAdapterConfig(site);
  if (!config || typeof config !== "object") return false;
  const itemSelector = config.itemSelector;
  const fields = config.fields;
  return (
    typeof itemSelector === "string" &&
    itemSelector.trim().length > 0 &&
    fields !== null &&
    typeof fields === "object" &&
    !Array.isArray(fields)
  );
}

function getHtmlAdapterConfig(site: RawSite) {
  const candidates = [parseObject(site.ext), parseObject(site.extra)].filter(
    (value): value is Record<string, unknown> => value !== null,
  );
  for (const candidate of candidates) {
    const nested = candidate.html;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
    const adapter = candidate.adapter ?? candidate.format ?? candidate.type;
    if (typeof adapter === "string" && adapter.toLowerCase() === "html") {
      return candidate;
    }
  }
  return null;
}

function normalizeParseServices(values: unknown): ParseServiceRecord[] {
  if (!Array.isArray(values)) return [];
  return values.map((value, index) => {
    const object =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const url =
      typeof value === "string"
        ? value.trim()
        : textValue(object, ["url", "api", "parse", "jiexiUrl", "serviceUrl"]);
    const key = textValue(object, ["key", "id"]) || `parse-${index + 1}`;
    const name =
      textValue(object, ["name", "title"]) || `解析服务 ${index + 1}`;
    const method = (textValue(object, ["method"]) || "GET").toUpperCase();
    const capability = !url
      ? "invalid"
      : !/^https?:\/\//i.test(url)
        ? "blocked"
        : method !== "GET"
          ? "needs-adapter"
          : "supported";
    const capabilityNote = !url
      ? "解析服务缺少 HTTP URL。"
      : !/^https?:\/\//i.test(url)
        ? "解析服务使用非 HTTP 协议，Moseek 默认阻止执行。"
        : method !== "GET"
          ? "当前只执行 GET 解析服务，其他方法只记录配置。"
          : "允许通过受限 GET 请求提交待解析地址。";
    return {
      key,
      name,
      url,
      method,
      headers: scalarRecord(object?.headers),
      enabled: capability === "supported" && object?.enabled !== false,
      capability,
      capabilityNote,
    };
  });
}

function parseObject(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function textValue(value: Record<string, unknown> | null, keys: string[]) {
  if (!value) return "";
  for (const key of keys) {
    const candidate = value[key];
    if (
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    ) {
      const text = String(candidate).trim();
      if (text) return text;
    }
  }
  return "";
}

function scalarRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce(
    (result, [key, candidate]) => {
      if (
        typeof candidate === "string" ||
        typeof candidate === "number" ||
        typeof candidate === "boolean"
      ) {
        result[key] = String(candidate);
      }
      return result;
    },
    {} as Record<string, string>,
  );
}

function extractPosition(message: string) {
  const match = message.match(/(?:at|位置)\s+(\d+):(\d+)/i);
  return {
    line: match ? Number(match[1]) : null,
    column: match ? Number(match[2]) : null,
  };
}

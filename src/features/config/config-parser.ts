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

export const MAX_CONFIG_TEXT_BYTES = 10 * 1024 * 1024;

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

export function parseConfigText(
  rawText: string,
  baseUrl?: string,
): ParseResult {
  const sizeIssue = createSizeIssue(rawText);
  if (sizeIssue) {
    return {
      ok: false,
      sources: [],
      parseServices: [],
      configDialect: "tvbox",
      normalizedConfig: "",
      liveCount: 0,
      issues: [sizeIssue],
    };
  }
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
    classifySource(site, index, normalizedInput.dialect, baseUrl),
  );
  const liveSources = validation.data.lives.map((live, index) =>
    classifyLiveSource(live, index, baseUrl),
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
  const sizeIssue = createSizeIssue(rawText);
  if (sizeIssue) {
    return { ok: false, text: rawText, changes: [], issue: sizeIssue };
  }
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
  const sizeIssue = createSizeIssue(rawText);
  if (sizeIssue) {
    return { ok: false, text: rawText, changes: [], issue: sizeIssue };
  }
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

function createSizeIssue(rawText: string): ParseIssue | null {
  if (rawText.length <= MAX_CONFIG_TEXT_BYTES) return null;
  return {
    severity: "error",
    path: "$",
    message: `配置文本超过 ${MAX_CONFIG_TEXT_BYTES / 1024 / 1024} MiB 限制。`,
    line: null,
    column: null,
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
  baseUrl?: string,
): SourceRecord {
  const key = site.key ?? site.id ?? `invalid-${index + 1}`;
  const name = site.name ?? `未命名源 ${index + 1}`;
  const api = resolveConfiguredUrl(site.api ?? "", baseUrl);
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
  const hasXbpqConfig = siteHasXbpqConfig(site);
  const siteProtocol = getSiteProtocol(
    siteType,
    hasSpiderAdapter,
    hasJsExtension,
    hasHtmlSource,
    hasXbpqConfig,
  );

  let capability: CapabilityStatus;
  let capabilityNote: string;

  if (!hasRequiredFields) {
    capability = "invalid";
    capabilityNote =
      "缺少 key、name 或 api 必填字段，无法建立安全的源记录。";
  } else if (hasXbpqConfig) {
    // Checked before the spider/JAR branch: these sources are `type: 3` and ship a JAR, but the
    // configuration Moseek reads is declarative, so they are supported without executing
    // anything. The JAR is still never downloaded or run.
    capability = "supported";
    capabilityNote =
      "识别到 XBPQ/XYQHiker 声明式配置，按 URL 模板与文本标记读取页面，不执行脚本或 JAR。";
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
  hasXbpqConfig: boolean,
): SourceRecord["siteProtocol"] {
  // Checked before the spider test: an XBPQ source is `type: 3` and usually ships a JAR, so the
  // spider test would claim it. Its configuration is declarative, which is what matters.
  if (hasXbpqConfig) return "xbpq";
  if (hasJsExtension) return "js-extension";
  if (hasHtmlSource) return "html-http";
  if (hasSpiderAdapter || siteType === 3) return "spider";
  if (siteType === 0) return "xml-http";
  if (siteType === 4) return "http-extension";
  if (siteType === 1 || siteType === null) return "json-http";
  return "unknown";
}

function classifyLiveSource(
  live: RawLive,
  index: number,
  baseUrl?: string,
): SourceRecord {
  const key = live.key ?? `live-${index + 1}`;
  const name = live.name ?? `直播源 ${index + 1}`;
  const api = resolveConfiguredUrl(
    live.url ?? live.source ?? live.api ?? "",
    baseUrl,
  );
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

/**
 * Whether a source carries an XBPQ / XYQHiker declarative configuration.
 *
 * These are `type: 3` sources with a JAR, so they read as spiders, but the `ext` they carry is a
 * vocabulary of URL templates and text markers rather than code. Two shapes exist: the JSON
 * inline in `ext`, and — more commonly — a URL that serves it. Both are recognised, and both are
 * gated on the marker keys actually being present, so a spider whose `ext` is unrelated is not
 * claimed.
 *
 * The marker keys checked here are the ones the adapter requires in order to do anything at all:
 * without a listing URL and a record separator there is no way to read a page.
 */
function siteHasXbpqConfig(site: RawSite) {
  const candidates = [parseObject(site.ext), parseObject(site.extra)].filter(
    (value): value is Record<string, unknown> => value !== null,
  );
  for (const candidate of candidates) {
    if (isXbpqVocabulary(candidate)) return true;
  }
  // The `key:value,key:value` form that csp_Panda uses for the same vocabulary.
  for (const raw of [site.ext, site.extra]) {
    if (typeof raw === "string" && isXbpqPairConfig(raw)) return true;
  }
  // The URL form: `ext` is a plain string pointing at the JSON. It cannot be fetched while
  // parsing the config (that would make import depend on every remote host), so it is accepted
  // on the strength of the api naming the family.
  const api = site.api ?? "";
  return /^csp_(XBPQ|XYQHiker|Panda)/i.test(api.trim());
}

/**
 * Whether a raw `ext` string is the inline `key:value,key:value` form of the same vocabulary.
 *
 * Narrow on purpose: a known key must precede the first `:`, so a URL (whose scheme's colon is
 * not preceded by a key name) is never mistaken for configuration.
 */
function isXbpqPairConfig(raw: string) {
  const head = raw.split(",")[0] ?? "";
  const separator = head.indexOf(":");
  if (separator <= 0) return false;
  const key = head.slice(0, separator).trim();
  if (!key || key.includes("/") || key.includes(" ")) return false;
  return XBPQ_CONFIG_KEYS.has(key);
}

const XBPQ_CONFIG_KEYS = new Set([
  "分类url",
  "搜索url",
  "分类",
  "分类值",
  "数组",
  "搜索数组",
  "标题",
  "图片",
  "线路数组",
  "播放数组",
  "简介",
  "嗅探词",
]);

function isXbpqVocabulary(value: Record<string, unknown>) {
  // Only the listing address is genuinely required: without it there is nothing to request. The
  // record separator is preferred but not mandatory — a real imported configuration omits it and
  // relies on the runtime's own default, so the adapter falls back to reading the page's detail
  // links.
  const hasListing =
    (typeof value["分类url"] === "string" && value["分类url"] !== "") ||
    (typeof value["搜索url"] === "string" && value["搜索url"] !== "");
  return hasListing;
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
    const supportsMethod = method === "GET" || method === "POST";
    const capability = !url
      ? "invalid"
      : !/^https?:\/\//i.test(url)
        ? "blocked"
        : !supportsMethod
          ? "needs-adapter"
          : "supported";
    const capabilityNote = !url
      ? "解析服务缺少 HTTP URL。"
      : !/^https?:\/\//i.test(url)
        ? "解析服务使用非 HTTP 协议，Moseek 默认阻止执行。"
        : !supportsMethod
          ? "当前只执行 GET 或 POST 解析服务，其他方法只记录配置。"
          : method === "POST"
            ? "允许通过受限 JSON POST 请求提交待解析地址。"
            : "允许通过受限 GET 请求提交待解析地址。";
    return {
      key,
      name,
      url,
      method,
      headers: scalarRecord(object?.headers),
      body:
        object?.body &&
        typeof object.body === "object" &&
        !Array.isArray(object.body)
          ? (object.body as Record<string, unknown>)
          : undefined,
      enabled: capability === "supported" && object?.enabled !== false,
      capability,
      capabilityNote,
    };
  });
}

/**
 * Unwraps a TVBox local-proxy URL into the address it actually points at.
 *
 * Many published configurations route every source through the TVBox client's own loopback
 * proxy, e.g. `http://127.0.0.1:9978/proxy?do=live&url=https://example.com/list.m3u`. That
 * address only works while the TVBox app is running on this machine, so fetching it directly is
 * both wrong (the proxy is not there) and refused by the address policy, which reports it as
 * "local addresses are not authorised" — a message that describes our rule rather than the real
 * problem. The `url` parameter is the source's actual address, so it is used instead.
 *
 * Only the loopback wrapper is unwrapped, and only when it carries a usable http(s) target.
 * Anything else is returned untouched so nothing is silently rewritten.
 */
export function unwrapLocalProxyUrl(value: string) {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0";
  if (!isLoopback) return trimmed;
  // `url` is the parameter TVBox uses; `target` appears in a few variants.
  const target = parsed.searchParams.get("url") ?? parsed.searchParams.get("target");
  if (!target) return trimmed;
  const decoded = target.trim();
  return /^https?:\/\//i.test(decoded) ? decoded : trimmed;
}

function resolveConfiguredUrl(value: string, baseUrl?: string) {
  const trimmed = unwrapLocalProxyUrl(value);
  if (!trimmed || !baseUrl || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
    return trimmed;
  }
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      return trimmed;
    }
    const resolved = new URL(trimmed, base);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : trimmed;
  } catch {
    return trimmed;
  }
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

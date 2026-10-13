import JSON5 from "json5";

import {
  RAW_FLAG_FIELDS,
  RawConfigSchema,
  RawLiveSchema,
  RawSiteSchema,
  type RawLive,
  type RawSite,
} from "@/features/config/config-schema";
import { getAdapterProfile, isPermanentlyUnsupported } from "@/lib/adapters";
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
      message: `有两条源用了同一个标识「${duplicate.originalKey}」，已自动区分开。`,
      line: null,
      column: null,
    })),
    ...blockedRootFields.map((field) => ({
      severity: "warning" as const,
      path: field,
      message: "配置里有拾影不运行的内容，只会记录下来。",
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

/**
 * Reads configuration text into a plain object, for merging.
 *
 * Returns null when the text is not an object. Merging has to work on the same parse the rest of
 * the parser uses, or the two would disagree about what a configuration contains; JSON5 rather than
 * JSON because published configurations routinely carry comments and trailing commas.
 */
export function parseRawObject(
  text: string,
): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON5.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface PruneResult {
  raw: Record<string, unknown>;
  removed: number;
}

/**
 * Removes entries Moseek will never be able to run.
 *
 * The user's decision, in their own words: an adapter we cannot support has no business staying on
 * screen, because recognising it tells the reader nothing and this application is never going to
 * implement it. Five such adapters used to be listed — drpy, AppMao, remote JAR, spider and CatVod
 * JS — and an entry belonging to one of them now belongs nowhere: it is dropped from the
 * configuration, so it is gone from the list, from the export and from the file.
 *
 * **The verdict comes from the parser's own classifier, not from a second copy of the rules.** That
 * is why this lives beside it: the parser already knows that a `type: 3` entry carrying a declarative
 * vocabulary is XBPQ (readable) while a `type: 3` entry carrying a script address is a spider (not),
 * and that distinction is buried in dozens of real-world shape checks. Re-deriving it here would
 * eventually disagree with the parser, and the disagreement would delete working sources from a
 * user's file — the worst outcome this function could have.
 *
 * Only the source collections are touched. `parses` holds playback resolvers rather than sources, and
 * a bare `proxy://` scheme is left alone: it is not a family we have decided against.
 *
 * The document keeps its own shape: an entry that lived under Kitty's `data` stays there, and a
 * collection the file did not have is not invented.
 */
export function pruneUnsupportedEntries(
  raw: Record<string, unknown>,
  baseUrl?: string | null,
): PruneResult {
  // The dialect decides whether an entry is a CatVod JS extension, so it has to come from the same
  // reading of the document the parser uses.
  const { dialect } = normalizeConfigShape(raw);
  // The classifiers take `string | undefined`; every caller here naturally has a nullable base URL.
  const base = baseUrl ?? undefined;

  let removed = 0;
  const next: Record<string, unknown> = { ...raw };

  // Each collection is pruned on its own terms, keeping the document's own spelling: `sites` and
  // Kitty's `data` are two keys holding the same kind of entry, and a file that uses one does not
  // get the other invented for it.
  const pruneSiteCollection = (key: "sites" | "data") => {
    const entries = raw[key];
    if (!Array.isArray(entries)) return;
    const survivors = entries.filter((entry, index) => {
      const parsed = RawSiteSchema.safeParse(entry);
      // An entry the schema cannot read is left alone rather than removed: failing to understand
      // something is not evidence that it is unsupported, and this function's whole risk is
      // deleting a source that works.
      if (!parsed.success) return true;
      const source = classifySource(parsed.data, index, dialect, base);
      if (!isPermanentlyUnsupported(recordInput(source))) return true;
      removed += 1;
      return false;
    });
    next[key] = survivors;
  };

  pruneSiteCollection("sites");
  pruneSiteCollection("data");

  if (Array.isArray(raw.lives)) {
    next.lives = raw.lives.filter((entry, index) => {
      const parsed = RawLiveSchema.safeParse(entry);
      if (!parsed.success) return true;
      const source = classifyLiveSource(parsed.data, index, base);
      if (!isPermanentlyUnsupported(recordInput(source))) return true;
      removed += 1;
      return false;
    });
  }

  if (removed === 0) return { raw, removed: 0 };
  return { raw: next, removed };
}

/**
 * The fields `isPermanentlyUnsupported` reads, taken from a classified record.
 *
 * Delegates to the registry's own adapter for records so the two cannot drift; kept as a local name
 * because this file classifies raw entries into records and then asks the question immediately.
 */
function recordInput(source: SourceRecord) {
  return {
    key: source.key,
    api: source.api,
    jar: source.jar,
    siteProtocol: source.siteProtocol ?? null,
    siteType: source.siteType ?? null,
    isLive: source.sourceType === "live",
  };
}

/**
 * The text form of `pruneUnsupportedEntries`, for the paths that hold a document as text.
 *
 * Text, its source list and its normalised form are three views of one document, so they have to be
 * pruned **before** the text is parsed: pruning the list afterwards would leave the unsupported
 * entries in the file, which is the "the list says one thing and the configuration says another"
 * failure this project has fixed repeatedly.
 *
 * A document that cannot be read is returned untouched with `removed: 0`. That is the safe
 * direction: failing to understand a file is not evidence that anything in it is unusable, and this
 * function's only real risk is deleting a source that works.
 */
export function pruneUnsupportedConfigText(
  text: string,
  baseUrl?: string | null,
): { text: string; removed: number } {
  const raw = parseRawObject(text);
  if (!raw) return { text, removed: 0 };
  const { raw: pruned, removed } = pruneUnsupportedEntries(raw, baseUrl);
  if (removed === 0) return { text, removed: 0 };
  return { text: JSON.stringify(pruned, null, 2), removed };
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

/**
 * Coerces flag fields that were written as strings into real booleans.
 *
 * The repair pass used to handle syntax only — BOM, stray whitespace, Markdown fences, a trailing
 * semicolon, unescaped newlines — and then declare "未发现可自动修正的问题" while the document was
 * still unparseable. Measured: a site carrying `"searchable": "true"` failed validation with
 * "Invalid input: expected boolean, received string", and 自动修正 left the string exactly where it
 * was. That is the user-visible behaviour of a button that promises to fix things and does not, so a
 * repair that only understands syntax has to be honest about it or grow to understand types.
 *
 * Only the five known flag names are touched, and only when their value is one of the spellings a
 * real configuration uses. Anything else is left alone: a repair that rewrites fields it does not
 * understand can turn a working configuration into a different one.
 */
function coerceStringFlags(parsed: unknown): number {
  let repaired = 0;

  const visitEntry = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    for (const field of RAW_FLAG_FIELDS) {
      const value = record[field];
      if (typeof value !== "string") continue;
      const normalised = value.trim().toLowerCase();
      if (normalised === "true" || normalised === "1") {
        record[field] = true;
        repaired += 1;
      } else if (normalised === "false" || normalised === "0") {
        record[field] = false;
        repaired += 1;
      }
    }
  };

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  const root = parsed as Record<string, unknown>;
  for (const section of ["sites", "lives", "data"]) {
    const list = root[section];
    if (Array.isArray(list)) list.forEach(visitEntry);
  }
  return repaired;
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
    changes.push("去掉文件开头的隐藏字符");
  }

  const trimmedText = repairedText.trim();
  if (trimmedText !== repairedText) {
    repairedText = trimmedText;
    changes.push("去掉首尾多余的空行");
  }

  const fencedText = repairedText.match(
    /^```(?:json5?|javascript)?\s*\r?\n([\s\S]*?)\r?\n```$/i,
  )?.[1];
  if (fencedText !== undefined) {
    repairedText = fencedText.trim();
    changes.push("去掉多余的代码标记");
  }

  if (repairedText.endsWith(";")) {
    repairedText = repairedText.slice(0, -1).trimEnd();
    changes.push("去掉末尾多余的分号");
  }

  // A key that lost its opening quote.
  //
  // Measured on 肥猫's published file: exactly two keys read `ext": {` instead of `"ext": {`, on lines
  // 124 and 143, and quoting those two makes the whole document parse into 39 sites and 2 lives. The
  // publisher's typo otherwise costs the user the entire configuration, and the failure message —
  // `invalid character '"' at 125:4` — points at the symptom rather than the cause.
  //
  // Narrow on purpose: only a bare identifier at the start of a line, immediately followed by `":`.
  // That shape cannot occur in valid JSON (a key always opens with a quote, and a value on its own
  // line is not followed by `:`), so this cannot corrupt a document that was already correct.
  //
  // This runs BEFORE the newline-escaping pass, and the order is load-bearing. Escaping first rewrote
  // the malformed line (`ext": {` became `ext": {\n`, pulling the brace onto the next line) so that
  // only one of the two keys still matched the pattern, and the document stayed unparseable with a
  // new error at a new line — the same class of "the fix did not fix it" the user reported about the
  // repair button. The quote repair has to see the text as published.
  const quotedText = repairedText.replace(
    /^(\s*)([A-Za-z_][A-Za-z0-9_]*)"(\s*:)/gm,
    '$1"$2"$3',
  );
  if (quotedText !== repairedText) {
    const count = (repairedText.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)"(\s*:)/gm) ?? []).length;
    repairedText = quotedText;
    changes.push(`补上 ${count} 处缺失的引号`);
  }

  const escapedText = escapeNewlinesInsideStrings(repairedText);
  if (escapedText !== repairedText) {
    repairedText = escapedText;
    changes.push("修正多余的换行");
  }

  try {
    const parsed = JSON5.parse(repairedText) as unknown;
    // The syntax is now readable, so the type pass can run: a string spelling of a flag is the other
    // thing that makes a document fail validation, and it is not visible to a syntax parser.
    const coerced = coerceStringFlags(parsed);
    if (coerced > 0) {
      repairedText = JSON.stringify(parsed, null, 2);
      changes.push(`修正 ${coerced} 处开关写法`);
    }
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
    message: `配置文件太大（超过 ${MAX_CONFIG_TEXT_BYTES / 1024 / 1024} MB），无法导入。`,
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
    capabilityNote = "这条源缺少必要信息，无法使用。";
  } else if (hasXbpqConfig) {
    // Checked before the spider/JAR branch: these sources are `type: 3` and ship a JAR, but the
    // configuration Moseek reads is declarative, so they are supported without executing
    // anything. The JAR is still never downloaded or run.
    capability = "supported";
    capabilityNote = "这种源可以直接读取，不需要额外程序。";
  } else if (hasHtmlSource && !hasHtmlMapping) {
    capability = "needs-adapter";
    capabilityNote = "这条源缺少读取规则，暂时无法使用。";
  } else if (
    siteType === 3 ||
    hasJar ||
    hasJsExtension ||
    hasDangerousProtocol ||
    hasRemoteScript
  ) {
    capability = "blocked";
    capabilityNote = hasJsExtension || siteType === 3
      ? "这种源需要额外程序，拾影只记录，不会运行。"
      : hasJar
        ? "这种源需要下载额外程序，拾影不会下载或运行。"
        : "这种源不安全，拾影不会运行。";
  } else if (apiLower.startsWith("proxy://") || hasPrivateProtocol) {
    capability = "needs-adapter";
    capabilityNote = "这种源的地址格式暂不支持。";
  } else {
    capability = "supported";
    capabilityNote = "可以正常使用，支持搜索、分类和播放。";
  }

  return {
    key,
    name,
    sourceType: "cms",
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

/**
 * Unwraps a TVBox `proxy://` line into the address it really points at.
 *
 * **A second spelling of the same idea as `unwrapLocalProxyUrl` above, and it needs its own reader.**
 * That one handles the HTTP form — `http://127.0.0.1:9978/proxy?do=live&url=<address>` — which is what
 * published configurations usually carry. This one handles the private scheme form, which is what the
 * user's configuration carries:
 *
 *     proxy://do=live&type=txt&ext=aHR0cDovL2hvbWUuanVuZGllLnRvcDo4MS9DYXQvdHYvbGl2ZS50eHQ=
 *
 * The shape is TVBox's: the `ext` parameter holds the address **base64-encoded**, and `do=live` says
 * what to do with it. Measured against the user's own entry, decoding `ext` yields
 * `http://home.jundie.top:81/Cat/tv/live.txt`, which is the same host their other working live sources
 * use — so the address is real and this is the only thing that was not being read.
 *
 * **Only `do=live` with an `http(s)` result is unwrapped.** A `proxy://` line pointing at TVBox's own
 * local server (`do=parse`, `do=danmaku`) is not a playlist, and returning a decoded address for it
 * would claim a source is usable when nothing can fetch it. Anything unrecognised is returned
 * unchanged, which leaves it classified as a private protocol — the honest answer.
 */
export function unwrapLiveProxyLine(value: string): string {
  const trimmed = value.trim();
  if (!/^proxy:\/\//i.test(trimmed)) return trimmed;

  // **The parameters are the path, not the query.** `proxy://do=live&type=txt&ext=…` has no `?`, so a
  // URL parser reads `do=live&type=txt&ext=…` as the HOST and `searchParams` comes back empty — the
  // first version of this did exactly that and silently decoded nothing. The text after the scheme is
  // taken verbatim and parsed as a query string instead.
  const rawParams = trimmed.slice("proxy://".length);
  const action = readRawParameter(rawParams, "do");
  if (action.toLowerCase() !== "live") return trimmed;

  // **`ext` is read from the raw text rather than from `params`.** The value is base64 followed by an
  // optional template, and the template's parameters are separated by `&` — which is also what
  // separates the proxy's own parameters. `URLSearchParams` therefore splits `ext` at the first `&`
  // and returns only the head of the template, dropping `&date={date}`. The first version of this did
  // exactly that; the test caught it.
  const ext = readRawParameter(rawParams, "ext");
  if (!ext) return trimmed;

  // Both forms appear: the bare base64 payload, and the same payload with `?ch={name}` template
  // suffixes that TVBox consumes itself. Only the base64 head is decoded, and the remainder is kept
  // when it is a usable template — dropping it would lose a per-channel guide address.
  const suffixIndex = ext.search(/[?&#]/);
  const head = suffixIndex >= 0 ? ext.slice(0, suffixIndex) : ext;
  const suffix = suffixIndex >= 0 ? ext.slice(suffixIndex) : "";

  const decoded = decodeBase64Text(head);
  if (!decoded) return trimmed;
  const address = decoded.trim();
  if (!/^https?:\/\//i.test(address)) return trimmed;

  // **A payload pointing back at the client's own server is not usable here.** The base64 sometimes
  // holds the other spelling of a local proxy rather than a real list address. Returning it would
  // claim the source is fetchable when the thing it names only exists while TVBox itself is running,
  // so it is left wrapped and stays classified as a private protocol.
  if (isLoopbackOrLocal(address)) return trimmed;

  return `${address}${suffix}`;
}

/** Whether an address names this machine or a private network. */
function isLoopbackOrLocal(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Decodes base64 that may be standard or URL-safe, padded or not.
 *
 * TVBox writes the payload with whatever produced it, and both alphabets appear in the wild. Node and
 * the browser disagree about `atob` for the URL-safe alphabet and about missing padding, so both are
 * normalised first. Returns `null` rather than throwing: a `proxy://` line that is not base64 is
 * simply not one of these, and this function's caller already has an answer for that.
 */
function decodeBase64Text(value: string): string | null {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised.padEnd(
    normalised.length + ((4 - (normalised.length % 4)) % 4),
    "=",
  );
  try {
    // `atob` yields binary; the payload is UTF-8 text.
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads one parameter out of a `key=value&key=value` string, without splitting inside a nested value.
 *
 * **Written by hand because `URLSearchParams` cannot express this.** The `ext` parameter's value is
 * base64 followed by a template whose own parameters are `&`-separated — and the template's parameters
 * look exactly like the proxy's. What distinguishes them is that the template starts after a `?`:
 *
 *     do=live&type=txt&ext=<base64>?ch={name}&date={date}
 *                                        ↑ the nested part begins here
 *
 * So parsing walks the string and treats everything after a `?` as part of the preceding value. That
 * is the shape TVBox writes, and the alternative — `URLSearchParams` — silently truncated the value at
 * the first `&`, which the test for the template suffix caught.
 */
function readRawParameter(source: string, name: string): string {
  let index = 0;
  while (index < source.length) {
    const equals = source.indexOf("=", index);
    if (equals < 0) break;
    const key = source.slice(index, equals);
    const valueStart = equals + 1;
    // The value runs to the next `&` — unless a `?` opened a nested parameter list first, in which
    // case it runs to the end of the string.
    let end = source.length;
    const nested = source.indexOf("?", valueStart);
    const nextAmp = source.indexOf("&", valueStart);
    if (nextAmp >= 0 && (nested < 0 || nextAmp < nested)) {
      end = nextAmp;
    }
    if (key === name) return source.slice(valueStart, end);
    index = end + 1;
  }
  return "";
}

/**
 * The address a live entry's `channels` lines point at, or `""` when it has none.
 *
 * TVBox lets one live entry carry several selectable lines instead of a single `url`:
 *
 *     {"channels": [{"name": "live", "urls": ["proxy://do=live&type=txt&ext=<base64>"]}],
 *      "group": "redirect"}
 *
 * Moseek read only `url`/`source`/`api`, so such an entry arrived with no address and was reported as
 * `直播源缺少 name 或 url/api 字段`: the source is valid and working in other clients, and here it was
 * an empty row. **The entry itself is the important part** — the user's original configuration file
 * still has this shape, so without this it would break again on the next import.
 *
 * Only the first usable line is taken. Moseek's live model is one address per source; the remaining
 * lines are not lost from the stored document, because the raw text keeps the entry as written — this
 * only decides which address the row uses. Picking the first is what TVBox itself does.
 */
function liveChannelsAddress(live: RawLive): string {
  const channels = (live as { channels?: unknown }).channels;
  if (!Array.isArray(channels)) return "";
  for (const channel of channels) {
    if (!channel || typeof channel !== "object" || Array.isArray(channel)) continue;
    const urls = (channel as { urls?: unknown }).urls;
    if (!Array.isArray(urls)) continue;
    for (const url of urls) {
      if (typeof url !== "string") continue;
      const candidate = unwrapLiveProxyLine(url);
      if (/^https?:\/\//i.test(candidate)) return candidate;
    }
  }
  return "";
}

function classifyLiveSource(
  live: RawLive,
  index: number,
  baseUrl?: string,
): SourceRecord {
  const key = live.key ?? `live-${index + 1}`;
  const name = live.name ?? `直播源 ${index + 1}`;
  // `channels` is consulted last: an entry that states a plain address is unambiguous, and only an
  // entry that does not falls back to its line list.
  const api = resolveConfiguredUrl(
    live.url ?? live.source ?? live.api ?? liveChannelsAddress(live) ?? "",
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
    capabilityNote = "这个直播源缺少必要信息。";
  } else if (hasDangerousProtocol) {
    capability = "blocked";
    capabilityNote = "这个直播源的地址不安全，拾影不会使用。";
  } else if (hasPrivateProtocol || normalizedApi.startsWith("proxy://")) {
    capability = "needs-adapter";
    capabilityNote = "这个直播源的地址格式暂不支持。";
  } else {
    capability = "supported";
    capabilityNote = "支持常见的直播源格式。";
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
      textValue(object, ["name", "title"]) || `解析源 ${index + 1}`;
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
      ? "解析源缺少地址。"
      : !/^https?:\/\//i.test(url)
        ? "解析源的地址格式暂不支持。"
        : !supportsMethod
          ? "这种解析方式暂不支持。"
          : "可以正常使用。";
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

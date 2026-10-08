import type { SourceRecord, SourceType } from "@/types/moseek";

/**
 * Whether Moseek has code that can run a source, or not.
 *
 * **There is no third state.** There used to be a `blocked` one, and five adapters carried it —
 * `drpy-js`, `csp-appmao`, `remote-jar`, `spider-runtime` and `js-extension`. Every one of them
 * named a family whose only content is code we will never execute: a drpy script needs `request`,
 * `pdfa`/`pdfh` and `CryptoJS`; AppMao's payload is encrypted with a key inside its JAR; the other
 * three are, by definition, remote code. Naming them was work the reader could not act on — the
 * user's own words were that recognising these does not help anybody, because a user cannot tell
 * what the name means, and Moseek is never going to implement them.
 *
 * So they are gone, and what is left of a source we cannot run is one honest word: 无法适配. The
 * sources themselves are not merely relabelled — `pruneUnsupportedEntries` removes them from the
 * configuration, because keeping an entry nothing will ever read only makes the list longer.
 */
export type AdapterExecution = "enabled" | "needs-adapter";

export type AdapterId =
  | "builtin-cms"
  | "builtin-live"
  | "http-extension"
  | "html-http"
  | "xbpq"
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
  "html-http": {
    label: "声明式 HTML 适配器",
    execution: "enabled",
    operations: ["列表", "搜索", "详情", "播放链接"],
    reason: "只请求 HTML 并按 CSS 选择器读取字段，不执行页面 JavaScript。",
  },
  xbpq: {
    label: "XBPQ / XYQHiker / Panda 适配器",
    execution: "enabled",
    operations: ["列表", "搜索", "详情", "播放链接"],
    reason:
      "按 URL 模板与文本标记读取页面，不执行脚本或 JAR；这三种写法是同一套词汇的不同拼法。",
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

/**
 * The adapters Moseek can actually run.
 *
 * **Only runnable ones are listed.** This table is what the 适配器 tab renders and what the source
 * list's filter offers, so a row here is a promise that some code path exists — and, since the
 * registry is also what the app uses to describe its own capabilities, a row for something that
 * cannot happen is a promise broken in front of the reader.
 *
 * **The test for a row is different from the test for a routing token below.** The user's rule was
 * that CMS and live are what this application is for, so an adapter earns its place by serving one
 * of those two, or by being the only code path for a configuration real files contain. Measured
 * against the author's own configuration — the 60 sources they actually keep enabled — the usage is
 * `builtin-cms` 36, `builtin-live` 19, `xbpq` 4, `http-extension` 1. That measurement alone does not
 * decide anything, because a file containing no `type: 5` source is not evidence that `type: 5`
 * does not exist; what it does is tell us which rows are carrying their weight today.
 *
 * Two entries left this table and one absorbed another:
 *
 * - **`http-parser` is deleted**, because nothing can ever assign it. Its only branch is gated on
 *   `sourceType === "parser"`, and no producer of that value has existed since `da8f565` replaced
 *   `capability === "supported" ? "cms" : "parser"` with a hard-coded `"cms"`. The parse-service
 *   feature it was named after is alive and heavily used — the author's configuration carries 130
 *   resolver services — but it does not work through adapters at all: those live in
 *   `normalizedConfig.parses` and reach Rust through `resolve_playback`, whose own
 *   `adapter_id: "http-parser"` string is a *playback* label in a different namespace that never
 *   touches this registry. Keeping the row also meant the interface promised `enabled` with three
 *   operations while Rust answered `Unsupported` for the same record.
 * - **`csp-panda` and `csp-xyqhiker` fold into `xbpq`**, which is what they already are in the
 *   runtime: Rust lumps all three into one `ScriptFamily::Declarative` and runs them through one
 *   module (`xbpq.rs`), which already parses the `key:value,key:value` spelling that csp_Panda uses.
 *   Three rows for one adapter described a distinction the code does not make.
 *
 * **`html-http` stays.** It is a complete 559-line implementation (`html.rs`), wired into both the
 * browse and detail commands, and it is the only code path for a declarative `type: 5` source.
 * Zero uses in one file is not evidence that the shape does not exist, and deleting it would not
 * merely hide such a source — it would hand it to the JSON CMS parser instead, because the
 * `siteProtocol === "html-http"` branch is what stops it falling through.
 */
export const adapterRegistry: AdapterProfile[] = [
  createProfile("builtin-cms", "cms"),
  createProfile("builtin-live", "live"),
  createProfile("http-extension", "cms"),
  createProfile("html-http", "cms"),
  createProfile("xbpq", "cms"),
];

/**
 * Names the declarative family a source belongs to, or null when nothing identifies one.
 *
 * **All three spellings answer `xbpq`, and that is the change rather than an omission.** `csp_XBPQ`,
 * `csp_Panda` and `csp_XYQHiker` are one adapter with three names: Rust puts all three markers into
 * a single `ScriptFamily::Declarative` and runs them through one module (`xbpq.rs`), which already
 * understands the `key:value,key:value` serialization csp_Panda uses. Reporting three separate rows
 * described a distinction the runtime does not make.
 *
 * **The tokens must stay recognisable even though only one id comes out.** This function is also
 * what tells `isRemoteCodeFamily` that a `csp_`-prefixed source is *not* remote code, and that
 * answer decides whether the entry is **deleted from the user's configuration file**. Dropping the
 * `panda`/`xyqhiker` tokens — rather than folding them into `xbpq` — would make every such source
 * look like an encrypted AppMao payload and remove it on the next import or launch. Measured: the
 * in-repo fixture at `config-prune-real.test.ts` covers exactly this, and the author's file has four
 * sources in this family.
 *
 * Both the key and the api are checked. TVBox gives these families the same `type: 3` shape and lets
 * the operator name the source freely, so the implementation marker lives in whichever field the
 * packager used: `api: "csp_XBPQ"` with an arbitrary `key` such as `fok` is common, and so is
 * `key: "csp_XBPQ"`. Reading only the key misclassified every source of the first kind.
 */
function declarativeFamily(key: string, api: string): AdapterId | null {
  const haystack = `${key} ${api}`;
  if (haystack.includes("xbpq")) return "xbpq";
  if (haystack.includes("panda")) return "xbpq";
  if (haystack.includes("xyqhiker")) return "xbpq";
  return null;
}

/**
 * Whether a source names a family whose only content is remote code.
 *
 * These stay refused rather than becoming "unknown": the refusal has to survive the removal of the
 * `blocked` *vocabulary*, which is a naming decision. `isPermanentlyUnsupported` reads this to decide
 * what to remove, and the refusal itself is `private-protocol`'s.
 *
 * Only genuine **implementation markers** are listed — the tokens a packager puts in `key` or `api`
 * to say which engine this source needs. Both fields are checked because TVBox gives every one of
 * these families the same `type: 3` shape and lets the operator name the source freely.
 *
 * **The `csp_` marker is qualified by what follows it, and that qualification is the whole reason
 * this function is not a `startsWith`.** `csp_XBPQ`, `csp_Panda` and `csp_XYQHiker` are declarative
 * payloads Moseek reads today, and they carry the same prefix as the encrypted `csp_AppMao` and the
 * scripted `csp_Bili`. A bare prefix match marks every working XBPQ source as remote code — measured
 * on the author's database that is 65 working sources, and deleting them is the worst outcome this
 * code can have. Unknown `csp_` families stay refused: being unable to read a payload is a reason to
 * leave it alone, not a reason to run it.
 *
 * **`kitty` is not a marker either.** It names a *dialect*, not an engine, and it turns up in source
 * names — a check on the word would mark an ordinary `Kitty影视` API as remote code. The CatVod JS
 * sources it should catch are identified by their protocol instead (`siteProtocol === "js-extension"`,
 * which the parser derives from the dialect plus the shape of the entry).
 */
export function isRemoteCodeFamily(
  source: Pick<SourceRecord, "key" | "api">,
): boolean {
  const haystack = `${source.key} ${source.api}`.toLowerCase();
  if (haystack.includes("drpy") || haystack.includes("appmao")) return true;
  // An unqualified `csp_` marker, with no declarative family named after it.
  if (!haystack.includes("csp_")) return false;
  return !declarativeFamily(haystack, "");
}

/**
 * The markers that decide whether a source can ever be run, in one place.
 *
 * Shared by the source record (which has a `siteProtocol`) and the raw configuration entry (which
 * has only a `type`), because both readers have to reach the same verdict: one decides what the
 * adapter column reports, the other decides what is removed from the file. Two similar-looking
 * functions here would eventually disagree, and the visible result would be a source that the list
 * says cannot run and the configuration keeps, or worse, one that runs but has been deleted.
 */
export interface ExecutabilityInput {
  key?: unknown;
  api?: unknown;
  jar?: unknown;
  /** The stored protocol, when the shape has one. */
  siteProtocol?: string | null;
  /** For a raw entry, TVBox's numeric `type`. */
  siteType?: number | null;
  isLive?: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function hasDangerousScheme(api: unknown) {
  return /^(javascript|data|file|shell):/i.test(
    typeof api === "string" ? api.trim() : "",
  );
}

/**
 * Whether Moseek will **never** be able to run this source.
 *
 * This is the one definition behind two decisions that must agree: which profile the adapter column
 * reports, and which entries are removed from the configuration. They are the same question — "is
 * there any chance this ever works" — so they read the same function rather than two similar ones.
 *
 * The declarative families are checked first and win. This is load-bearing rather than tidy: TVBox
 * gives an XBPQ source `type: 3` **and** usually a JAR, so every raw marker says "spider", while the
 * configuration it actually carries is a declarative vocabulary Moseek reads today. Documents
 * written before that support existed still store `siteProtocol: "spider"` for those sources, so a
 * check reading only the markers would delete 60 working sources.
 *
 * A **live** source is treated differently on purpose. A relative address (`./FM.json`) or a bare
 * token (`yqk`) is not a permanent verdict — those are repaired against the document's base URL —
 * so it is never unsupported for that reason. Only a scheme that must never be fetched is.
 */
export function isPermanentlyUnsupported(
  input: ExecutabilityInput,
): boolean {
  const key = text(input.key);
  const api = text(input.api);
  // A live entry is not a "family" at all — it is a playlist address — so the only thing that makes
  // one permanently unusable is a scheme that must never be fetched. A live address reading
  // `csp_MQiTV` or `yqk` is a name some adapter resolves, not a script: those are `needs-adapter`
  // today and repairable, so judging them by the CMS rules below would delete usable sources.
  if (input.isLive) return hasDangerousScheme(input.api);
  // **Remote code is checked before the declarative exemption, and that order is a contract.**
  // TVBox lets a packager put both markers on one source (`key: "drpy_xbpq"`), and what such a
  // source needs is the drpy engine — the engine is what runs, and the XBPQ payload is merely what
  // it is pointed at. Rust reads the same two markers in the same order (`script_family`), and the
  // two sides have to agree: this one decides what is *removed from the user's file*, so a
  // disagreement deletes a source the backend would have refused to run anyway — or keeps one it
  // will refuse, which is the contradiction this project keeps having to fix.
  if (isRemoteCodeFamily({ key, api })) return true;
  if (declarativeFamily(key, api)) return false;
  // The parser can recognise the declarative vocabulary from `ext` alone, with neither the key nor
  // the api naming the family, and it records that as `siteProtocol: "xbpq"`. That field is the
  // evidence, and it has to win here: such a source is `type: 3` and usually ships a JAR, so every
  // other marker says "spider" while the configuration Moseek reads is declarative. Ignoring it
  // would delete working sources from the user's file — the one outcome this must never have.
  if (input.siteProtocol === "xbpq") return false;
  // Every remaining family that would have to execute something: a `type: 3` spider, a CatVod JS
  // extension, or anything shipping a JAR.
  return (
    input.siteProtocol === "spider" ||
    input.siteProtocol === "js-extension" ||
    input.siteType === 3 ||
    Boolean(input.jar) ||
    hasDangerousScheme(input.api)
  );
}

/**
 * `isPermanentlyUnsupported` for a classified source record.
 *
 * The single way a caller that holds a `SourceRecord` should ask the question, so nothing has to know
 * which fields the predicate reads or how a live source differs. The read paths use this; the raw
 * configuration path builds an `ExecutabilityInput` from a classified entry.
 */
export function isPermanentlyUnsupportedSource(
  source: Pick<
    SourceRecord,
    "key" | "api" | "jar" | "sourceType" | "siteProtocol" | "siteType"
  >,
): boolean {
  return isPermanentlyUnsupported({
    key: source.key,
    api: source.api,
    jar: source.jar,
    siteProtocol: source.siteProtocol ?? null,
    siteType: source.siteType ?? null,
    isLive: source.sourceType === "live",
  });
}

export function getAdapterProfile(
  source: Pick<
    SourceRecord,
    "key" | "api" | "jar" | "sourceType" | "siteProtocol" | "capability"
  >,
): AdapterProfile {
  const key = source.key.toLowerCase();
  const api = source.api.toLowerCase();
  const family = declarativeFamily(key, api);
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
  } else if (source.siteProtocol === "html-http") {
    id = "html-http";
  } else if (family) {
    id = family;
  } else if (source.siteProtocol === "xbpq") {
    // The parser recognised the declarative vocabulary from `ext` alone, so neither the key nor the
    // api names the family. It is still an XBPQ source — that is why the parser recorded this
    // protocol — and the Rust side runs it through the XBPQ adapter. Reporting it as `builtin-cms`
    // here would put a label on the row that disagrees with the code that actually handles it, which
    // is the one thing the registry exists to prevent.
    id = "xbpq";
  } else if (
    isPermanentlyUnsupported({
      key,
      api,
      jar: source.jar,
      siteProtocol: source.siteProtocol,
    })
  ) {
    // drpy, AppMao, a bare `type: 3` spider, a JAR dependency and a CatVod JS extension all land
    // here. They used to carry five separate names between them; they now share the one profile
    // that states the truth — Moseek cannot adapt this — because the names were the part the user
    // could not act on. These entries are also what `pruneUnsupportedEntries` removes.
    id = "private-protocol";
  } else if (
    api.startsWith("proxy://") ||
    source.capability === "needs-adapter"
  ) {
    id = "private-protocol";
  } else if (source.sourceType === "cms" && /^https?:\/\//i.test(source.api)) {
    id = "builtin-cms";
  } else {
    // Covers a `cms` source with no fetchable address, and anything left over. There used to be a
    // `sourceType === "parser"` branch above this one answering `http-parser`; no producer of that
    // value has existed for a long time, so it was a row that could never be reached by a source and
    // a promise the backend did not keep. See the registry's own comment.
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
  //
  // There is no third word any more. 已阻止 named which plugin a source was written for, and that
  // is a fact about somebody else's client, not about anything the reader can do.
  return {
    enabled: "可执行",
    "needs-adapter": "无法适配",
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

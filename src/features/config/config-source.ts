/**
 * Turns what a configuration address actually served into something the app can use.
 *
 * The Rust side (`src-tauri/src/config/decode.rs`) does the byte-level half — unwrapping a picture,
 * decoding a non-UTF-8 encoding — because only it sees the bytes. This module does the text-level
 * half, because it already has a JSON5 parser and is far cheaper to test.
 *
 * Measured against the ten addresses the user supplied, the shapes that arrive are:
 *
 * | Address | What it serves | Handled by |
 * |---|---|---|
 * | 饭太硬 | JPEG + `**` + base64(config) | Rust |
 * | 王二小 / 嗷呜 | an HTML landing page, no configuration at all | here |
 * | 老刘备 / 小盒子单仓 | JSON behind `//` comments | the parser |
 * | VOX | 404 | the fetch |
 * | 小盒子多仓 / 挺好分享多仓 | `{"urls":[…]}` — a list of other configurations | here |
 * | 拾光多仓 | JSON with an HTML `<div>` footer appended | here |
 * | 肥猫 | bare JSON under `text/html` | nothing needed |
 */

/** One address inside a 多仓 (subscription list) document. */
export interface MultiRepoEntry {
  name: string;
  url: string;
}

export type ConfigSourceKind =
  | { kind: "config"; text: string; note?: string }
  | { kind: "multi-repo"; entries: MultiRepoEntry[]; note: string }
  | { kind: "landing-page"; title?: string; note: string };

/**
 * Reads a body into a usable form.
 *
 * `note` from the fetch is carried through, so a message about unwrapping a picture survives alongside
 * whatever this module adds.
 *
 * The leading-comment strip is used to DECIDE what the body is, not to rewrite it: the parser already
 * tolerates comments and a BOM, and a configuration's comments are the author's notes. Rewriting them
 * away here would be a second implementation of something that works, and it would show the user a
 * file that is not the one they downloaded.
 */
export function readConfigSource(rawText: string, fetchNote?: string | null): ConfigSourceKind {
  const stripped = stripLeadingComments(rawText);
  const trimmed = stripped.trimStart();

  // A 多仓 document first: it is valid JSON, so every check after this one would accept it and then
  // fail confusingly during parsing as a configuration with no `sites`.
  const entries = readMultiRepo(stripped);
  if (entries) {
    return {
      kind: "multi-repo",
      entries,
      note:
        `这个地址返回的是一份「多仓」列表，里面是 ${entries.length} 个配置地址，` +
        `本身不是配置。选一个导入即可。`,
    };
  }

  // A web page where a configuration should be. Reporting a JSON syntax error at character 0 would
  // be true and useless: the user pasted a real address that happens to be a landing page.
  if (trimmed.startsWith("<")) {
    const title = readHtmlTitle(trimmed);
    return {
      kind: "landing-page",
      title,
      note:
        `这个地址返回的是一个网页${title ? `（${title}）` : ""}，不是配置文件。` +
        `请从该页面找到真正的配置地址再导入。`,
    };
  }

  // JSON with an HTML footer appended, which is what 拾光多仓 does. Everything from the first `<` on
  // a line by itself is dropped, but only when the text before it parses — otherwise a `<` inside a
  // legitimate string would be cut out of a working configuration.
  const withoutFooter = stripTrailingHtml(rawText);
  if (withoutFooter !== null) {
    return {
      kind: "config",
      text: withoutFooter,
      note: "已去掉配置末尾附带的网页代码",
    };
  }

  // The BOM is dropped because it is an encoding artefact rather than anything the author wrote — and
  // it would otherwise sit in front of the text the editor shows. Comments are NOT dropped: they are
  // the author's notes, and the parser already tolerates them.
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  return { kind: "config", text, note: fetchNote ?? undefined };
}

/**
 * Drops leading comment lines and a BOM, so the checks below see the real first character.
 *
 * The parser tolerates comments, so this is not required for parsing — it is required for deciding
 * whether the body is a web page or a 多仓 list, both of which are decided by the first character.
 */
function stripLeadingComments(text: string): string {
  let rest = text.startsWith("\uFEFF") ? text.slice(1) : text;
  for (;;) {
    const candidate = rest.replace(/^\s+/, "");
    const lineEnd = candidate.indexOf("\n");
    const firstLine = (lineEnd === -1 ? candidate : candidate.slice(0, lineEnd)).trim();
    if (firstLine.startsWith("//") || firstLine.startsWith("#")) {
      if (lineEnd === -1) return "";
      rest = candidate.slice(lineEnd + 1);
      continue;
    }
    return candidate;
  }
}

/**
 * Reads a 多仓 document, if this is one.
 *
 * Recognised by a top-level `urls` array of objects carrying a `url`. Deliberately narrow: a
 * configuration with a `urls` key somewhere deeper must not be mistaken for a subscription list.
 *
 * The text is relaxed before parsing, because these documents are hand-written: one of the measured
 * ones mixes a BOM, `//` comments and a trailing HTML footer. Relaxing here rather than tightening
 * the reader is the same choice the import path already makes for configurations.
 */
export function readMultiRepo(text: string): MultiRepoEntry[] | null {
  const parsed = parseLoosely(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const urls = (parsed as Record<string, unknown>).urls;
  if (!Array.isArray(urls)) return null;

  const entries: MultiRepoEntry[] = [];
  for (const item of urls) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url) continue;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    entries.push({ name: name || url, url });
  }

  // An empty `urls` array is not a subscription list worth offering.
  return entries.length > 0 ? entries : null;
}

/**
 * Parses with the tolerances these documents need, returning null rather than throwing.
 *
 * JSON5 is not imported here: it lives in `config-parser.ts`, and pulling it in would create a cycle
 * risk for a function that runs before parsing. `JSON.parse` plus a comment strip covers the measured
 * documents, and the footer strip in `stripTrailingHtml` runs first for the one that needs it.
 */
function parseLoosely(text: string): unknown {
  const candidates = [
    text,
    // `//` line comments, which JSON does not allow and two of these documents use.
    text.replace(/^\s*\/\/[^\n]*$/gm, ""),
    stripTrailingHtml(text) ?? text,
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Removes an HTML footer appended after a JSON document.
 *
 * Returns `null` when the text has no footer, or when removing it would not produce something that
 * parses — the second condition is what keeps a `<` inside a legitimate string from deleting the end
 * of a working configuration.
 */
export function stripTrailingHtml(text: string): string | null {
  const marker = text.search(/\n\s*</);
  if (marker === -1) return null;

  const head = text.slice(0, marker).trimEnd();
  if (!head) return null;
  // Only accept the cut when the remainder really is a document. JSON5 is not available here, so the
  // check is that it parses strictly — which is enough for the measured case and cannot misfire on
  // text that is already invalid for another reason.
  try {
    JSON.parse(head);
  } catch {
    return null;
  }
  return head;
}

/** The `<title>` of an HTML page, for a message that can name what the address serves. */
export function readHtmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 80) : undefined;
}

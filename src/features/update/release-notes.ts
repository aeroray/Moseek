/**
 * Renders the release notes an update manifest carries.
 *
 * **This is a security boundary, not a formatting convenience.** The notes travel in
 * `latest.json`, and the minisign signature covers the *installer*, not the manifest — so the text
 * is untrusted. Parsing it into plain strings and letting React escape every value makes injection
 * impossible by construction; rendering it as HTML would let anyone who can answer the endpoint
 * inject into the settings page.
 *
 * The grammar is deliberately small: it covers what we author in `docs/releases/<tag>.md` and
 * nothing else. Anything unrecognised falls through as a plain paragraph rather than being dropped,
 * so a note can never silently disappear.
 */

export type ReleaseNoteBlock =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "text"; text: string };

/** A run of text, with `**bold**` split out so emphasis renders without treating the note as markup. */
export type ReleaseNoteRun = { bold: boolean; text: string };

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const INDENTED = /^\s+\S/;

/**
 * Splits inline `**bold**` into runs.
 *
 * Only `**` is recognized; a single `*` stays as written, because our notes use it inside words far
 * more often than as emphasis.
 */
export function parseInline(text: string): ReleaseNoteRun[] {
  const runs: ReleaseNoteRun[] = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > last) runs.push({ bold: false, text: text.slice(last, start) });
    runs.push({ bold: true, text: match[1] });
    last = start + match[0].length;
  }
  if (last < text.length) runs.push({ bold: false, text: text.slice(last) });
  return runs.length > 0 ? runs : [{ bold: false, text }];
}

export function parseReleaseNotes(markdown: string): ReleaseNoteBlock[] {
  const blocks: ReleaseNoteBlock[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let list: string[] | undefined;

  const flushList = () => {
    if (list?.length) blocks.push({ kind: "list", items: list });
    list = undefined;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      // A blank line between bullets does not end the list: our notes separate every bullet with
      // one, so flushing here would turn each section into dozens of one-item lists.
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushList();
      // `#` is clamped to the same weight as `##`: these notes render inside a settings card, where
      // a document-level h1 would out-shout the page it sits in.
      const level = heading[1].length >= 3 ? 3 : 2;
      blocks.push({ kind: "heading", level, text: heading[2].trim() });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      list ??= [];
      list.push(bullet[1].trim());
      continue;
    }

    // An indented line continues the bullet above it, with the newline kept so the two do not run
    // together.
    if (list?.length && INDENTED.test(line)) {
      list[list.length - 1] += `\n${line.trim()}`;
      continue;
    }

    flushList();
    blocks.push({ kind: "text", text: line.trim() });
  }

  flushList();
  return blocks;
}

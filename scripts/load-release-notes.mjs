/**
 * Loads the release notes for the tag being released and exposes them as the `body` step output.
 *
 * The notes live in `docs/releases/<tag>.md` rather than inline in `release.yml`. Inline notes have
 * to be hand-edited for every release and are silently reused when that is forgotten, which
 * publishes the previous version's notes under the new tag — and nothing in the pipeline can catch
 * it. A missing file, by contrast, stops the release.
 *
 * Node writes the output rather than a shell heredoc because the Windows runner also runs this job,
 * where `$GITHUB_OUTPUT` is a Windows path and heredocs are the fragile part.
 */
import { appendFile, readFile } from "node:fs/promises";

const rawTag = process.argv[2] || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
const tag = rawTag?.startsWith("v") ? rawTag : `v${rawTag ?? ""}`;

if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`发布标签必须是 SemVer，收到：${rawTag || "<空>"}`);
}

const notesPath = `docs/releases/${tag}.md`;
let body;
try {
  body = await readFile(notesPath, "utf8");
} catch {
  throw new Error(
    `找不到发布说明 ${notesPath}。请在打标签前写好它，否则这次发布将没有说明。`,
  );
}

if (!body.trim()) {
  throw new Error(`${notesPath} 是空的。`);
}

// The delimiter must not appear in the content, or the output would be truncated at that line.
const delimiter = "RELEASE_NOTES_EOF";
if (body.includes(delimiter)) {
  throw new Error(`${notesPath} 不能包含输出分隔符 ${delimiter}。`);
}

const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) {
  // Allow running locally to validate the notes without a workflow.
  console.log(body);
  console.error(`\n（未设置 GITHUB_OUTPUT，改为直接打印 ${notesPath}。）`);
  process.exit(0);
}

// A newline must separate the body from the closing delimiter or the last line is lost; the body
// usually ends with one already, so normalizing avoids adding a stray blank line.
const normalized = body.endsWith("\n") ? body : `${body}\n`;
await appendFile(outputPath, `body<<${delimiter}\n${normalized}${delimiter}\n`, "utf8");
console.log(`已从 ${notesPath} 读取发布说明（${Buffer.byteLength(body, "utf8")} 字节）。`);

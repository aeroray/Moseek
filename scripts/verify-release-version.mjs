/**
 * Checks that the tag being released matches the version in the source tree.
 *
 * This is the guard that makes the tag authoritative. Without it, tagging `v0.3.0` while the tree
 * still says `0.2.0` would publish a release *named* 0.3.0 whose installer is built as 0.2.0 and
 * whose `latest.json` advertises 0.2.0 — so every existing install would be told there is nothing to
 * update to, and the new one would immediately offer to update itself to the version it already is.
 *
 * `sync-version.mjs` runs first in the workflow and asserts the three files agree with each other;
 * this asserts they agree with the *tag*, which is the part that cannot be derived from the tree.
 */
import { readFile } from "node:fs/promises";

const rawTag = process.argv[2] || process.env.GITHUB_REF_NAME;
const version = rawTag?.replace(/^v/, "");

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`发布标签必须包含 SemVer 版本号，收到：${rawTag || "<空>"}`);
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (packageJson.version !== version) {
  throw new Error(
    `package.json 的版本是 ${packageJson.version}，与标签 ${version} 不一致。` +
      `请先运行 \`node scripts/sync-version.mjs ${version}\` 并提交。`,
  );
}

const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
// tauri.conf.json may delegate to package.json; when it does, the check above already covered it.
const delegates =
  typeof tauriConfig.version === "string" && tauriConfig.version.endsWith("package.json");
if (!delegates && tauriConfig.version !== version) {
  throw new Error(
    `tauri.conf.json 的版本是 ${tauriConfig.version}，与标签 ${version} 不一致。`,
  );
}

console.log(`标签与源码版本一致：${version}。`);

/**
 * Keeps every place the version number lives in agreement.
 *
 * The number is written in three files and they are compared against each other at release time:
 * `package.json` (what the frontend displays), `src-tauri/Cargo.toml` (what the binary is built as)
 * and `src-tauri/tauri.conf.json` (what the installer and the update manifest carry). If they
 * disagree, the app reports one version, the installer installs another, and the updater compares
 * against a third — which shows up as "已是最新版本" on a build that is not, or as an update that
 * installs and then offers itself again.
 *
 * `tauri.conf.json` may hold `"version": "../package.json"` instead of a literal, in which case Tauri
 * reads it from there and there is nothing to synchronise. That form is supported because it removes
 * the possibility of drift entirely.
 *
 * Usage:
 *   node scripts/sync-version.mjs 0.2.0     # write 0.2.0 everywhere
 *   node scripts/sync-version.mjs           # verify only; exits non-zero on drift
 */
import { readFile, writeFile } from "node:fs/promises";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const requested = process.argv[2]?.replace(/^v/, "");
if (requested !== undefined && !VERSION_PATTERN.test(requested)) {
  throw new Error(`版本号必须是 SemVer，收到：${process.argv[2] || "<空>"}`);
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const packagePath = "package.json";
const cargoPath = "src-tauri/Cargo.toml";
const tauriPath = "src-tauri/tauri.conf.json";

const packageJson = await readJson(packagePath);
const tauriConfig = await readJson(tauriPath);
const cargoToml = await readFile(cargoPath, "utf8");
const cargoVersion = cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];

if (!cargoVersion) {
  throw new Error(`在 ${cargoPath} 的 [package] 段里找不到 version。`);
}

// Tauri supports pointing at package.json instead of repeating the number; when it does, that file
// is the single source and there is nothing here to keep in step.
const tauriVersion = tauriConfig.version;
const tauriDelegates = typeof tauriVersion === "string" && tauriVersion.endsWith("package.json");

if (requested === undefined) {
  const seen = new Map([
    [packagePath, packageJson.version],
    [cargoPath, cargoVersion],
    ...(tauriDelegates ? [] : [[tauriPath, String(tauriVersion)]]),
  ]);
  const distinct = new Set(seen.values());
  if (distinct.size !== 1) {
    const detail = [...seen].map(([file, value]) => `  ${file}: ${value}`).join("\n");
    throw new Error(
      `版本号不一致，请先运行 \`node scripts/sync-version.mjs <版本>\`：\n${detail}`,
    );
  }
  console.log(`版本号一致：${packageJson.version}${tauriDelegates ? "（tauri.conf.json 引用 package.json）" : ""}`);
  process.exit(0);
}

// Write. Each replacement is anchored so it cannot touch an unrelated `version` key — Cargo.toml
// alone contains several inside dependency tables.
if (packageJson.version !== requested) {
  packageJson.version = requested;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

if (cargoVersion !== requested) {
  const updated = cargoToml.replace(
    /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
    `$1${requested}$2`,
  );
  if (updated === cargoToml) throw new Error(`无法改写 ${cargoPath} 的版本号。`);
  await writeFile(cargoPath, updated, "utf8");
}

if (!tauriDelegates && String(tauriVersion) !== requested) {
  tauriConfig.version = requested;
  await writeFile(tauriPath, `${JSON.stringify(tauriConfig, null, 2)}\n`, "utf8");
}

console.log(`版本号已同步为 ${requested}。`);

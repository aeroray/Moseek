import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = join(root, "src-tauri", "script-runtime", "Cargo.toml");
const target = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .split(/\r?\n/)
  .find((line) => line.startsWith("host:"))
  ?.split(/\s+/)[1];

if (!target) throw new Error("无法确定 Rust host target");

execFileSync("cargo", ["build", "--manifest-path", manifest, "--release"], {
  cwd: root,
  stdio: "inherit",
});

const extension = process.platform === "win32" ? ".exe" : "";
const binary = join(
  root,
  "src-tauri",
  "script-runtime",
  "target",
  "release",
  `moseek-script-runtime${extension}`,
);
const destination = join(
  root,
  "src-tauri",
  "binaries",
  `moseek-script-runtime-${target}${extension}`,
);

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(binary, destination);
console.log(`Prepared ${destination}`);

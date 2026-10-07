// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { resolveConfig } from "vite";

afterEach(() => vi.unstubAllEnvs());

it("exposes Tauri platform flags without exposing release signing secrets", async () => {
  vi.stubEnv("TAURI_SIGNING_PRIVATE_KEY", "test-key-that-must-stay-private");
  vi.stubEnv("TAURI_ENV_TARGET_TRIPLE", "x86_64-pc-windows-msvc");
  const config = await resolveConfig({ configFile: "vite.config.ts" }, "build");
  expect(config.env).not.toHaveProperty("TAURI_SIGNING_PRIVATE_KEY");
  expect(config.env.TAURI_ENV_TARGET_TRIPLE).toBe("x86_64-pc-windows-msvc");
});

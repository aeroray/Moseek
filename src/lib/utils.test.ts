import { describe, expect, it } from "vitest";

import { errorMessage } from "@/lib/utils";

/**
 * The rejected value of a Tauri command is a plain string, not an `Error`.
 *
 * The IPC layer serialises `InvokeError`'s value directly and the injected `invoke` calls
 * `reject(e)` with it, so `error instanceof Error` is false for every backend failure. Reading only
 * `Error` at the call site therefore throws away the one message that says what happened — which is
 * how "播放地址未通过安全检查" was shown while the real reason was dozens of timed-out parser
 * services.
 */
describe("errorMessage", () => {
  it("reads a rejected string, which is what a Tauri command returns", () => {
    expect(
      errorMessage("已尝试 12 个解析服务，但没有一个返回可播放地址。", "回退文案"),
    ).toBe("已尝试 12 个解析服务，但没有一个返回可播放地址。");
  });

  it("still reads an Error, which is what a JS-side throw produces", () => {
    expect(errorMessage(new Error("脚本档案没有返回 parseIframe 结果"), "回退")).toBe(
      "脚本档案没有返回 parseIframe 结果",
    );
  });

  it("reads an object carrying a message, which is what a plugin error is", () => {
    expect(errorMessage({ message: "插件错误" }, "回退")).toBe("插件错误");
  });

  it("falls back only when there is genuinely nothing to read", () => {
    expect(errorMessage(undefined, "回退")).toBe("回退");
    expect(errorMessage(null, "回退")).toBe("回退");
    expect(errorMessage("", "回退")).toBe("回退");
    expect(errorMessage("   ", "回退")).toBe("回退");
    expect(errorMessage(new Error(""), "回退")).toBe("回退");
    expect(errorMessage({ message: "  " }, "回退")).toBe("回退");
    expect(errorMessage(42, "回退")).toBe("回退");
  });
});

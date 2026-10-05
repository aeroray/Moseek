import { describe, expect, it } from "vitest";

import { nextEnabledAfterTest } from "@/stores/app-store";

/**
 * Pins the rule the switch, the toast and the batch summary all have to agree with.
 *
 * The backend (`storage::set_source_test_in_connection`) persists the decision this mirrors, so a
 * mismatch would show one answer until the next reload and another afterwards.
 *
 * **Every failure switches the source off, including one that never reached the server.** This used
 * to be narrower — transport failures left the switch alone, on the theory that a timeout or a name
 * that did not resolve reports the network rather than the source. The user's decision is the
 * simpler rule: a source we cannot reach is a source we cannot use, so it is 测试失败 like any other
 * and belongs in the same 清理不可用 set. The cost of being wrong is bounded, because the switch is
 * one click away.
 */
describe("whether a test switches a source off", () => {
  const enabled = { enabled: true };

  it("switches off a failure that never reached the server", () => {
    // The reversal this file exists to pin. Each of these messages was asserted to LEAVE the source
    // on. The message no longer reaches the function at all — that is the point: nothing about a
    // failure's wording changes the outcome any more.
    for (const message of [
      "测试超时（25 秒），已停止等待。该源可能无法访问或响应过慢。",
      "无法解析远程主机：不知道这样的主机。 (os error 11001)",
      "连接被拒绝。 (os error 10061)",
    ]) {
      expect(
        nextEnabledAfterTest(enabled, { status: "failed" }),
        message,
      ).toBe(false);
    }
  });

  it("switches off a failure the server answered", () => {
    expect(nextEnabledAfterTest(enabled, { status: "failed" })).toBe(false);
  });

  it("switches off an empty result, which is a real answer", () => {
    expect(nextEnabledAfterTest(enabled, { status: "empty" })).toBe(false);
  });

  it("leaves a pass and a blocked test where the user put the switch", () => {
    // A pass works, and `blocked` means no request was made — neither is a verdict.
    expect(nextEnabledAfterTest(enabled, { status: "passed" })).toBe(true);
    expect(nextEnabledAfterTest(enabled, { status: "blocked" })).toBe(true);
  });

  it("does not resurrect a source the user switched off themselves", () => {
    // `enabled: false` cannot be told apart from the user's own choice, so a pass leaves it alone.
    expect(nextEnabledAfterTest({ enabled: false }, { status: "passed" })).toBe(false);
  });
});

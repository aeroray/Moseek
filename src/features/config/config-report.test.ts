import { describe, expect, it } from "vitest";

import {
  countSourceHealth,
  describeIssueTarget,
  groupIssues,
  healthVerdict,
  sourceHealthGroup,
  summarizeSourceHealth,
} from "@/features/config/config-report";
import { parseConfigText, type ParseResult } from "@/features/config/config-parser";
import type { SourceRecord } from "@/types/moseek";

// A source with only the fields this module reads, so each case states one thing.
function source(over: Partial<SourceRecord> & { key: string }): SourceRecord {
  return {
    name: over.key,
    sourceType: "cms",
    api: "https://a.example/api.php/provide/vod",
    searchable: true,
    filterable: true,
    capability: "supported",
    capabilityNote: "note",
    testStatus: "untested",
    enabled: true,
    lastCheckedAt: "刚刚",
    requestCount: 0,
    ...over,
  };
}

describe("the state a source is in", () => {
  it("reports a passing test as usable", () => {
    expect(sourceHealthGroup(source({ key: "a", testStatus: "passed" }))).toBe("usable");
  });

  it("keeps failed and empty apart, because the fixes differ", () => {
    // A failure means the request did not work; empty means it worked and returned nothing. Telling
    // them apart is the difference between "this source is dead" and "this source changed its API".
    expect(sourceHealthGroup(source({ key: "a", testStatus: "failed" }))).toBe("failed");
    expect(sourceHealthGroup(source({ key: "b", testStatus: "empty" }))).toBe("empty");
  });

  it("decides testability before the test result", () => {
    // A blocked source has no test result, because the backend never ran it. Reading `testStatus`
    // first would file every one of them under 待测试 and invite the reader to wait for a test that
    // cannot happen.
    const blocked = source({
      key: "a",
      capability: "blocked",
      testStatus: "untested",
      jar: "https://x/1.jar",
      siteProtocol: "spider",
    });
    expect(sourceHealthGroup(blocked)).toBe("blocked");
  });

  it("calls a missing address invalid rather than untested", () => {
    expect(sourceHealthGroup(source({ key: "a", capability: "invalid" }))).toBe("invalid");
  });

  it("separates a private protocol from a blocked one", () => {
    // One needs an adapter that does not exist; the other is refused on purpose. Different reasons,
    // so different words.
    expect(
      sourceHealthGroup(source({ key: "a", capability: "needs-adapter", api: "proxy://demo" })),
    ).toBe("needs-adapter");
  });
});

describe("the summary", () => {
  it("partitions the list, so the counts add up to what the header shows", () => {
    // The old report counted raw entries while the header counted stored sources, and the two
    // appeared together (26 against 27). Every source is in exactly one group here.
    const sources = [
      source({ key: "a", testStatus: "passed" }),
      source({ key: "b", testStatus: "failed" }),
      source({ key: "c", testStatus: "untested" }),
      source({ key: "d", capability: "blocked", siteProtocol: "spider" }),
    ];
    const counts = countSourceHealth(sources);
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBe(sources.length);
  });

  it("drops the states nothing is in, except 可用", () => {
    // Rows of zeros are noise, but "nothing works" is the most important thing the page can say.
    const groups = summarizeSourceHealth([source({ key: "a", testStatus: "failed" })]);
    const keys = groups.map((group) => group.key);
    expect(keys).toEqual(["usable", "failed"]);
    expect(groups.find((group) => group.key === "usable")?.count).toBe(0);
  });

  it("gives every group a filter that selects it", () => {
    // A count with no way to reach the rows it describes is what made the old report useless.
    for (const group of summarizeSourceHealth([source({ key: "a", testStatus: "failed" })])) {
      const active = Object.values(group.filter).some((part) => part.length > 0);
      expect(active, `${group.key} must narrow the list`).toBe(true);
    }
  });
});

describe("the verdict", () => {
  it("names the situation when nothing has been tested", () => {
    expect(healthVerdict([source({ key: "a" }), source({ key: "b" })])).toBe(
      "2 个源都还没有测速，现在还不知道哪些能用。",
    );
  });

  it("says plainly when nothing works", () => {
    expect(
      healthVerdict([source({ key: "a", testStatus: "failed" }), source({ key: "b" })]),
    ).toBe("2 个源里没有一个确认可用。");
  });

  it("counts the three things a reader can act on", () => {
    const verdict = healthVerdict([
      source({ key: "a", testStatus: "passed" }),
      source({ key: "b", testStatus: "passed" }),
      source({ key: "c", testStatus: "untested" }),
      source({ key: "d", testStatus: "failed" }),
    ]);
    expect(verdict).toBe("4 个源：2 个已确认可用，1 个待测试，1 个需要处理。");
  });

  it("handles an empty configuration without claiming anything", () => {
    expect(healthVerdict([])).toBe("当前配置里还没有源。");
  });
});

describe("naming what a finding is about", () => {
  const result = (text: string): ParseResult => {
    const parsed = parseConfigText(text, undefined);
    if (!parsed.ok) throw new Error("fixture must parse");
    return parsed;
  };

  it("replaces an array index with the source's name", () => {
    // `lives.0` is an index into an array the reader has never seen. The name is what they can act on.
    const parsed = result(
      JSON.stringify({
        sites: [{ key: "ok", name: "正常源", api: "https://a.example/api" }],
        lives: [{ key: "bad", name: "没有地址的直播源" }],
      }),
    );
    const issue = parsed.issues.find((item) => item.path.startsWith("lives."));
    expect(issue).toBeTruthy();
    expect(describeIssueTarget(issue!, parsed)).toBe("直播源「没有地址的直播源」");
  });

  it("names a parser service by its name too", () => {
    const parsed = result(
      JSON.stringify({
        sites: [],
        parses: [{ name: "坏解析乙", type: 1, url: "not-a-url" }],
      }),
    );
    const issue = parsed.issues.find((item) => item.path.startsWith("parses."));
    expect(describeIssueTarget(issue!, parsed)).toBe("解析服务「坏解析乙」");
  });

  it("keeps the path when the entry cannot be identified", () => {
    // A vague name beats a wrong one.
    const parsed = result(JSON.stringify({ sites: [], lives: [] }));
    expect(
      describeIssueTarget(
        { severity: "warning", message: "synthetic", path: "sites.99", line: null, column: null },
        parsed,
      ),
    ).toBe("sites.99");
  });

  it("groups four services with one problem into a single finding", () => {
    // Four identical messages differing only in their digits is one problem with four names.
    const parsed = result(
      JSON.stringify({
        sites: [],
        parses: [
          { name: "甲", type: 1, url: "bad-one" },
          { name: "乙", type: 1, url: "bad-two" },
          { name: "丙", type: 1, url: "bad-three" },
          { name: "丁", type: 1, url: "https://good.example/?url=" },
        ],
      }),
    );
    const findings = groupIssues(parsed.issues, parsed);
    const nonHttp = findings.find((finding) => finding.message.includes("非 HTTP"));
    expect(nonHttp?.targets).toEqual([
      "解析服务「甲」",
      "解析服务「乙」",
      "解析服务「丙」",
    ]);
    // Named, never indexed.
    for (const finding of findings) {
      for (const target of finding.targets) {
        expect(target).not.toMatch(/^parses\.\d/);
      }
    }
  });

  it("puts errors before warnings, and the biggest group first", () => {
    const parsed = result(
      JSON.stringify({
        sites: [{ key: "ok", name: "正常源", api: "https://a.example/api" }],
        lives: [{ key: "bad", name: "缺地址" }],
        parses: [
          { name: "甲", type: 1, url: "bad-one" },
          { name: "乙", type: 1, url: "bad-two" },
        ],
      }),
    );
    const findings = groupIssues(parsed.issues, parsed);
    expect(findings[0].severity).toBe("error");
    // Within a severity, the group with the most targets leads.
    const warnings = findings.filter((finding) => finding.severity === "warning");
    expect(warnings[0].targets.length).toBeGreaterThanOrEqual(
      warnings[warnings.length - 1].targets.length,
    );
  });
});

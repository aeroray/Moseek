import { getAdapterProfile, isTestableSource } from "@/lib/adapters";
import {
  clearedSourceFilter,
  executionFacetLabels,
  statusFacetLabels,
  type SourceFilterState,
} from "@/features/config/source-filter";
import type { ParseIssue, ParseResult } from "@/features/config/config-parser";
import type { SourceRecord } from "@/types/moseek";

/**
 * What the 解析报告 tab shows.
 *
 * The tab used to report what the parser saw: how many sources it recognised, which collections it
 * carried, how many execution boundaries fired. Measured against the author's own configuration that
 * produced four rows of zeros, a parse-service count that was actively misleading ("71 available"
 * when playback only ever tries twelve), and a list of findings addressed as `parses.41` — an index
 * into an array the reader has never seen. Nothing on it answered the question the page exists for:
 * can I watch anything with this configuration.
 *
 * So the report is rebuilt around the reader's question. It partitions the sources by what the last
 * test found, which is the only evidence anyone has about whether a source works, and it names every
 * problem by the source it is about.
 */

/**
 * The states a source can be in, from the reader's point of view.
 *
 * These partition the list: every source is in exactly one group, so the counts add up to the number
 * of sources the page shows. That matters because the previous report counted one thing while the
 * header counted another and the two appeared together on screen (26 against 27) with no way for the
 * reader to tell which was right.
 */
export type SourceHealthKey =
  | "usable"
  | "untested"
  | "failed"
  | "empty"
  | "invalid"
  | "blocked"
  | "needs-adapter";

export interface SourceHealthGroup {
  key: SourceHealthKey;
  /** The word the source list puts on these rows, so a count can be found in the list. */
  label: string;
  /** What the state means and what the reader can do about it. */
  hint: string;
  count: number;
  /** Selects exactly these sources in the list. */
  filter: SourceFilterState;
}

/**
 * Which group a source belongs to.
 *
 * Testability is decided before the test result, because a source with no runnable adapter has no
 * result to report — the backend never ran it. The other order would file every blocked source under
 * 待测试 and invite the reader to wait for a test that cannot happen.
 */
export function sourceHealthGroup(source: SourceRecord): SourceHealthKey {
  if (source.capability === "invalid") return "invalid";
  if (!isTestableSource(source)) {
    // False here means the adapter will not run, and the profile's own verdict is the reason — and
    // the word the list shows on the row.
    return getAdapterProfile(source).execution === "needs-adapter"
      ? "needs-adapter"
      : "blocked";
  }
  switch (source.testStatus ?? "untested") {
    case "passed":
      return "usable";
    case "failed":
      return "failed";
    case "empty":
      return "empty";
    default:
      return "untested";
  }
}

/**
 * The groups, in the order a reader wants them: what works, what is undecided, what is wrong.
 *
 * The labels are the list's own vocabulary rather than new words, so a reader who clicks 测试失败
 * lands on rows that read 测试失败. Two come from the filter module because the filter panel offers
 * the same words; writing them out again here is how the panel and the column drifted apart before.
 */
const groupDefinitions: Omit<SourceHealthGroup, "count">[] = [
  {
    key: "usable",
    label: statusFacetLabels.usable,
    hint: "测速通过，已经从这些源取到过内容。",
    filter: { ...clearedSourceFilter, statuses: ["usable"] },
  },
  {
    key: "untested",
    label: statusFacetLabels.untested,
    hint: "还没测过。跑一次「全部测速」才知道它们能不能用。",
    filter: { ...clearedSourceFilter, statuses: ["untested"] },
  },
  {
    key: "failed",
    label: statusFacetLabels.failed,
    hint: "请求失败或返回了错误，通常说明这个源已经失效。",
    filter: { ...clearedSourceFilter, statuses: ["failed"] },
  },
  {
    key: "empty",
    label: statusFacetLabels.empty,
    hint: "能连上，但没取到任何内容，可能接口改版或分类为空。",
    filter: { ...clearedSourceFilter, statuses: ["empty"] },
  },
  {
    key: "invalid",
    label: statusFacetLabels.invalid,
    hint: "配置里缺少地址或名称，Moseek 无法使用它们。",
    filter: { ...clearedSourceFilter, statuses: ["invalid"] },
  },
  {
    key: "blocked",
    label: executionFacetLabels.blocked,
    hint: "远程 JAR 或危险协议。Moseek 不执行远程代码，所以这些源不会被使用。",
    filter: { ...clearedSourceFilter, executions: ["blocked"] },
  },
  {
    key: "needs-adapter",
    label: executionFacetLabels["needs-adapter"],
    hint: "使用 Moseek 还不支持的非 HTTP 协议，需要单独的适配器。",
    filter: { ...clearedSourceFilter, executions: ["needs-adapter"] },
  },
];

/** How many sources are in each state. */
export function countSourceHealth(sources: SourceRecord[]) {
  const counts = new Map<SourceHealthKey, number>();
  for (const source of sources) {
    const key = sourceHealthGroup(source);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The groups worth showing. Empty ones are dropped — rows each reading 0 are noise the verdict
 * already covers — except 可用, which survives at zero because "nothing has been confirmed working"
 * is the most important thing this page can say and hiding it would leave no verdict at all.
 */
export function summarizeSourceHealth(sources: SourceRecord[]): SourceHealthGroup[] {
  const counts = countSourceHealth(sources);
  return groupDefinitions
    .map((group) => ({ ...group, count: counts.get(group.key) ?? 0 }))
    .filter((group) => group.count > 0 || group.key === "usable");
}

/**
 * One sentence answering "can I watch anything".
 *
 * Deliberately not "配置解析成功". That reports on our parser, which is not what the reader is
 * asking; and it was also the number that disagreed with the header, because it counted raw entries
 * rather than sources.
 */
export function healthVerdict(sources: SourceRecord[]): string {
  if (sources.length === 0) return "当前配置里还没有源。";

  const counts = countSourceHealth(sources);
  const usable = counts.get("usable") ?? 0;
  const untested = counts.get("untested") ?? 0;

  if (usable === 0 && untested === sources.length) {
    return `${sources.length} 个源都还没有测速，现在还不知道哪些能用。`;
  }
  if (usable === 0) {
    return `${sources.length} 个源里没有一个确认可用。`;
  }

  const parts = [`${usable} 个已确认可用`];
  if (untested > 0) parts.push(`${untested} 个待测试`);
  const remaining = sources.length - usable - untested;
  if (remaining > 0) parts.push(`${remaining} 个需要处理`);
  return `${sources.length} 个源：${parts.join("，")}。`;
}

/** One problem, addressed to the thing it is about rather than to its index in an array. */
export interface ReportFinding {
  severity: "error" | "warning";
  message: string;
  /** The entries this applies to, named as the reader knows them. */
  targets: string[];
}

/**
 * The reader-facing name of the entry an issue path points at.
 *
 * Paths are `sites.0`, `lives.3`, `parses.41` — an index into an array the reader has not seen, and
 * the single biggest reason the old report was unreadable: with four identical messages, the only
 * thing distinguishing them was three pairs of digits. The name is what the reader can act on.
 *
 * Falls back to the path when the entry cannot be identified, because a vague name is still better
 * than a wrong one.
 */
export function describeIssueTarget(
  issue: ParseIssue,
  result: Pick<ParseResult, "sources" | "parseServices">,
): string {
  const match = /^(sites|lives|parses)\.(\d+)$/.exec(issue.path);
  if (!match) return issue.path;

  const [, section, rawIndex] = match;
  const index = Number(rawIndex);
  if (section === "parses") {
    const name = result.parseServices[index]?.name;
    return name ? `解析服务「${name}」` : issue.path;
  }
  const sources = result.sources.filter((source) =>
    section === "lives" ? source.sourceType === "live" : source.sourceType !== "live",
  );
  const name = sources[index]?.name;
  return name ? `${section === "lives" ? "直播源" : "影视源"}「${name}」` : issue.path;
}

/**
 * Groups the parser's findings by what they say.
 *
 * Four services with a non-HTTP address are one problem with four names, not four problems — and
 * saying so is what turns the list from something to scan into something to act on. Errors come
 * before warnings, and within a severity the largest group comes first, so the top of the list is
 * where the work is.
 */
export function groupIssues(
  issues: ParseIssue[],
  result: Pick<ParseResult, "sources" | "parseServices">,
): ReportFinding[] {
  const byMessage = new Map<string, ReportFinding>();
  for (const issue of issues) {
    const existing = byMessage.get(issue.message);
    const target = describeIssueTarget(issue, result);
    if (existing) {
      if (!existing.targets.includes(target)) existing.targets.push(target);
      continue;
    }
    byMessage.set(issue.message, {
      severity: issue.severity,
      message: issue.message,
      targets: [target],
    });
  }

  return [...byMessage.values()].sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === "error" ? -1 : 1;
    return right.targets.length - left.targets.length;
  });
}

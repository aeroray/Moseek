import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleX,
  CopyMinus,
  Info,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
  addVisualEntry,
  dedupeParseServices,
  findDuplicateParseServices,
  hasUnpreservedSyntax,
  readVisualConfig,
  removeVisualEntry,
  removeVisualSetting,
  removeVisualSettings,
  updateVisualEntryField,
  updateVisualSetting,
  type VisualEntry,
  type VisualSection,
  type VisualSectionKey,
} from "@/features/config/config-visual";
import { cn } from "@/lib/utils";
import { isTestableSource } from "@/lib/adapters";
import type { SourceRecord, SourceTestStatus } from "@/types/moseek";

/**
 * How many rows a section shows before it offers 显示全部.
 *
 * Measured on the owner's configuration: 影视源 holds 695 entries, and mounting all of them is what
 * made the dialog slow to open and unresponsive inside. 50 is more than fills the visible area, so
 * nothing is lost by not rendering the rest until asked for — and a search always renders every
 * match, because that is the case where a cap would hide what the user is looking for.
 */
const INITIAL_ROWS = 50;

/**
 * The visual editor for a configuration.
 *
 * A configuration is 340 sources and a handful of scalar settings. As text that is unreadable, which
 * is why the code editor exists, but most of what a user does — rename a source, correct an address,
 * drop one — does not need a text editor at all. This presents the same document as lists of named
 * rows, each field a labelled input, so the work is typing in a box rather than finding the right
 * brace.
 *
 * Every change is applied to the text immediately and handed back through `onChange`, so the two
 * modes are two views of one document rather than two copies. The cost is that saving re-serialises
 * the file, which normalises its formatting and drops comments; that is stated once, up front, and
 * it is why the code editor is still there.
 */
export function ConfigVisualEditor({
  value,
  onChange,
  sources,
}: {
  value: string;
  onChange: (next: string) => void;
  /** The parsed sources, so a row can show what testing it found. */
  sources: SourceRecord[];
}) {
  const model = useMemo(() => readVisualConfig(value), [value]);
  const [expandedSection, setExpandedSection] = useState<VisualSectionKey | null>(
    "sites",
  );
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);

  /**
   * Test results by source key.
   *
   * The editor holds text and the results live on parsed records, so the key is the join. Built
   * once per render from the source list rather than looked up per row, because a 340-row list
   * would otherwise scan the whole array for each one.
   */
  const testByKey = useMemo(() => {
    const map = new Map<string, SourceRecord>();
    for (const source of sources) map.set(source.key, source);
    return map;
  }, [sources]);

  if (!model.ok) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/70 p-8 text-center">
        <Info className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">无法以可视化方式打开</p>
        <p className="max-w-md text-xs leading-5 text-muted-foreground">
          {model.message}
          <br />
          请切换到「代码模式」修正语法，或重新导入配置。
        </p>
      </div>
    );
  }

  const hasComments = useMemo(() => hasUnpreservedSyntax(value), [value]);
  const normalizedQuery = query.trim().toLowerCase();

  const apply = (next: string, error: string | null) => {
    setFieldError(error);
    if (error) return;
    onChange(next);
  };

  return (
    /* No padding on this wrapper. The inset lives on the two things that need it — the search box
       and the scroll area's content — because the scroll area has to span the card's full width.
       That is the structure the table tabs use, and it is what keeps the scrollbar from moving
       anything: the bar is drawn over the padding rather than taking width from the list.

       Measured before this: the list was 1072px against the search box's 1078px, and the section box
       sat 17px from the card's left edge but 23px from its right. Both were the native scrollbar's
       6px. My earlier measurement missed it because the fixture had three sources — nothing
       overflowed — and because Chrome was started with `--hide-scrollbars`. */
    <div className="flex min-h-0 flex-1 flex-col gap-3 pt-4">
      {hasComments && (
        <div className="mx-4 flex items-start gap-2 rounded-md border border-[color:var(--status-adapter-border)] bg-[color:var(--status-adapter-bg)] p-2.5 text-xs leading-5 text-[color:var(--status-adapter)]">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          这份配置里有注释。可视化模式保存时会重新排版并去掉注释，需要保留请用「代码模式」。
        </div>
      )}

      {fieldError && (
        <div className="mx-4 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
          {fieldError}
        </div>
      )}

      <div className="relative px-4">
        <Search
          className="absolute left-6 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
          aria-hidden="true"
        />
        <Input
          size="sm"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称、标识或地址"
          className="pl-8"
          aria-label="搜索配置项"
        />
      </div>

      {/* The same `ScrollArea` the table tabs use, rather than a native `overflow-y-auto`: a native
          bar is laid out inside the box and takes width from the content. */}
      <ScrollArea className="min-h-0 flex-1" viewportClassName="[&>div]:!block">
        <div className="flex flex-col gap-3 px-4 pb-4">
          {model.sections.map((section) => (
            <SectionBlock
              key={section.key}
              section={section}
              query={normalizedQuery}
              expanded={expandedSection === section.key}
              onToggle={() =>
                setExpandedSection(
                  expandedSection === section.key ? null : section.key,
                )
              }
              editingIndex={editingIndex}
              onEdit={setEditingIndex}
              onApply={apply}
              rawText={value}
              testByKey={testByKey}
            />
          ))}

          {model.settings.length > 0 && (
            <SettingsBlock
              settings={model.settings}
              rawText={value}
              onApply={apply}
              query={normalizedQuery}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** One section: a heading with a count, and the entries under it. */
function SectionBlock({
  section,
  query,
  expanded,
  onToggle,
  editingIndex,
  onEdit,
  onApply,
  rawText,
  testByKey,
}: {
  section: VisualSection;
  query: string;
  expanded: boolean;
  onToggle: () => void;
  editingIndex: number | null;
  onEdit: (index: number | null) => void;
  onApply: (next: string, error: string | null) => void;
  rawText: string;
  testByKey: Map<string, SourceRecord>;
}) {
  // Reset when the section is collapsed or the query changes, so a "显示全部" in one section does not
  // silently apply to the next one the user opens.
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    setShowAll(false);
  }, [query, expanded, section.key]);
  const matching = useMemo(
    () =>
      query
        ? section.entries.filter(
            (entry) =>
              entry.label.toLowerCase().includes(query) ||
              entry.summary.toLowerCase().includes(query),
          )
        : section.entries,
    [query, section.entries],
  );

  // A search is never capped, so the cap only ever applies to browsing the whole section.
  const visible = query || showAll ? matching : matching.slice(0, INITIAL_ROWS);

  // Which rows repeat an address already listed above them. Computed only for 解析服务: it is the
  // one section the resolver consumes in order and under a cap, so it is the one where a repeat
  // costs something.
  //
  // Memoised, and that is not a micro-optimisation: this parses the whole document, and it used to run
  // in the render body — so it re-parsed the configuration on EVERY render, including the render
  // caused by each keystroke. Measured on the owner's 266 KB configuration, one parse is ~22 ms, which
  // is what made typing feel stuck.
  //
  // It sits ABOVE the early return below, and that placement is required rather than stylistic: a hook
  // after a conditional return runs on some renders and not others, which React reports as "rendered
  // fewer hooks than expected". A test caught exactly that.
  const duplicateIndexes = useMemo(
    () =>
      section.key === "parses"
        ? new Set(findDuplicateParseServices(rawText))
        : new Set<number>(),
    [section.key, rawText],
  );
  // Counted over the whole section rather than the filtered rows: the button acts on the document,
  // so its number has to describe the document. A search would otherwise make it say "去掉 0 条"
  // while the file still holds eighteen.
  const duplicateCount =
    section.key === "parses"
      ? section.entries.filter((entry) => duplicateIndexes.has(entry.index)).length
      : 0;

  // A search that matches nothing in a section hides it, so the results are the only thing on
  // screen. A section with no entries at all is still shown, because it is where the add button is.
  if (query && matching.length === 0) return null;

  // **A search opens the sections it matched.** Without this the results of a search are invisible
  // whenever they are in a collapsed section — which is every section but the one the user happened
  // to have open. A search that reports nothing found while the match sits behind a closed heading
  // is worse than no search at all.
  const isOpen = expanded || Boolean(query);

  return (
    <section className="rounded-lg border border-border/70 bg-card/40">
      {/* `px-2`, not `px-3`. The section box already sits 16px inside the card (the content's own
          `px-4`) and its border takes 1px, so 8px of inner padding puts the heading and the entry
          names 25px from the card — exactly where the table tabs' `pl-6` puts theirs. The old 12px
          landed at 29px, which is what made this list's rows look differently spaced from the
          adapter list's. Measured against the rendered page, not guessed. */}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-2.5 text-left"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        {isOpen ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="text-sm font-medium text-foreground">{section.title}</span>
        <Badge variant="secondary" className="tabular-nums">
          {section.entries.length}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {section.hint}
        </span>
      </button>

      {isOpen && (
        <div className="flex flex-col border-t border-border/60">
          {matching.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {query ? "没有匹配的条目。" : `还没有${section.title}，可以添加一条。`}
            </p>
          ) : (
            <>
              {visible.map((entry) => (
                <EntryRow
                  key={entry.index}
                  entry={entry}
                  source={entry.sourceKey ? testByKey.get(entry.sourceKey) : undefined}
                  section={section.key}
                  sectionTitle={section.title}
                  editing={editingIndex === entry.index}
                  duplicate={duplicateIndexes.has(entry.index)}
                  onEdit={() =>
                    onEdit(editingIndex === entry.index ? null : entry.index)
                  }
                  onApply={onApply}
                  rawText={rawText}
                />
              ))}
              {/* The rest of the section, on request.
                  
                  Measured on the owner's configuration: the 影视源 section holds 695 entries, and
                  every one of them was mounted the moment the dialog opened — that is the delay
                  before the dialog appears and the unresponsiveness inside it, and it has nothing to
                  do with parsing. A section this long is also not something anyone reads top to
                  bottom; they search or they scroll to a name they already have in mind, and both
                  work on the first page.
                  
                  A search is never capped: when the user is looking for something specific, showing
                  only part of the matches is the one case where a cap is actively wrong. */}
              {!query && matching.length > visible.length && (
                <div className="flex items-center justify-between gap-2 px-2 py-2">
                  <span className="text-xs text-muted-foreground">
                    已显示 {visible.length} / {matching.length} 条
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowAll(true)}
                  >
                    显示全部
                  </Button>
                </div>
              )}
            </>
          )}

          <div className="flex flex-col gap-2 border-t border-border/60 p-2">
            {/* 解析服务 only. The resolver tries the first 12 usable services in the file's own
                order, so an entry repeating an earlier address spends one of those places on an
                attempt that has already been made — measured, 18 of the author's 75 entries are
                repeats of 12 addresses. Offered only when there is something to remove, so the
                button's presence answers "is there anything to tidy". */}
            {section.key === "parses" && duplicateCount > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full gap-1.5"
                onClick={() =>
                  onApply(dedupeParseServices(rawText), null)
                }
              >
                <CopyMinus className="size-3.5" aria-hidden="true" />
                去掉 {duplicateCount} 条重复地址
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full gap-1.5 text-muted-foreground"
              onClick={() =>
                onApply(addVisualEntry(rawText, section.key), null)
              }
            >
              <Plus className="size-3.5" aria-hidden="true" />
              添加{section.title}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Whether this entry is any good, on the row itself.
 *
 * The point of the visual editor is to answer "is this configuration any good", and the answer for a
 * specific entry comes from what the source list already knows. Showing it here means a user
 * scanning 340 rows can see which ones work without opening each or going back to the list.
 *
 * The two states that are not test outcomes are reported first, because 未测试 would be misleading
 * for them: a record the parser could not build can never be tested, and an entry with no runnable
 * adapter has nothing to test with. Saying 未测试 for either implies the user simply has not got round
 * to it — which is exactly the judgement this badge exists to support.
 *
 * An entry with no matching source shows nothing at all: it may be one the user has just added, and
 * no claim can be made about it yet.
 */
function TestResultBadge({ source }: { source: SourceRecord | undefined }) {
  if (!source) return null;

  if (source.capability === "invalid") {
    return (
      <Badge
        variant="outline"
        className="shrink-0 gap-1 border-destructive/40 bg-destructive/10 px-1.5 py-0 text-[10px] text-destructive"
        title={source.capabilityNote || "这条配置缺少必要字段，无法使用。"}
      >
        <CircleAlert className="size-2.5" aria-hidden="true" />
        配置无效
      </Badge>
    );
  }

  if (!isTestableSource(source)) {
    return (
      <Badge
        variant="outline"
        className="shrink-0 gap-1 border-border/70 bg-muted/40 px-1.5 py-0 text-[10px] text-muted-foreground"
        title={source.capabilityNote || "没有可运行的适配器，无法测试。"}
      >
        <CircleAlert className="size-2.5" aria-hidden="true" />
        无法测试
      </Badge>
    );
  }

  const status: SourceTestStatus = source.testStatus ?? "untested";
  const isLive = source.sourceType === "live";

  const config = {
    passed: {
      label: `${source.testItemCount ?? 0} ${isLive ? "个频道" : "条内容"}`,
      Icon: Check,
      className:
        "border-[color:var(--status-supported-border)] bg-[color:var(--status-supported-bg)] text-[color:var(--status-supported)]",
    },
    failed: {
      label: "测试失败",
      Icon: CircleX,
      className:
        "border-[color:var(--status-blocked-border)] bg-[color:var(--status-blocked-bg)] text-[color:var(--status-blocked)]",
    },
    empty: {
      label: isLive ? "无频道" : "无内容",
      Icon: CircleAlert,
      className:
        "border-[color:var(--status-adapter-border)] bg-[color:var(--status-adapter-bg)] text-[color:var(--status-adapter)]",
    },
    blocked: {
      label: "未执行",
      Icon: CircleAlert,
      className: "border-border/70 bg-muted/40 text-muted-foreground",
    },
    untested: {
      label: "未测试",
      Icon: CircleAlert,
      className: "border-border/70 bg-muted/40 text-muted-foreground",
    },
  }[status];

  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 gap-1 px-1.5 py-0 text-[10px]", config.className)}
      // The message is the reason, and it is the one thing the badge cannot show in a 10px pill.
      title={source.testMessage || config.label}
    >
      <config.Icon className="size-2.5" aria-hidden="true" />
      {config.label}
    </Badge>
  );
}

/**
 * One entry.
 *
 * Collapsed it is a name and its address, which is what a user scans for. Expanded it is the fields
 * as labelled inputs. Editing one field at a time in a form that is always open would make a
 * 340-entry list into a 340-form wall.
 */
function EntryRow({
  entry,
  source,
  section,
  sectionTitle,
  editing,
  onEdit,
  onApply,
  rawText,
  duplicate,
}: {
  entry: VisualEntry;
  /** The parsed record for this entry, when one matches. */
  source: SourceRecord | undefined;
  section: VisualSectionKey;
  sectionTitle: string;
  editing: boolean;
  onEdit: () => void;
  onApply: (next: string, error: string | null) => void;
  rawText: string;
  /** Whether an earlier row already lists this address. */
  duplicate: boolean;
}) {
  return (
    <div className="border-b border-border/40 last:border-b-0">
      <div className="flex items-center gap-2 px-2 py-2.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          aria-expanded={editing}
          aria-label={`编辑 ${entry.label}`}
          onClick={onEdit}
        >
          <span className="shrink-0 text-sm text-foreground">{entry.label}</span>
          {/* No address here. It was the second half of every row and it is what a user cannot
              read: 340 lines of `https://…/api.php/provide/vod` distinguish nothing, and the
              address is one click away in the fields below. What the space is worth is the answer
              to "does this one work", which is what a badge carries. */}
          <TestResultBadge source={source} />
          {duplicate && (
            <Badge
              variant="outline"
              className="shrink-0 gap-1 px-1.5 py-0 text-[10px] text-muted-foreground"
              title="这个地址在上面已经有一条了。播放时会按顺序尝试解析服务，重复的一条会占掉一次尝试机会。"
            >
              <CopyMinus className="size-2.5" aria-hidden="true" />
              重复
            </Badge>
          )}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={`删除 ${entry.label}`}
          title={`从配置中删除这条${sectionTitle}`}
          onClick={() => onApply(removeVisualEntry(rawText, section, entry.index), null)}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </div>

      {editing && (
        <div className="grid gap-2.5 bg-muted/20 px-2 pb-3 pt-1 sm:grid-cols-2">
          {entry.fields.map((field) => (
            <FieldRow
              key={field.name}
              field={field}
              onCommit={(next) =>
                onApply(
                  ...(() => {
                    const result = updateVisualEntryField(
                      rawText,
                      section,
                      entry.index,
                      field.name,
                      next,
                    );
                    return [result.text, result.error] as const;
                  })(),
                )
              }
            />
          ))}
          {entry.extraFieldCount > 0 && (
            <p className="text-[11px] leading-5 text-muted-foreground sm:col-span-2">
              这条还有 {entry.extraFieldCount} 个字段未在此展示，编辑时会原样保留。需要修改请用「代码模式」。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** One editable field. */
function FieldRow({
  field,
  onCommit,
}: {
  field: VisualEntry["fields"][number];
  onCommit: (value: string) => void;
}) {
  // A local draft so typing does not re-serialise the whole configuration on every keystroke: 340
  // entries re-serialised per character is visible lag, and it would also fight the caret.
  const [draft, setDraft] = useState(field.value);
  const [lastValue, setLastValue] = useState(field.value);
  if (lastValue !== field.value) {
    setLastValue(field.value);
    setDraft(field.value);
  }

  const commit = () => {
    if (draft !== field.value) onCommit(draft);
  };

  if (field.kind === "flag") {
    return (
      <label className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-mono">{field.name}</span>
          {field.required && <span className="text-destructive">*</span>}
        </span>
        <Switch
          size="sm"
          checked={draft === "true"}
          aria-label={field.name}
          onCheckedChange={(checked) => onCommit(checked ? "true" : "false")}
        />
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-mono">{field.name}</span>
        {field.required && (
          <span className="text-destructive" title="必填">
            *
          </span>
        )}
      </span>
      {field.kind === "json" ? (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          rows={3}
          spellCheck={false}
          aria-label={field.name}
          className={cn(
            "w-full rounded-md border border-input/80 bg-input/20 px-2.5 py-1.5 font-mono text-[11px] leading-5 shadow-2xs outline-none",
            "focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/20",
          )}
        />
      ) : (
        <Input
          size="sm"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          aria-label={field.name}
          className={field.kind === "text" && field.name !== "name" ? "font-mono" : undefined}
        />
      )}
    </label>
  );
}

/**
 * The top-level settings that are not sources or parser services.
 *
 * These belong to the TVBox client: `ijk` picks a decoder, `ads` and `rules` filter advertising,
 * `wallpaper` is its backdrop, `spider` names a remote JAR it loads. Moseek reads none of them —
 * verified across the Rust and frontend code — and its export writes the normalized snapshot, which
 * carries only the sources and the parser services, so these values do not leave the application
 * either. Measured on the author's configuration, 9,134 of 50,419 bytes are here and are dropped by
 * an export.
 *
 * That is why clearing them is offered directly rather than hidden behind an empty text box: a user
 * who wants a configuration describing what Moseek actually uses has nothing to lose, and the only
 * way to find that out today was to read the source.
 */
function SettingsBlock({
  settings,
  rawText,
  onApply,
  query,
}: {
  settings: { key: string; value: string; kind: "text" | "json" }[];
  rawText: string;
  onApply: (next: string, error: string | null) => void;
  query: string;
}) {
  const matching = query
    ? settings.filter((setting) => setting.key.toLowerCase().includes(query))
    : settings;
  if (matching.length === 0) return null;

  return (
    <section className="rounded-lg border border-border/70 bg-card/40 p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">其他设置</h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            TVBox 客户端的设置：解码器、广告过滤、壁纸等。Moseek 不读取它们，导出时也不会带上。
          </p>
        </div>
        {/* Acts on every setting in the document, so the count is the section's own — not the
            filtered rows'. Offered only when there is something to clear. */}
        {settings.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5 text-destructive hover:text-destructive"
            onClick={() =>
              onApply(
                removeVisualSettings(
                  rawText,
                  settings.map((setting) => setting.key),
                ),
                null,
              )
            }
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            清理全部 {settings.length} 项
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2.5">
        {matching.map((setting) => (
          <SettingRow
            key={setting.key}
            setting={setting}
            onCommit={(next) =>
              onApply(...(() => {
                const result = updateVisualSetting(rawText, setting.key, next);
                return [result.text, result.error] as const;
              })())
            }
            onRemove={() => onApply(removeVisualSetting(rawText, setting.key), null)}
          />
        ))}
      </div>
    </section>
  );
}

function SettingRow({
  setting,
  onCommit,
  onRemove,
}: {
  setting: { key: string; value: string; kind: "text" | "json" };
  onCommit: (value: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(setting.value);
  const [lastValue, setLastValue] = useState(setting.value);
  if (lastValue !== setting.value) {
    setLastValue(setting.value);
    setDraft(setting.value);
  }

  return (
    <div className="flex items-end gap-1.5">
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-mono text-xs text-muted-foreground">{setting.key}</span>
      {setting.kind === "json" ? (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => draft !== setting.value && onCommit(draft)}
          rows={3}
          spellCheck={false}
          aria-label={setting.key}
          className="w-full rounded-md border border-input/80 bg-input/20 px-2.5 py-1.5 font-mono text-[11px] leading-5 shadow-2xs outline-none focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/20"
        />
      ) : (
        <Input
          size="sm"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => draft !== setting.value && onCommit(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (draft !== setting.value) onCommit(draft);
            }
          }}
          aria-label={setting.key}
        />
      )}
      </label>
      {/* Clearing the box already removes the key, but nothing said so. The button states it. */}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`删除设置 ${setting.key}`}
        title={`从配置中删除 ${setting.key}`}
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

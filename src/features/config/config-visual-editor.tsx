import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Info,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  addVisualEntry,
  hasUnpreservedSyntax,
  readVisualConfig,
  removeVisualEntry,
  updateVisualEntryField,
  updateVisualSetting,
  type VisualEntry,
  type VisualSection,
  type VisualSectionKey,
} from "@/features/config/config-visual";
import { cn } from "@/lib/utils";

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
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const model = useMemo(() => readVisualConfig(value), [value]);
  const [expandedSection, setExpandedSection] = useState<VisualSectionKey | null>(
    "sites",
  );
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);

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

  const hasComments = hasUnpreservedSyntax(value);
  const normalizedQuery = query.trim().toLowerCase();

  const apply = (next: string, error: string | null) => {
    setFieldError(error);
    if (error) return;
    onChange(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {hasComments && (
        <div className="flex items-start gap-2 rounded-md border border-[color:var(--status-adapter-border)] bg-[color:var(--status-adapter-bg)] p-2.5 text-xs leading-5 text-[color:var(--status-adapter)]">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          这份配置里有注释。可视化模式保存时会重新排版并去掉注释，需要保留请用「代码模式」。
        </div>
      )}

      {fieldError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
          {fieldError}
        </div>
      )}

      <div className="relative">
        <Search
          className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
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

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
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
}: {
  section: VisualSection;
  query: string;
  expanded: boolean;
  onToggle: () => void;
  editingIndex: number | null;
  onEdit: (index: number | null) => void;
  onApply: (next: string, error: string | null) => void;
  rawText: string;
}) {
  const matching = query
    ? section.entries.filter(
        (entry) =>
          entry.label.toLowerCase().includes(query) ||
          entry.summary.toLowerCase().includes(query),
      )
    : section.entries;

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
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
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
            <p className="px-3 py-3 text-xs text-muted-foreground">
              {query ? "没有匹配的条目。" : `还没有${section.title}，可以添加一条。`}
            </p>
          ) : (
            matching.map((entry) => (
              <EntryRow
                key={entry.index}
                entry={entry}
                section={section.key}
                sectionTitle={section.title}
                editing={editingIndex === entry.index}
                onEdit={() =>
                  onEdit(editingIndex === entry.index ? null : entry.index)
                }
                onApply={onApply}
                rawText={rawText}
              />
            ))
          )}

          <div className="border-t border-border/60 p-2">
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
 * One entry.
 *
 * Collapsed it is a name and its address, which is what a user scans for. Expanded it is the fields
 * as labelled inputs. Editing one field at a time in a form that is always open would make a
 * 340-entry list into a 340-form wall.
 */
function EntryRow({
  entry,
  section,
  sectionTitle,
  editing,
  onEdit,
  onApply,
  rawText,
}: {
  entry: VisualEntry;
  section: VisualSectionKey;
  sectionTitle: string;
  editing: boolean;
  onEdit: () => void;
  onApply: (next: string, error: string | null) => void;
  rawText: string;
}) {
  return (
    <div className="border-b border-border/40 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          aria-expanded={editing}
          aria-label={`编辑 ${entry.label}`}
          onClick={onEdit}
        >
          <span className="shrink-0 text-sm text-foreground">{entry.label}</span>
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {entry.summary || "（未填写地址）"}
          </span>
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
        <div className="grid gap-2.5 bg-muted/20 px-3 pb-3 pt-1 sm:grid-cols-2">
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

/** The scalar settings: a label and its value. */
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
      <h3 className="mb-2 text-sm font-medium text-foreground">其他设置</h3>
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
          />
        ))}
      </div>
    </section>
  );
}

function SettingRow({
  setting,
  onCommit,
}: {
  setting: { key: string; value: string; kind: "text" | "json" };
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(setting.value);
  const [lastValue, setLastValue] = useState(setting.value);
  if (lastValue !== setting.value) {
    setLastValue(setting.value);
    setDraft(setting.value);
  }

  return (
    <label className="flex flex-col gap-1">
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
  );
}

import { useEffect, useRef } from "react";
import { basicSetup, EditorView } from "codemirror";
import { json } from "@codemirror/lang-json";
import { EditorState } from "@codemirror/state";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type JsonEditorProps = {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  className?: string;
  "aria-label"?: string;
};

const editorTheme = EditorView.theme({
  "&": {
    height: "max-content",
    minHeight: "100%",
    color: "var(--foreground)",
    backgroundColor: "var(--background)",
    fontFamily: "var(--font-sans)",
    fontSize: "0.8125rem",
  },
  ".cm-scroller": {
    minHeight: "100%",
    overflow: "visible",
    fontFamily: "inherit",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "1rem 0",
    caretColor: "var(--ring)",
  },
  ".cm-line": {
    padding: "0 1rem",
  },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--accent) 32%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklab, var(--accent) 48%, transparent)",
    color: "var(--foreground)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--accent) 70%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--primary)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-tooltip": {
    border: "1px solid var(--border)",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
  },
});

export function JsonEditor({
  value,
  onChange,
  readOnly = false,
  className,
  "aria-label": ariaLabel,
}: JsonEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!hostRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          json(),
          editorTheme,
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel ?? "JSON 配置",
            "aria-multiline": "true",
            ...(readOnly ? { "aria-readonly": "true" } : {}),
          }),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current?.(update.state.doc.toString());
            }
          }),
        ],
      }),
      parent: hostRef.current,
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;

    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: value,
      },
    });
  }, [value]);

  return (
    <ScrollArea
      className={cn("min-h-0 rounded-md border bg-background", className)}
    >
      <div ref={hostRef} className="min-h-full min-w-full" />
    </ScrollArea>
  );
}

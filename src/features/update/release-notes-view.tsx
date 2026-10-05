import { Fragment } from "react";

import { cn } from "@/lib/utils";
import {
  parseInline,
  parseReleaseNotes,
} from "@/features/update/release-notes";

/**
 * Renders release notes as text.
 *
 * Every value goes through React as a child, so it is escaped — no `dangerouslySetInnerHTML` and no
 * markdown-to-HTML step. That is deliberate: the notes arrive in `latest.json`, which the minisign
 * signature does **not** cover (it signs the installer), so anyone able to answer the endpoint could
 * otherwise inject markup into this page. Plain-text rendering makes that impossible rather than
 * merely unlikely.
 */
export function ReleaseNotes({ markdown }: { markdown: string }) {
  const blocks = parseReleaseNotes(markdown);
  if (blocks.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return (
            <p
              key={index}
              className={cn(
                "text-xs font-semibold text-foreground",
                block.level === 2 ? "mt-1 first:mt-0" : "text-muted-foreground",
              )}
            >
              <Inline text={block.text} />
            </p>
          );
        }
        if (block.kind === "list") {
          return (
            <ul key={index} className="flex list-disc flex-col gap-1 pl-4">
              {block.items.map((item, itemIndex) => (
                <li
                  key={itemIndex}
                  className="text-xs leading-5 whitespace-pre-line text-muted-foreground"
                >
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={index} className="text-xs leading-5 text-muted-foreground">
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}

/** Splits `**bold**` into `<strong>` runs, keeping everything else as literal text. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((run, index) =>
        run.bold ? (
          <strong key={index} className="font-semibold text-foreground">
            {run.text}
          </strong>
        ) : (
          <Fragment key={index}>{run.text}</Fragment>
        ),
      )}
    </>
  );
}

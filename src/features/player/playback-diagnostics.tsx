import type { ReactNode } from "react";
import { ScrollText } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { MediaDiagnosticPanel } from "@/features/player/media-diagnostic-panel";
import type { MediaDiagnosticSnapshot } from "@/features/player/media-diagnostics";
import { cn } from "@/lib/utils";

interface PlaybackDiagnosticsProps {
  snapshot: MediaDiagnosticSnapshot | null;
  /** The failure explanation, shown above the report. */
  note?: string | null;
  /** Extra classes for the trigger, so each page can match its own control row. */
  triggerClassName?: string;
  /**
   * Whether to render the trigger as an icon-only button.
   *
   * The player overlays it on the video, where a labelled button would sit on top of the picture;
   * the control rows below the player have room for the word.
   */
  iconOnly?: boolean;
}

/**
 * The 播放诊断 entry point and its dialog.
 *
 * The same dialog was written out in the watch page, the live workspace and the favourites page —
 * three copies of one thing, which is how "the same button looks different depending on where you
 * are" starts. Every page that can fail to play now renders this, so the panel, the heading and
 * the copy action are identical everywhere by construction.
 */
export function PlaybackDiagnostics({
  snapshot,
  note,
  triggerClassName,
  iconOnly = false,
}: PlaybackDiagnosticsProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {iconOnly ? (
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label="播放诊断"
            title="播放诊断"
            className={cn("backdrop-blur-xs", triggerClassName)}
          >
            <ScrollText className="size-3.5" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("text-muted-foreground", triggerClassName)}
          >
            <ScrollText
              className="size-3.5"
              data-icon="inline-start"
              aria-hidden="true"
            />
            播放诊断
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
        {/* The panel carries the visible heading and the copy action, so the dialog's own title
            exists only to name the dialog for assistive technology rather than duplicating the
            heading on screen. */}
        <DialogHeader className="sr-only">
          <DialogTitle>播放诊断</DialogTitle>
          <DialogDescription>
            播放失败时复制这段内容，可直接定位到具体环节
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MediaDiagnosticPanel
            // The dialog already supplies the surface, so the panel drops its own card chrome
            // instead of drawing a border inside a border.
            className="border-0 bg-transparent backdrop-blur-none"
            snapshot={snapshot}
            note={note}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Kept for callers that need to place the trigger themselves. */
export type PlaybackDiagnosticsTrigger = ReactNode;

import appLogoSrc from "@/assets/moseek-app-icon.png";
import { cn } from "@/lib/utils";

/**
 * The product mark: a continuous amber film ribbon on the app's obsidian tile.
 *
 * Keep this component as the single UI entry point for the mark. The imported 1024px master is
 * also the source of the favicon and Tauri icon set, so the navigation rail, native title bar,
 * taskbar, installer, and empty artwork states cannot drift into different identities.
 */
export function AppLogo({
  className,
  title,
}: {
  className?: string;
  /** Adds a native tooltip. Omitted where the mark is purely decorative. */
  title?: string;
}) {
  return (
    <img
      src={appLogoSrc}
      alt={title ?? "拾影"}
      title={title}
      width={1024}
      height={1024}
      draggable={false}
      className={cn("size-5 shrink-0 select-none", className)}
    />
  );
}

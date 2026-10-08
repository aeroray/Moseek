import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Copy } from "lucide-react";

import { cn } from "@/lib/utils";
import { isTauriRuntime } from "@/lib/tauri";

/**
 * The window buttons for a frameless window.
 *
 * **Why the app draws its own.** The native title bar had nothing to say: the product name, the
 * Chinese name and the slogan were all repeated inside the window already, so a strip of chrome at
 * the top spent a whole row of vertical space restating them. Removing `decorations` in
 * `tauri.conf.json` hands that row back to the content, and the buttons here are the minimum the
 * window still needs.
 *
 * **The taskbar name does not come from here.** Windows reads it from the window title, which stays
 * `拾影` in the configuration — see the note there.
 *
 * Outside Tauri (the browser preview, and every unit test) there is no window to control, so the
 * buttons are not rendered at all rather than rendered dead. A visible control that does nothing
 * teaches the user the app ignores them, which is the same rule the settings page follows.
 */
export function WindowControls({ className }: { className?: string }) {
  const [maximized, setMaximized] = useState(false);
  const supported = isTauriRuntime();

  useEffect(() => {
    if (!supported) return;
    const appWindow = getCurrentWindow();
    let cancelled = false;
    void appWindow.isMaximized().then((value) => {
      if (!cancelled) setMaximized(value);
    });
    // The button's icon has to follow the window, not the click that changed it: the user can also
    // maximize by double-clicking the drag region, or by snapping the window with the keyboard.
    const unlisten = appWindow.onResized(() => {
      void appWindow.isMaximized().then((value) => {
        if (!cancelled) setMaximized(value);
      });
    });
    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
    };
  }, [supported]);

  if (!supported) return null;

  const appWindow = getCurrentWindow();

  return (
    <div className={cn("flex items-center", className)}>
      <WindowButton
        label="最小化"
        onClick={() => void appWindow.minimize()}
        icon={<Minus className="size-3.5" aria-hidden="true" />}
      />
      <WindowButton
        label={maximized ? "还原" : "最大化"}
        onClick={() => void appWindow.toggleMaximize()}
        icon={
          maximized ? (
            <Copy className="size-3" aria-hidden="true" />
          ) : (
            <Square className="size-3" aria-hidden="true" />
          )
        }
      />
      {/* The close button is tinted on hover rather than permanently red: a red square in the corner
          of every screen reads as an error state. */}
      <WindowButton
        label="关闭"
        onClick={() => void appWindow.close()}
        danger
        icon={<X className="size-3.5" aria-hidden="true" />}
      />
    </div>
  );
}

function WindowButton({
  label,
  onClick,
  icon,
  danger,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-7 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150",
        danger
          ? "hover:bg-destructive hover:text-destructive-foreground"
          : "hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {icon}
    </button>
  );
}

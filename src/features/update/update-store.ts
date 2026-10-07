import { create } from "zustand";

import { isTauriRuntime } from "@/lib/tauri";
import { errorMessage } from "@/lib/utils";

/**
 * In-app updates from GitHub Releases.
 *
 * The check and the install are the updater plugin's own commands rather than a Rust wrapper of
 * ours. The plugin verifies a minisign signature over the downloaded installer against the public
 * key in `tauri.conf.json` before installing, and it streams download progress through an event
 * callback — both of which we would only be re-implementing.
 */

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error";

/** What the manifest said, when it announced a newer version. */
export interface AvailableUpdate {
  version: string;
  notes: string;
  date?: string;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

interface UpdateState {
  phase: UpdatePhase;
  available: AvailableUpdate | null;
  /** Percent, or null when the server did not state a length. */
  progress: number | null;
  error: string | null;
  /** When the last successful check finished, as an ISO string. */
  lastCheckedAt: string | null;
  /**
   * A check that found the app up to date. Distinct from `idle`, which means "not checked yet":
   * the panel says different things, and conflating them would claim a result nobody obtained.
   */
  upToDate: boolean;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

/** Where the last-check time is remembered. Best effort: a webview may refuse storage. */
const LAST_CHECKED_KEY = "moseek.update.lastCheckedAt";

function readLastCheckedAt(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(LAST_CHECKED_KEY);
    return value && !Number.isNaN(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

function persistLastCheckedAt(value: string) {
  try {
    window.localStorage.setItem(LAST_CHECKED_KEY, value);
  } catch {
    // Storage being unavailable must not turn a successful check into a failure.
  }
}

/**
 * Whether this runtime can check for updates at all.
 *
 * The browser preview has no updater plugin, and calling it there would throw. The panel uses this
 * to explain itself instead of offering a button that cannot work.
 */
export function canCheckForUpdates() {
  return isTauriRuntime();
}

/**
 * Percent complete, or null when the total is unknown.
 *
 * A server that sends no `content-length` gives us nothing honest to show, so the caller renders an
 * indeterminate bar rather than inventing a number.
 */
export function updatePercent(progress: UpdateProgress): number | null {
  if (!progress.total || progress.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((progress.downloaded / progress.total) * 100)));
}

/**
 * The updater plugin, loaded only in the desktop runtime.
 *
 * Imported dynamically because the module reads `window.__TAURI_INTERNALS__` at call time; a static
 * import would also pull it into the browser preview bundle, where it has nothing to talk to.
 */
async function loadUpdater() {
  const { check } = await import("@tauri-apps/plugin-updater");
  return check;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  phase: "idle",
  available: null,
  progress: null,
  error: null,
  lastCheckedAt: readLastCheckedAt(),
  upToDate: false,

  check: async () => {
    if (!canCheckForUpdates()) {
      set({
        phase: "error",
        error: "浏览器预览不会检查更新，请在桌面应用中使用此功能。",
      });
      return;
    }
    // A check during a download would fight the install for the same state.
    const current = get().phase;
    if (current === "checking" || current === "downloading" || current === "installing") return;

    set({ phase: "checking", error: null, progress: null, upToDate: false });
    try {
      const check = await loadUpdater();
      const update = await check();
      const checkedAt = new Date().toISOString();
      persistLastCheckedAt(checkedAt);
      if (!update) {
        set({
          phase: "idle",
          available: null,
          upToDate: true,
          lastCheckedAt: checkedAt,
          error: null,
        });
        return;
      }
      set({
        phase: "available",
        available: {
          version: update.version,
          notes: update.body ?? "",
          date: update.date,
        },
        upToDate: false,
        lastCheckedAt: checkedAt,
        error: null,
      });
      await update.close().catch(() => undefined);
    } catch (error) {
      // A failed check is reported, not swallowed: the user pressed a button and is owed an answer.
      set({
        phase: "error",
        error: errorMessage(error, "检查更新失败"),
        available: null,
      });
    }
  },

  install: async () => {
    if (!canCheckForUpdates()) return;
    const phase = get().phase;
    if (phase === "checking" || phase === "downloading" || phase === "installing" || !get().available) return;

    set({ phase: "downloading", error: null, progress: 0 });
    try {
      const check = await loadUpdater();
      // Re-check rather than reusing the object from `check()`: the plugin's update handle is bound
      // to the manifest it came from, and holding one across an arbitrary wait is what makes a
      // stale download URL possible.
      const update = await check();
      if (!update) {
        set({ phase: "idle", available: null, upToDate: true });
        return;
      }

      let downloaded = 0;
      let total: number | null = null;
      try {
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? null;
            set({ phase: "downloading", progress: updatePercent({ downloaded, total }) });
            return;
          }
          if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            set({ phase: "downloading", progress: updatePercent({ downloaded, total }) });
            return;
          }
          // `Finished` means the bytes are down and the installer is about to run.
          set({ phase: "installing", progress: null });
        });
      } finally {
        await update.close().catch(() => undefined);
      }

      // The installer has replaced the files on disk; the running process is still the old build, so
      // the app has to restart itself. Without this the user would be told an update had been
      // installed while still looking at the previous version.
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      set({
        phase: "error",
        error: errorMessage(error, "安装更新失败"),
        progress: null,
      });
    }
  },

  dismiss: () => {
    const phase = get().phase;
    if (phase === "checking" || phase === "downloading" || phase === "installing") return;
    set({ available: null, phase: "idle", upToDate: false, error: null, progress: null });
  },
}));

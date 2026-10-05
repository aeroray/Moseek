import { createJSONStorage, type PersistStorage, type StateStorage } from "zustand/middleware";

/**
 * The store's localStorage key, named here so the adapter and the tests agree on it.
 *
 * It is exported because the quota handling has to be provable: a test that reimplemented the key
 * would pass while the real store wrote somewhere else.
 */
export const APP_STATE_STORAGE_KEY = "moseek-app-state";

/**
 * localStorage, but a full one is a downgrade rather than a failure.
 *
 * **Why this exists.** The store persists through zustand's `persist` middleware, which writes
 * synchronously inside `setState`. When that write throws, the exception propagates out of the
 * store action and up into the caller — so importing a large configuration reported
 * `解析成功，但保存失败：Failed to execute 'setItem' ... exceeded the quota`, under the title
 * `需要修正配置`. Every part of that is wrong: the configuration WAS saved (SQLite is the source of
 * truth, and the backend write had already succeeded), nothing about the configuration needs
 * fixing, and the real problem — the browser's 5 MB string store being full — was never named.
 * The project had already recorded this exact mislabelling once ("把浏览器存储满了说成配置有问题");
 * it came back because the fix at the time reduced the payload rather than making a full store
 * survivable, so the next larger configuration raised it again.
 *
 * **What this does.** The persisted object is a MIRROR, not the data. In the desktop app the
 * document is loaded from SQLite on startup, and this mirror is what the browser-preview build
 * falls back to. So when it cannot be written, the correct behaviour is to keep the smaller part
 * and carry on — never to fail the operation that already succeeded. It degrades in two steps:
 *
 * 1. Write everything. This is the ordinary path and the only one a normal install takes.
 * 2. If the quota refuses it, drop the document payload (`rawConfig`, `normalizedConfig`,
 *    `sources`) and write the rest. Those three are the large fields and the only ones SQLite
 *    cannot re-supply to the mirror — but SQLite holds them authoritatively, and losing them costs
 *    the browser-preview fallback its content, not the user their configuration. The small fields
 *    that have no other home (theme, view, filter, favourites, footprint) are kept.
 * 3. If even that fails, give up silently. There is nothing left to drop, and throwing here would
 *    recreate the bug: a save that already succeeded would be reported as a failure.
 *
 * A write that degrades is recorded on `storagePressure`, so the UI can say the mirror is
 * incomplete instead of the user discovering it after a restart.
 */
export interface QuotaTolerantStorage extends StateStorage {
  /**
   * Whether the last write had to drop the document payload.
   *
   * Not read by any component today: the degradation is silent on purpose, because the configuration
   * is intact and a warning about the browser's temporary mirror would be alarming for something the
   * user cannot act on. It exists so the behaviour is assertable in tests, and so a future settings
   * surface has something truthful to read.
   */
  isDegraded(): boolean;
}

/** The large fields the mirror can lose, because SQLite holds them authoritatively. */
const DOCUMENT_PAYLOAD_KEYS = ["rawConfig", "normalizedConfig", "sources"] as const;

/** Whether a thrown value is the browser refusing a write for want of space. */
export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  // Chromium and WebKit use the name; Firefox uses `NS_ERROR_DOM_QUOTA_REACHED` in the name and a
  // numeric `code` of 22. Checking the name alone misses Firefox, and the message alone is fragile.
  if (candidate.name === "QuotaExceededError") return true;
  if (candidate.name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
  if (candidate.code === 22) return true;
  return (
    typeof candidate.message === "string" &&
    /quota|exceeded|storage is full/i.test(candidate.message)
  );
}

/**
 * Removes the document payload from a serialised persist envelope.
 *
 * Returns `null` when the text is not the shape this adapter writes, so a caller never guesses at
 * an unknown format — a mirror it cannot parse is left alone rather than replaced with a lossy
 * guess.
 */
export function stripPayloadFromPersistedText(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const envelope = parsed as { state?: unknown };
  if (!envelope.state || typeof envelope.state !== "object") return null;
  const state = envelope.state as Record<string, unknown>;
  let dropped = false;
  for (const key of DOCUMENT_PAYLOAD_KEYS) {
    if (key in state) {
      delete state[key];
      dropped = true;
    }
  }
  if (!dropped) return null;
  return JSON.stringify(parsed);
}

export function createQuotaTolerantStorage(): QuotaTolerantStorage {
  let degraded = false;
  return {
    isDegraded: () => degraded,
    getItem: (name) => {
      try {
        return localStorage.getItem(name);
      } catch {
        // A browser that refuses reads (private mode with storage disabled) is not a crash: the
        // store simply starts from its defaults.
        return null;
      }
    },
    setItem: (name, value) => {
      try {
        localStorage.setItem(name, value);
        degraded = false;
        return;
      } catch (error) {
        if (!isQuotaError(error)) {
          // Not a space problem — an unknown failure must not be silently swallowed, because it
          // would mean the mirror is broken for a reason worth knowing about.
          throw error;
        }
      }
      // Step 2: keep everything except the document payload.
      const reduced = stripPayloadFromPersistedText(value);
      if (reduced !== null) {
        try {
          localStorage.setItem(name, reduced);
          degraded = true;
          return;
        } catch (error) {
          if (!isQuotaError(error)) throw error;
        }
      }
      // Step 3: there is nothing left to drop. A full store must not fail the operation that
      // already succeeded in the database.
      degraded = true;
    },
    removeItem: (name) => {
      try {
        localStorage.removeItem(name);
      } catch {
        // Nothing to do: the entry is already unreachable.
      }
    },
  };
}

/**
 * The store's persist storage: JSON-encoded, and tolerant of a full localStorage.
 *
 * `createJSONStorage` is what turns the string-level `StateStorage` above into the
 * `PersistStorage` the middleware expects, and it is not optional — zustand hands the middleware
 * a parsed object, so an adapter that only understands strings would be asked to store
 * `[object Object]`. Its own `getItem` is also where a corrupt mirror is caught and treated as
 * absent, which is the behaviour this wants.
 *
 * **A missing `localStorage` is not an error.** `createJSONStorage` returns `undefined` when there
 * is no storage at all, and the middleware reads that as "keep everything in memory". Throwing here
 * would crash the whole store — and therefore the app — on a browser with storage disabled, which is
 * strictly worse than the degradation it would be reporting. Returning `undefined` lets zustand do
 * the right thing, so the parameter type permits it.
 */
export function createAppPersistStorage(): PersistStorage<unknown> | undefined {
  return createJSONStorage(() => createQuotaTolerantStorage());
}

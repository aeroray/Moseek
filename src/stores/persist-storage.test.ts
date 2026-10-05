import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAppPersistStorage,
  createQuotaTolerantStorage,
  isQuotaError,
  stripPayloadFromPersistedText,
} from "@/stores/persist-storage";
import { useAppStore } from "@/stores/app-store";

/**
 * A `localStorage` that refuses writes once the payload passes a byte budget.
 *
 * The real failure is a browser refusing a write, so the test has to be able to produce that
 * refusal on demand — a stub that always accepts would let every assertion below pass while the
 * bug was present.
 */
function createBoundedStorage(budgetBytes: number): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      const text = String(value);
      if (Buffer.byteLength(text, "utf8") > budgetBytes) {
        const error = new Error("Failed to execute 'setItem' on 'Storage'");
        error.name = "QuotaExceededError";
        throw error;
      }
      store.set(key, text);
    },
  } as Storage;
}

const realLocalStorage = window.localStorage;

function useStorage(storage: Storage) {
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

/** A persisted envelope of roughly the shape zustand writes. */
function envelope(payloadBytes: number) {
  return JSON.stringify({
    state: {
      activeView: "config",
      theme: "dark",
      rawConfig: "x".repeat(payloadBytes),
      normalizedConfig: "{}",
      sources: [{ key: "a" }],
    },
    version: 0,
  });
}

describe("isQuotaError", () => {
  it("recognises the names browsers actually use", () => {
    // Chromium/WebKit use the first name; Firefox uses the second. Checking only the first is the
    // common mistake, and it would make this whole module a no-op on Firefox.
    const chromium = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    const firefox = Object.assign(new Error("quota"), { name: "NS_ERROR_DOM_QUOTA_REACHED" });
    expect(isQuotaError(chromium)).toBe(true);
    expect(isQuotaError(firefox)).toBe(true);
    // Firefox's legacy numeric code, with no helpful name.
    expect(isQuotaError(Object.assign(new Error("nope"), { code: 22 }))).toBe(true);
  });

  it("does not mistake an unrelated failure for a full store", () => {
    // A genuine bug must still throw. Treating everything as "storage full" would hide it.
    expect(isQuotaError(new Error("Network unreachable"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError("quota")).toBe(false);
  });
});

describe("stripPayloadFromPersistedText", () => {
  it("removes the three large fields and keeps the small ones", () => {
    const reduced = stripPayloadFromPersistedText(envelope(100));
    expect(reduced).not.toBeNull();
    const parsed = JSON.parse(reduced as string);
    expect(parsed.state.rawConfig).toBeUndefined();
    expect(parsed.state.normalizedConfig).toBeUndefined();
    expect(parsed.state.sources).toBeUndefined();
    // The fields with no other home must survive, or a degraded mirror would lose the user's theme.
    expect(parsed.state.theme).toBe("dark");
    expect(parsed.state.activeView).toBe("config");
    expect(parsed.version).toBe(0);
  });

  it("returns null for text it cannot understand", () => {
    // A mirror in an unknown shape is left alone rather than replaced with a lossy guess.
    expect(stripPayloadFromPersistedText("not json")).toBeNull();
    expect(stripPayloadFromPersistedText("42")).toBeNull();
    expect(stripPayloadFromPersistedText(JSON.stringify({ state: "nope" }))).toBeNull();
  });

  it("returns null when there is nothing to drop", () => {
    // So the caller can tell "I made it smaller" from "it is already minimal", which decides
    // whether retrying is worth anything.
    expect(
      stripPayloadFromPersistedText(JSON.stringify({ state: { theme: "dark" }, version: 0 })),
    ).toBeNull();
  });
});

describe("the quota-tolerant storage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    useStorage(realLocalStorage);
  });

  it("writes everything when there is room", () => {
    useStorage(createBoundedStorage(1024 * 1024));
    const storage = createQuotaTolerantStorage();
    const text = envelope(1000);

    storage.setItem("k", text);

    expect(localStorage.getItem("k")).toBe(text);
    expect(storage.isDegraded()).toBe(false);
  });

  it("keeps the small fields when the payload does not fit", () => {
    // The reported failure. Before this, the refusal propagated out of `setState` and was reported
    // as "解析成功，但保存失败 ... exceeded the quota" under the title "需要修正配置" — naming a defect
    // in a configuration that had already been saved successfully.
    useStorage(createBoundedStorage(2000));
    const storage = createQuotaTolerantStorage();

    expect(() => storage.setItem("k", envelope(5000))).not.toThrow();

    const stored = JSON.parse(localStorage.getItem("k") as string);
    expect(stored.state.rawConfig).toBeUndefined();
    expect(stored.state.theme).toBe("dark");
    expect(storage.isDegraded()).toBe(true);
  });

  it("does not throw when even the reduced payload is too large", () => {
    // Step 3. There is nothing left to drop, and throwing here would recreate the bug: an operation
    // that already succeeded in the database would be reported as a failure.
    useStorage(createBoundedStorage(10));
    const storage = createQuotaTolerantStorage();

    expect(() => storage.setItem("k", envelope(5000))).not.toThrow();
    expect(storage.isDegraded()).toBe(true);
  });

  it("still throws a failure that is not about space", () => {
    // A real bug must not be swallowed by the quota path, or it would be invisible.
    const hostile = {
      ...createBoundedStorage(1024),
      setItem: () => {
        throw new Error("disk on fire");
      },
    } as Storage;
    useStorage(hostile);

    expect(() => createQuotaTolerantStorage().setItem("k", envelope(10))).toThrow(
      /disk on fire/,
    );
  });

  it("starts from defaults rather than crashing when storage refuses reads", () => {
    const unreadable = {
      ...createBoundedStorage(1024),
      getItem: () => {
        throw new Error("storage disabled");
      },
    } as Storage;
    useStorage(unreadable);

    expect(createQuotaTolerantStorage().getItem("k")).toBeNull();
  });
});

describe("the store's own persist storage", () => {
  afterEach(() => {
    useStorage(realLocalStorage);
  });

  it("survives a full localStorage end to end", () => {
    // The unit tests above exercise the string adapter. This drives the JSON wrapper the store
    // actually uses, because an adapter that is correct but wired up wrongly would pass them all
    // while the user still saw the error.
    useStorage(createBoundedStorage(3000));
    const storage = createAppPersistStorage();
    const value = {
      state: {
        rawConfig: "y".repeat(20000),
        normalizedConfig: "{}",
        sources: [{ key: "a" }],
        theme: "dark",
      },
      version: 0,
    };

    expect(() => storage?.setItem("moseek-app-state", value as never)).not.toThrow();

    const stored = JSON.parse(localStorage.getItem("moseek-app-state") as string);
    expect(stored.state.rawConfig).toBeUndefined();
    expect(stored.state.theme).toBe("dark");
  });

  it("degrades through the REAL store, not only through the adapter", () => {
    // The strongest form of this test: the store's own `setState` is what threw, so that is what is
    // driven. A test that only exercised the adapter would pass even if the store were wired to the
    // default storage, which is exactly the mistake that would leave the user's bug in place.
    useStorage(createBoundedStorage(2500));
    const mirrorKey = "moseek-app-state";

    expect(() =>
      useAppStore.setState({ rawConfig: "z".repeat(30000) }),
    ).not.toThrow();

    const stored = JSON.parse(localStorage.getItem(mirrorKey) as string);
    // The payload was dropped, so the write could succeed at all...
    expect(stored.state.rawConfig).toBeUndefined();
    // ...and the fields with no other home were kept.
    expect(stored.state.activeView).toBeTruthy();
  });
});

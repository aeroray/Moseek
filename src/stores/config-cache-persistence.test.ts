import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import {
  pruneCacheToActive,
  rehydrateCache,
  stripCacheForStorage,
} from "@/stores/config-cache-persistence";
import type { StoredConfigDocument } from "@/lib/tauri";
import type { SourceRecord } from "@/types/moseek";
import { useAppStore } from "@/stores/app-store";

// Measures the persisted payload before and after the fix, against the REAL configuration.
//
// The claim being tested is the one the quota error was about: the stored object must fit in
// localStorage with room to spare, and it must not grow with each save.
const DB = `${process.env.APPDATA}\\com.moseek.desktop\\moseek.sqlite3`;

function realDocument(): StoredConfigDocument {
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db
    .prepare(
      "select id, name, raw_config, normalized_config, sources_json from config_documents where id = (select value from app_settings where key='active_config_document_id')",
    )
    .get() as {
    id: number;
    name: string;
    raw_config: string;
    normalized_config: string;
    sources_json: string;
  };
  const sources = JSON.parse(row.sources_json) as SourceRecord[];
  return {
    id: row.id,
    name: row.name,
    rawConfig: row.raw_config,
    normalizedConfig: row.normalized_config,
    sources,
    sourceCount: sources.length,
    liveCount: sources.filter((source) => source.sourceType === "live").length,
    importedAt: "2026-01-01T00:00:00.000Z",
    sourceBaseUrl: "https://szyyds.cn/tv/x.json",
  };
}

function kb(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") / 1024;
}

describe("the persisted payload", () => {
  it("fits in the quota, and does not grow with each save", () => {
    const document = realDocument();
    const QUOTA_KB = 5120;

    // BEFORE: what the old partialize wrote.
    const before = {
      state: {
        configDocuments: [{ id: document.id, name: document.name, importedAt: document.importedAt }],
        configDocumentCache: { [document.id]: document },
        activeConfigId: document.id,
        sources: document.sources,
        rawConfig: document.rawConfig,
        normalizedConfig: document.normalizedConfig,
      },
      version: 0,
    };
    const beforeKb = kb(before);
    console.log(`\nBEFORE (what the quota error was about)`);
    console.log(`  total            : ${beforeKb.toFixed(0)} KB of ${QUOTA_KB} KB (${((beforeKb / QUOTA_KB) * 100).toFixed(0)}%)`);
    console.log(`  cache alone      : ${kb(before.state.configDocumentCache).toFixed(0)} KB`);

    // Simulate the growth: a second save produces a new id, and the old cache spread kept the first.
    const grown = {
      ...before,
      state: {
        ...before.state,
        configDocumentCache: {
          ...before.state.configDocumentCache,
          [document.id + 1]: document,
        },
      },
    };
    const grownKb = kb(grown);
    console.log(`  after ONE more save: ${grownKb.toFixed(0)} KB (${((grownKb / QUOTA_KB) * 100).toFixed(0)}%) -> over quota: ${grownKb > QUOTA_KB}`);
    expect(grownKb, "the old shape must exceed the quota, or this test proves nothing").toBeGreaterThan(QUOTA_KB);

    // AFTER: what the new partialize writes.
    const after = {
      state: {
        configDocuments: [{ id: document.id, name: document.name, importedAt: document.importedAt }],
        configDocumentCache: pruneCacheToActive(
          stripCacheForStorage({ [document.id]: document }),
          document.id,
        ),
        activeConfigId: document.id,
        sources: document.sources,
        rawConfig: document.rawConfig,
        normalizedConfig: document.normalizedConfig,
      },
      version: 0,
    };
    const afterKb = kb(after);
    console.log(`\nAFTER`);
    console.log(`  total            : ${afterKb.toFixed(0)} KB of ${QUOTA_KB} KB (${((afterKb / QUOTA_KB) * 100).toFixed(0)}%)`);
    console.log(`  cache alone      : ${kb(after.state.configDocumentCache).toFixed(1)} KB`);
    console.log(`  saved            : ${(beforeKb - afterKb).toFixed(0)} KB (${(((beforeKb - afterKb) / beforeKb) * 100).toFixed(0)}%)`);

    // And it does not grow: ten more saves add only bytes.
    const afterTen = {
      ...after,
      state: {
        ...after.state,
        configDocumentCache: pruneCacheToActive(
          stripCacheForStorage(
            Object.fromEntries(
              Array.from({ length: 11 }, (_, index) => [document.id + index, document]),
            ),
          ),
          document.id + 10,
        ),
      },
    };
    const afterTenKb = kb(afterTen);
    console.log(`  after TEN more saves: ${afterTenKb.toFixed(0)} KB -> growth: ${(afterTenKb - afterKb).toFixed(1)} KB`);

    // The assertions.
    expect(afterKb, "the new payload must fit").toBeLessThan(QUOTA_KB);
    expect(afterKb, "and fit with real headroom, not marginally").toBeLessThan(QUOTA_KB * 0.6);
    expect(afterTenKb - afterKb, "ten more saves must not add a document's worth").toBeLessThan(5);
  });

  it("restores the active document's payload after a reload", () => {
    // Stripping is only safe if the payload comes back, or the page loses its base URL and its name.
    const document = realDocument();
    const stripped = pruneCacheToActive(
      stripCacheForStorage({ [document.id]: document }),
      document.id,
    );

    // What was actually written: no text, no sources.
    const written = JSON.stringify(stripped);
    expect(written).not.toContain("rawConfig");
    expect(written).not.toContain("normalizedConfig");
    expect(written).not.toContain('"sources"');

    const restored = rehydrateCache(stripped, {
      activeConfigId: document.id,
      rawConfig: document.rawConfig,
      normalizedConfig: document.normalizedConfig,
      sources: document.sources,
    });

    const active = restored[document.id];
    expect(active.rawConfig).toBe(document.rawConfig);
    expect(active.normalizedConfig).toBe(document.normalizedConfig);
    expect(active.sources).toHaveLength(document.sources.length);
    // And the fields the cache exists for survive.
    expect(active.name).toBe(document.name);
    expect(active.sourceBaseUrl).toBe(document.sourceBaseUrl);
    expect(active.liveCount).toBe(document.liveCount);
  });

  it("rebuilds an active document when the cache has no entry for it", () => {
    // A database written before the cache existed, or one whose entry was pruned: the page must not
    // lose its base URL and name.
    const restored = rehydrateCache(undefined, {
      activeConfigId: 7,
      rawConfig: '{"sites":[]}',
      normalizedConfig: "{}",
      sources: [],
    });
    expect(restored[7]).toBeTruthy();
    expect(restored[7].rawConfig).toBe('{"sites":[]}');
    expect(restored[7].name).toBe("中心配置");
  });

  it("keeps only the active entry", () => {
    const document = realDocument();
    const many = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [index + 1, document]),
    );
    const pruned = pruneCacheToActive(stripCacheForStorage(many), 3);
    expect(Object.keys(pruned)).toEqual(["3"]);
  });

  it("empties the cache when nothing is active", () => {
    const document = realDocument();
    const pruned = pruneCacheToActive(stripCacheForStorage({ 1: document }), null);
    expect(Object.keys(pruned)).toEqual([]);
  });

  it("is what the STORE actually writes", () => {
    // The tests above exercise the helpers, and a helper that is correct but not wired in would pass
    // all of them while the quota error stayed. This drives the real store's own `partialize`, which
    // is the thing that decides what reaches localStorage — mutation-tested by restoring the old
    // `configDocumentCache: state.configDocumentCache` line, which this catches.
    const document = realDocument();
    useAppStore.setState({
      activeConfigId: document.id,
      configDocumentCache: { [document.id]: document },
      rawConfig: document.rawConfig,
      normalizedConfig: document.normalizedConfig,
      sources: document.sources,
    });

    const partialize = useAppStore.persist.getOptions().partialize;
    expect(partialize, "the store must have a partialize").toBeTruthy();
    const persisted = partialize!(useAppStore.getState()) as {
      configDocumentCache?: Record<string, Record<string, unknown>>;
      rawConfig?: string;
    };

    const entry = persisted.configDocumentCache?.[String(document.id)];
    expect(entry, "the active entry must survive").toBeTruthy();
    // The payload is not in the cache.
    expect(entry?.rawConfig).toBeUndefined();
    expect(entry?.normalizedConfig).toBeUndefined();
    expect(entry?.sources).toBeUndefined();
    // The fields the cache exists for are.
    expect(entry?.name).toBe(document.name);
    expect(entry?.sourceBaseUrl).toBe(document.sourceBaseUrl);

    // And only one entry, so a save cannot accumulate another.
    expect(Object.keys(persisted.configDocumentCache ?? {})).toHaveLength(1);

    // The whole persisted object fits with headroom.
    const kb = Buffer.byteLength(JSON.stringify(persisted), "utf8") / 1024;
    console.log(`\nthe store's own partialize writes ${kb.toFixed(0)} KB`);
    expect(kb).toBeLessThan(5120 * 0.6);
  });

  it("puts the active document's payload back through the store's own merge", () => {
    // Reading is the other half: stripped in, restored out. A cache that persisted a stripped entry
    // and never rebuilt it would leave the page without its base URL and name.
    const document = realDocument();
    const persistedState = {
      activeConfigId: document.id,
      configDocumentCache: pruneCacheToActive(
        stripCacheForStorage({ [document.id]: document }),
        document.id,
      ),
      rawConfig: document.rawConfig,
      normalizedConfig: document.normalizedConfig,
      sources: document.sources,
    };

    const merge = useAppStore.persist.getOptions().merge;
    expect(merge, "the store must have a merge").toBeTruthy();
    const merged = merge!(persistedState, useAppStore.getState()) as {
      configDocumentCache?: Record<number, { rawConfig?: string; name?: string }>;
    };

    const active = merged.configDocumentCache?.[document.id];
    expect(active?.rawConfig).toBe(document.rawConfig);
    expect(active?.name).toBe(document.name);
  });
});

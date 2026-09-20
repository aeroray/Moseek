import { describe, expect, it } from "vitest";

import { defaultSourceFilter, clearedSourceFilter } from "@/features/config/source-filter";
import { migrateSourceFilter, useAppStore } from "@/stores/app-store";

describe("the source filter survives a restart", () => {
  it("is written to storage", () => {
    // The whole point of moving it into the store. Validating the migration alone would pass even
    // if the value were never saved, which is the failure the user reported.
    useAppStore.setState({
      sourceFilter: {
        adapters: ["xbpq"],
        executions: ["enabled"],
        statuses: ["usable"],
        enabled: ["on"],
      },
    });

    const raw = localStorage.getItem("moseek-app-state");
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw as string) as {
      state?: { sourceFilter?: unknown };
    };
    expect(persisted.state?.sourceFilter).toEqual({
      adapters: ["xbpq"],
      executions: ["enabled"],
      statuses: ["usable"],
      enabled: ["on"],
    });
  });

  it("is read back rather than replaced by the default", () => {
    // Reading is the other half: a value that is saved but overwritten on load is the same bug.
    const persisted = {
      state: {
        sourceFilter: {
          adapters: [],
          executions: ["blocked"],
          statuses: ["failed"],
          enabled: ["off"],
        },
      },
      version: 0,
    };
    localStorage.setItem("moseek-app-state", JSON.stringify(persisted));

    // The merge is what rehydrate calls, so exercising it directly is the contract under test.
    const merged = useAppStore.persist.getOptions().merge?.(
      persisted.state,
      useAppStore.getState(),
    ) as { sourceFilter?: unknown } | undefined;

    expect(merged?.sourceFilter).toEqual({
      adapters: [],
      executions: ["blocked"],
      statuses: ["failed"],
      enabled: ["off"],
    });
  });
});

describe("a stored source filter", () => {
  it("keeps every group the current version knows", () => {
    const stored = {
      adapters: ["xbpq", "builtin-cms"],
      executions: ["enabled"],
      statuses: ["usable", "failed"],
      enabled: ["on"],
    };
    expect(migrateSourceFilter(stored)).toEqual(stored);
  });

  it("drops a value this version does not know, keeping the rest of the group", () => {
    // A group is a set of known values. An unknown one would match nothing, so keeping it would
    // silently narrow the list with no visible cause.
    const migrated = migrateSourceFilter({
      adapters: ["xbpq", "an-adapter-from-the-future"],
      executions: ["enabled", "also-unknown"],
      statuses: ["usable"],
      enabled: ["on", "sideways"],
    });
    expect(migrated.adapters).toEqual(["xbpq"]);
    expect(migrated.executions).toEqual(["enabled"]);
    expect(migrated.statuses).toEqual(["usable"]);
    expect(migrated.enabled).toEqual(["on"]);
  });

  it("falls back to the default when nothing at all can be read", () => {
    // Not a filter the user set — a value this version cannot interpret. Showing everything is a
    // smaller surprise than showing nothing.
    for (const value of [undefined, null, 42, "enabled", [], { nope: true }]) {
      expect(migrateSourceFilter(value)).toEqual(defaultSourceFilter);
    }
  });

  it("treats an empty group list as a real choice, not as unreadable", () => {
    // `clearedSourceFilter` has four empty groups and means "show everything". It must survive as
    // itself rather than being replaced by the default, which is a filter.
    expect(migrateSourceFilter(clearedSourceFilter)).toEqual(clearedSourceFilter);
    // And a stored object with all four keys present, however empty, is a readable shape.
    expect(
      migrateSourceFilter({ adapters: [], executions: [], statuses: [], enabled: [] }),
    ).toEqual(clearedSourceFilter);
  });

  it("survives a partially written object", () => {
    // Only some groups present: the missing ones are simply not narrowing.
    const migrated = migrateSourceFilter({ executions: ["enabled"] });
    expect(migrated).toEqual({
      adapters: [],
      executions: ["enabled"],
      statuses: [],
      enabled: [],
    });
  });
});

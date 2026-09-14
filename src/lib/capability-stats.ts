import type { CapabilityStatus, SourceRecord } from "@/types/moseek";

export function getCapabilityCounts(sources: SourceRecord[]) {
  return sources.reduce<Record<CapabilityStatus, number>>(
    (counts, source) => {
      counts[source.capability] += 1;
      return counts;
    },
    {
      supported: 0,
      partial: 0,
      "needs-adapter": 0,
      blocked: 0,
      invalid: 0,
    },
  );
}

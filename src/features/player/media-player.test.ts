import { describe, expect, it } from "vitest";

import { getByteRangeHeader } from "@/features/player/media-range";

describe("HLS byte-range requests", () => {
  it("does not send a range for ordinary fragments", () => {
    expect(getByteRangeHeader(0, 0)).toBeUndefined();
    expect(getByteRangeHeader()).toBeUndefined();
  });

  it("converts the exclusive end offset to an HTTP range", () => {
    expect(getByteRangeHeader(1024, 2048)).toBe("bytes=1024-2047");
  });
});

import { describe, expect, it } from "vitest";

import { posterCandidates } from "@/components/poster-candidates";

describe("poster candidates", () => {
  it("drops CDN resize parameters, which are the clearest signal of a thumbnail", () => {
    // A URL carrying an explicit resize directive is requesting a small render of a larger
    // original, so the same address without it is the best guess at the full image.
    const candidates = posterCandidates(
      "https://img.example/a.jpg?x-oss-process=image/resize,w_200",
    );
    expect(candidates[0]).toBe("https://img.example/a.jpg");
    // The original is always present, so a wrong guess cannot make things worse.
    expect(candidates).toContain(
      "https://img.example/a.jpg?x-oss-process=image/resize,w_200",
    );
  });

  it("keeps query parameters that are not about resizing", () => {
    // They may be a signature or cache key the CDN requires; stripping them would break the URL.
    const candidates = posterCandidates(
      "https://img.example/a.jpg?sign=abc&w_=200",
    );
    expect(candidates[0]).toBe("https://img.example/a.jpg?sign=abc");
  });

  it("removes a thumbnail suffix from the file name", () => {
    expect(posterCandidates("https://img.example/poster_thumb.jpg")[0]).toBe(
      "https://img.example/poster.jpg",
    );
    expect(posterCandidates("https://img.example/poster-small.png")[0]).toBe(
      "https://img.example/poster.png",
    );
  });

  it("leaves a title that merely contains those words alone", () => {
    // Only a trailing marker is a size hint; a word in the middle of a name is part of the name.
    expect(posterCandidates("https://img.example/small-town.jpg")[0]).toBe(
      "https://img.example/small-town.jpg",
    );
    expect(posterCandidates("https://img.example/thumbnailer.jpg")[0]).toBe(
      "https://img.example/thumbnailer.jpg",
    );
  });

  it("does not strip a suffix that is the whole file name", () => {
    // Removing it would leave an empty name.
    expect(posterCandidates("https://img.example/thumb.jpg")[0]).toBe(
      "https://img.example/thumb.jpg",
    );
  });

  it("returns the original as the only candidate when nothing can be derived", () => {
    expect(posterCandidates("https://img.example/a.jpg")).toEqual([
      "https://img.example/a.jpg",
    ]);
    expect(posterCandidates("")).toEqual([]);
    expect(posterCandidates("   ")).toEqual([]);
  });

  it("never returns duplicates", () => {
    const candidates = posterCandidates("https://img.example/poster.jpg");
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

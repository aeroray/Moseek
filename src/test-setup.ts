import "@testing-library/jest-dom/vitest";

// jsdom does not implement matchMedia, which Plyr reads while its module is evaluated. Without
// the stub any test that imports the player fails during import rather than in an assertion.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

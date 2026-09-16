import "@testing-library/jest-dom/vitest";

// jsdom leaves `HTMLMediaElement.prototype.load`/`play`/`pause` unimplemented and logs a
// "Not implemented" error every time the player's cleanup runs, which buries real failures in
// noise. They are no-ops here because no test asserts on actual media decoding.
if (typeof window !== "undefined" && window.HTMLMediaElement) {
  window.HTMLMediaElement.prototype.load = () => {};
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = () => {};
}

// jsdom does not implement scrollIntoView, which Radix's Select calls when it highlights the
// selected item on open. Without the stub, opening any Select throws instead of rendering.
if (typeof window !== "undefined" && window.Element) {
  window.Element.prototype.scrollIntoView = () => {};
}

// jsdom does not implement the pointer-capture API, which Radix's Select calls on the trigger
// while opening. Without the stubs the click is still handled, but the failure surfaces later as
// an unhandled error that vitest reports as a failed run even when every assertion passed.
if (typeof window !== "undefined" && window.Element) {
  window.Element.prototype.hasPointerCapture = () => false;
  window.Element.prototype.setPointerCapture = () => {};
  window.Element.prototype.releasePointerCapture = () => {};
}

// jsdom does not implement ResizeObserver, which Radix's ScrollArea constructs as soon as a
// scrollbar is actually mounted (`type="auto"`/`"always"`). Without the stub those scroll
// areas throw during layout instead of being asserted on.
if (typeof window !== "undefined" && !window.ResizeObserver) {
  class ResizeObserverStub implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub;
  globalThis.ResizeObserver = ResizeObserverStub;
}

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

// This jsdom environment exposes no working `localStorage` (Node's own implementation is
// absent without `--localstorage-file`, and the jsdom one is not installed as a global), but
// the zustand `persist` middleware reads it on every `setState`. Without the stub any test
// that touches the app store fails inside the middleware instead of in an assertion.
if (typeof window !== "undefined" && !window.localStorage) {
  const store = new Map<string, string>();
  const localStorageStub: Storage = {
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
      store.set(key, String(value));
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: localStorageStub,
    configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageStub,
    configurable: true,
  });
}

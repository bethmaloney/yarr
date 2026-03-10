import "@testing-library/jest-dom/vitest";

// Polyfill navigator.clipboard for jsdom (not available by default)
if (!navigator.clipboard) {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async () => {},
      readText: async () => "",
    },
    writable: true,
    configurable: true,
  });
}

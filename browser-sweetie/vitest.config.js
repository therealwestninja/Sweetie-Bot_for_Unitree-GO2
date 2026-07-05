// The browser-sweetie tests import the spiking brain from ../../brain (a sibling repo, outside this test
// root). Vite blocks module loads outside the project root by default, so whitelist the D:\Claude workspace
// root. This keeps the brain a single source of truth (no vendored copy) for both Node tests and the browser.
// Plain-object config (no `import "vitest"`) because this folder has no node_modules — the brain supplies vitest.
export default {
  test: { environment: "node", include: ["tests/**/*.test.js"] },
  server: { fs: { allow: ["../.."] } },
};

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Same JSX runtime Next uses (`react-jsx`), so component files can be
  // rendered in the node test environment without importing React by hand.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
  },
});

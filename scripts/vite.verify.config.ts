import path from "node:path";
import { defineConfig } from "vitest/config";

// Runner config for scripts/pdf-rtl-verify.ts: the `@` source alias plus a
// prisma stub (the script renders fabricated models; the sandbox has no
// generated prisma client and no database).
export default defineConfig({
  resolve: {
    alias: [
      { find: "@/lib/prisma", replacement: path.resolve(__dirname, "./prisma-stub.ts") },
      { find: "@", replacement: path.resolve(__dirname, "../src") },
    ],
  },
});

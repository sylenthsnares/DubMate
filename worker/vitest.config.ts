import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.toml",
      },
    }),
  ],
  test: {
    // Only run the Vitest integration tests; the node:test unit suite
    // is run separately via `npm test` (node --experimental-strip-types)
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.test.mjs"],
  },
});

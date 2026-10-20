// SPDX-License-Identifier: AGPL-3.0-only
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
  test: { include: ["test/**/*.test.js"] },
});

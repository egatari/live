// SPDX-License-Identifier: AGPL-3.0-only
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.toml" },
    // Cloudflare's documented always-pass Turnstile test secret; answered locally, no network.
    miniflare: { bindings: { TURNSTILE_SECRET: "1x0000000000000000000000000000000AA" } },
  })],
  test: { include: ["test/**/*.test.js"] },
});

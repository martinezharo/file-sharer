import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Worker tests run inside workerd (via `@cloudflare/vitest-pool-workers`), not
 * Node: `env.DB` is a real D1, `env.FILES` a real R2 and `SELF` the Worker as
 * deployed. Testing against a mock of D1 would only ever prove that the mock
 * behaves like the mock — the interesting logic here lives in SQL (upsert
 * guards, compare-and-swap, cascade deletes), which only a real engine can
 * exercise.
 *
 * Bindings are declared here rather than read from `wrangler.jsonc` on purpose.
 * That file also carries the static-assets binding (the built PWA, which tests
 * neither need nor build) and the edge rate limiters, which have no local
 * implementation. Everything the API actually reads is declared below; `ASSETS`
 * is a stub, and the rate limiters are deliberately left out so `rateLimit()`
 * takes its documented "binding not provisioned" no-op path.
 */
export default defineConfig(async () => {
  const migrationsPath = fileURLToPath(new URL("./migrations", import.meta.url));
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-06-19",
          d1Databases: ["DB"],
          r2Buckets: ["FILES"],
          serviceBindings: {
            ASSETS: () => new Response("static asset", { status: 200 }),
          },
          // Read by the setup file to build the schema before each test file.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["src/**/*.test.ts"],
      setupFiles: ["./src/test/apply-migrations.ts"],
    },
  };
});

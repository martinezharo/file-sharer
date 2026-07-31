import type { Env as WorkerEnv } from "../env";

/**
 * The bindings tests see.
 *
 * `cloudflare:test` types its `env` as `Cloudflare.Env`, which projects using
 * `wrangler types` get generated for them. This Worker declares its bindings by
 * hand (`src/env.ts`) instead, so the two are tied together here: tests get the
 * real binding types, and a binding added to `Env` without being declared in
 * `vitest.config.ts` shows up as a type error rather than as `undefined` at
 * runtime.
 */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Migrations handed to the setup file, which builds the schema from them. */
      TEST_MIGRATIONS: { name: string; queries: string[] }[];
    }
  }
}

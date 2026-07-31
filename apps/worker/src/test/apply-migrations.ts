import { applyD1Migrations, env } from "cloudflare:test";

/**
 * Build the schema from the real `migrations/` directory before any test runs.
 *
 * Using the migrations rather than a hand-written schema is the point: a
 * migration that forgets a column, an index or a CHECK constraint fails the
 * suite here instead of in production, and the tests can never drift from the
 * schema the Worker will actually be deployed against.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

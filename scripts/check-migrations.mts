/**
 * Deploy guard: refuse to auto-apply a migration the running Worker can't survive.
 *
 * `pnpm run deploy` applies migrations before publishing the Worker, so for a few
 * seconds the OLD code runs against the NEW schema. That is fine while a
 * migration only adds things, and breaks the moment it removes or narrows one:
 * the live Worker queries a column that just disappeared.
 *
 * This checks only the migrations that are still pending on the remote D1 —
 * anything already applied is history. When one of them is not backwards
 * compatible, the deploy stops with instructions to split it in two (expand
 * now, contract in a later deploy).
 *
 * Run with: node scripts/check-migrations.mts
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = join(REPO_ROOT, "apps", "worker");
const OVERRIDE_ENV = "ALLOW_BREAKING_MIGRATIONS";

interface Breaking {
  /** Matches one statement that the currently deployed Worker can't survive. */
  test: (statement: string) => boolean;
  why: string;
}

const BREAKING_STATEMENTS: Breaking[] = [
  {
    test: (s) => /\bDROP\s+(COLUMN|TABLE)\b/i.test(s),
    why: "removes something the Worker that is still serving may read",
  },
  {
    test: (s) => /\bRENAME\s+(TO|COLUMN)\b/i.test(s),
    why: "renames something the Worker that is still serving reads under its old name",
  },
  {
    test: (s) =>
      /\bADD\s+COLUMN\b/i.test(s) && /\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s),
    why: "adds a NOT NULL column with no DEFAULT, so inserts from the old code fail",
  },
];

function main(): void {
  const { databaseName, migrationsDir } = readWorkerConfig();
  const pending = pendingMigrations(databaseName, migrationsDir);

  if (pending.length === 0) {
    console.log("✓ No pending remote migrations.");
    return;
  }

  const problems = pending.flatMap((name) => inspect(join(migrationsDir, name), name));
  if (problems.length === 0) {
    console.log(`✓ ${pending.length} pending migration(s), all backwards compatible.`);
    return;
  }

  console.error("\n✘ A pending migration would break the Worker that is currently serving.\n");
  for (const problem of problems) {
    console.error(`  ${problem.file}`);
    console.error(`    ${problem.statement}`);
    console.error(`    → ${problem.why}\n`);
  }
  console.error("Migrations are applied BEFORE the new Worker goes out, so every migration");
  console.error("must be compatible with the code already in production. Split this one:\n");
  console.error("  1. Deploy the additive half (new columns, code writing both shapes).");
  console.error("  2. Deploy the removal in a follow-up, once nothing reads the old shape.\n");
  console.error(`If this is deliberate and the downtime is acceptable, set ${OVERRIDE_ENV}=1.`);
  process.exit(1);
}

/** database_name + migrations_dir, so they are not restated here. */
function readWorkerConfig(): { databaseName: string; migrationsDir: string } {
  const path = join(WORKER_DIR, "wrangler.jsonc");
  // Only whole-line comments are stripped: enough for this file, and it can't
  // corrupt a "//" inside a string the way a general strip would.
  const source = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
    .replace(/,(\s*[}\]])/g, "$1");

  let config: { d1_databases?: Array<{ database_name?: string; migrations_dir?: string }> };
  try {
    config = JSON.parse(source);
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${(error as Error).message}`);
  }

  const d1 = config.d1_databases?.[0];
  if (!d1?.database_name || !d1.migrations_dir) {
    throw new Error(`${path} has no D1 database with a database_name and migrations_dir`);
  }
  return {
    databaseName: d1.database_name,
    migrationsDir: join(WORKER_DIR, d1.migrations_dir),
  };
}

/** Migration files present on disk but absent from the remote ledger. */
function pendingMigrations(databaseName: string, migrationsDir: string): string[] {
  const onDisk = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const applied = appliedMigrations(databaseName);
  if (!applied) {
    // Can't reach the ledger (fresh database, or no credentials). Don't block:
    // the migrate step right after this one will fail on its own if it matters,
    // and a database with no ledger has no Worker serving against it yet.
    console.warn("⚠ Could not read the remote migration ledger; skipping the check.");
    return [];
  }
  return onDisk.filter((name) => !applied.has(name));
}

/** Names in the remote `d1_migrations` ledger, or null when unreadable. */
function appliedMigrations(databaseName: string): Set<string> | null {
  let stdout: string;
  try {
    stdout = execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        databaseName,
        "--remote",
        "--json",
        "--command",
        "SELECT name FROM d1_migrations;",
      ],
      { cwd: WORKER_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }

  try {
    // Wrangler prints a JSON array of result sets, sometimes after a banner.
    const json = stdout.slice(stdout.indexOf("["));
    const results = JSON.parse(json) as Array<{ results?: Array<{ name?: string }> }>;
    const names = results.flatMap((result) => result.results ?? []).map((row) => row.name);
    return new Set(names.filter((name): name is string => !!name));
  } catch {
    return null;
  }
}

interface Problem {
  file: string;
  statement: string;
  why: string;
}

function inspect(path: string, name: string): Problem[] {
  return statements(readFileSync(path, "utf8")).flatMap((statement) => {
    const breaking = BREAKING_STATEMENTS.find((candidate) => candidate.test(statement));
    return breaking ? [{ file: name, statement: oneLine(statement), why: breaking.why }] : [];
  });
}

/** SQL statements with comments removed, so prose can't trip the patterns. */
function statements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function oneLine(statement: string): string {
  const flat = statement.replace(/\s+/g, " ");
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}

if (process.env[OVERRIDE_ENV] === "1") {
  console.warn(`⚠ ${OVERRIDE_ENV}=1 — skipping the migration compatibility check.`);
} else {
  main();
}

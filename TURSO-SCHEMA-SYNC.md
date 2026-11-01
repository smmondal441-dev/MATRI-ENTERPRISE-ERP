# Turso Schema Sync — Root Cause & Fix Runbook

## The two bugs you were seeing

### Bug 1: P2022 "column does not exist" on sync push/pull

```
The column 'damage_source' does not exist in the current database
The column 'bill_allocations' does not exist in the current database
```

### Bug 2: Incomplete data pull (only Oct 28 records loaded)

Sales Ledger showed only a handful of records even though Turso had months of
historical data.

---

## Root cause — both bugs are the same bug

### Why `prisma db push` doesn't touch Turso

Look at `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "sqlite"
  url      = "file:./prisma-dummy.db"   ← hardcoded LOCAL file
}
```

The datasource URL is hardcoded to a **local** SQLite file
(`prisma-dummy.db`). This is intentional and required — Prisma 6.x's
internal migration engine **cannot connect to `libsql://` URLs**. The
`@prisma/adapter-libsql` driver adapter is a **runtime-only** concept:
it lets the Prisma *Client* query Turso, but it does NOT let Prisma's
*CLI migration engine* alter Turso.

So when you run `npm run db:push` (= `prisma db push --accept-data-loss`):

1. Prisma CLI reads `schema.prisma` → sees `file:./prisma-dummy.db`
2. Creates / alters that **local** file with the new columns
   (`damage_source`, `bill_allocations`)
3. Turso remote is **never touched**
4. The Prisma Client (generated from the new schema) expects those columns
   to exist on Turso → P2022 error at runtime

### Why the pull was incomplete

When `GET /api/sync/pull` ran `db.damage.findMany()`, Turso threw P2022
(missing `damage_source` column). The old pull route caught the error,
logged a warning, and returned `[]` for that table. The client received
an empty array and assumed "no damage records on server" — but the
records **were** there, just unreadable.

The same thing happened to `sales` if any column was missing, or to
`collections` when `bill_allocations` was missing. The Oct 28 records
you saw were the ones created **before** the schema change — they were
readable because the old columns existed. Records created after the
schema change were unreadable.

---

## The fix — `scripts/turso-schema-sync.mjs`

This script bypasses Prisma's migration engine entirely. It connects to
Turso via `@libsql/client` (the same low-level driver the adapter uses
at runtime), introspects the actual table/column state, and executes
`ALTER TABLE ADD COLUMN` / `CREATE TABLE IF NOT EXISTS` for anything
that's missing.

**Idempotent** — safe to run multiple times. Only adds what's missing.

### What the script does

1. Loads `.env` then `.env.local` (latter overrides) — no `dotenv` dependency.
2. Validates the URL starts with `libsql://` (rejects `file:...`).
3. Connects to Turso via `@libsql/client` with `intMode: 'bigint'`.
4. Introspects all tables and columns via `sqlite_master` + `PRAGMA table_info`.
5. Compares against the `EXPECTED_SCHEMA` map (the source of truth, derived
   from `schema.prisma`).
6. For each missing table → `CREATE TABLE IF NOT EXISTS`.
7. For each missing column → `ALTER TABLE ADD COLUMN` (with default if the
   column is `NOT NULL`, so existing rows get the default).
8. Verifies the changes by re-introspecting.
9. Reports a clear summary: applied / failed / verified counts.

### Three modes

```bash
# Show what WOULD change (read-only, no writes)
npm run db:diagnose-turso

# Apply changes to Turso
npm run db:push-turso

# (the script also supports --dry-run as an alias for --diagnose)
node scripts/turso-schema-sync.mjs --dry-run
```

---

## Exact steps to fix your Turso database (do this once)

```bash
# 1. Make sure .env.local has your REAL Turso URL (NOT file:...)
#    .env.local should contain:
#    DATABASE_URL=libsql://your-db.turso.io
#    TURSO_AUTH_TOKEN=eyJhbGciOiJF...

# 2. First, DIAGNOSE — see what's missing (read-only, safe to run)
npm run db:diagnose-turso

#    You'll see output like:
#    ➕ "damages.damage_source" (TEXT) → will ADD COLUMN
#    ➕ "damages.customer_id" (INTEGER) → will ADD COLUMN
#    ➕ "collections.bill_allocations" (TEXT) → will ADD COLUMN

# 3. APPLY the schema changes + run the data-cleanup phase in one go
#    (db:push-turso now does BOTH: schema sync + data cleanup)
npm run db:push-turso

#    You'll see:
#    ✅ Added column: damages.damage_source
#    ✅ Added column: damages.customer_id
#    ✅ Added column: collections.bill_allocations
#    ── Phase 5: Data Cleanup ──
#    ✅ sales: 12 row(s) cleaned up
#    ✅ damages: 3 row(s) cleaned up
#    🎉 All schema changes applied successfully to Turso!
#       15 legacy row(s) normalized — Prisma findMany() will now succeed.
#
#    The data-cleanup phase normalizes legacy rows in-place:
#      - created_at / synced_at → valid ISO-8601 UTC 'Z' string
#      - NOT NULL columns with NULL values → filled with sensible defaults
#    So Prisma's strict findMany() succeeds on the next pull without
#    needing the raw-SQL fallback.

# 4. Regenerate the Prisma Client (so it knows about the new columns)
npm run db:generate

# 5. Restart your dev server (so the new Prisma Client is loaded)
#    Stop (Ctrl+C) then:
npm run dev

# 6. Refresh the browser. The boot sequence will call pullFromServer()
#    which now succeeds for ALL tables (no more P2022). All historical
#    data — sales, purchases, collections, damages — will load into
#    IndexedDB and appear in the Sales Ledger, Inventory, etc.
```

### If only data cleanup is needed (schema already synced)

If you've already run `db:push-turso` once and just want to re-run the
data-cleanup phase (e.g. after importing more legacy data):

```bash
npm run db:cleanup-turso
# → runs ONLY the data-cleanup phase, skips schema introspection/apply
```

### Other flags

```bash
npm run db:diagnose-turso          # read-only — show what WOULD change
node scripts/turso-schema-sync.mjs --dry-run     # alias for --diagnose
node scripts/turso-schema-sync.mjs --skip-cleanup # apply schema only, skip data cleanup
node scripts/turso-schema-sync.mjs --cleanup-only # apply data cleanup only, skip schema
```

---

## How to verify the fix worked

### Check 1: Pull route logs

Open your dev server terminal. After refreshing the browser, you should see:

```
[sync/pull] ✓ products: 5 row(s) fetched
[sync/pull] ✓ customers: 4 row(s) fetched
[sync/pull] ✓ purchases: 12 row(s) fetched
[sync/pull] ✓ sales: 47 row(s) fetched          ← was 3 before the fix
[sync/pull] ✓ sale_items: 156 row(s) fetched
[sync/pull] ✓ collections: 23 row(s) fetched
[sync/pull] ✓ distributor_settings: 1 row(s) fetched
[sync/pull] ✓ damages: 8 row(s) fetched
[sync/pull] ✓ purchase_returns: 2 row(s) fetched
[sync/pull] ✓ sales_returns: 1 row(s) fetched
[sync/pull] ── Pull summary ──
[sync/pull] Total: 259 records across 10 tables
[sync/pull] Per-table: { products: 5, customers: 4, ... }
[sync/pull] ✓ All tables queried successfully
```

If you still see `✗ ... FAILED (P2022)`, the schema sync didn't apply —
re-run `npm run db:push-turso`.

### Check 2: Browser console

Open DevTools → Console. After the page loads, you should see:

```
[pullFromServer] Pulled 259 records from server: { products: 5, customers: 4, ... }
```

If you see:

```
[pullFromServer] ⚠️  PARTIAL PULL — 2 table(s) failed due to schema mismatch:
[pullFromServer]   ✗ damages: The column 'damage_source' does not exist...
[pullFromServer] 🔧 FIX: Run `npm run db:push-turso` on the server...
```

→ The schema sync hasn't been applied yet. Run the steps above.

### Check 3: Sales Ledger

Navigate to the Sales Ledger module. You should now see ALL historical
invoices, not just the few from Oct 28.

---

## Why this won't happen again

### The pull route now surfaces failures + recovers via raw SQL

Previously, a P2022 error on one table was silently swallowed — the client
got `[]` and couldn't tell "empty table" from "broken query". The upgraded
pull route (`src/app/api/sync/pull/route.ts`) now:

- **Two-tier safeQuery**: tries Prisma's `findMany()` first. If it throws
  (P2022, deserialization error on legacy rows, or Turbopack-wrapped
  module error), falls back to a raw `SELECT *` via `$queryRawUnsafe`.
  This bypasses Prisma's strict type parser, so 100% of historical rows
  pull into Dexie even if some have invalid dates / NULLs.
- **Full error logging**: the Turbopack module-path prefix is stripped
  from `err.message` so the actual Prisma reason is visible. Logs
  `err.code`, `err.meta`, and the first 4 stack frames — no truncation.
- **Snake_case-aware mappers**: when the raw fallback runs, rows come
  back with snake_case keys (the actual Turso column names) instead of
  Prisma's camelCase. A new `pick(row, 'camelKey', 'snakeKey', default)`
  helper reads EITHER key shape. `safeISO()` / `safeNum()` / `safeStr()`
  defensively coerce legacy values (invalid dates → ISO `Z`, NULLs →
  defaults, BigInt → Number).
- Returns `tableCounts`, `failedTables`, `recoveredTables`, and
  `needsSchemaSync` in the response body so the client knows exactly
  what happened.

The client (`src/lib/services/sync.ts` → `pullFromServer()`) now:

- Reads `needsSchemaSync` + `recoveredTables` from the response.
- Logs which tables failed and which were recovered via raw SQL.
- Carries the diagnostic up to the caller (boot sequence / Settings page).

### The schema-sync script now also cleans up legacy data

`scripts/turso-schema-sync.mjs` has a new **Phase 5: Data Cleanup** that
runs after the schema is applied:

1. **Date normalization**: walks every `created_at` / `synced_at` column
   across all 11 tables. Normalizes invalid timestamps (bare
   `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS` without `T`/`Z`, etc.) to valid
   ISO-8601 UTC `Z` strings. Only updates rows that actually need it.
2. **NULL fill**: walks every NOT NULL column. Fills NULL values with
   sensible defaults (`''` for TEXT, `0` for INTEGER, `0.0` for REAL).
   Uses a single `UPDATE ... WHERE col IS NULL` statement per column.

This means after running `db:push-turso`, Prisma's `findMany()` will
succeed on the next pull WITHOUT needing the raw-SQL fallback. The
fallback is still there as a safety net for any edge cases the cleanup
missed.

### The schema-sync script is idempotent

Run it any time you change `schema.prisma`. It only adds what's missing —
never drops or alters existing columns. Safe to run as part of your deploy
pipeline. The data-cleanup phase is also idempotent (only updates rows
that actually have invalid values).

---

## File summary

| File | Purpose |
|---|---|
| `scripts/turso-schema-sync.mjs` | **UPGRADED** — now includes Phase 5: Data Cleanup (normalizes timestamps + fills NULLs). New flags: `--cleanup-only`, `--skip-cleanup`. Run via `npm run db:push-turso` (schema + cleanup) or `npm run db:cleanup-turso` (cleanup only). |
| `package.json` | Added `db:cleanup-turso` npm script. |
| `src/app/api/sync/pull/route.ts` | **UPGRADED** — two-tier safeQuery with raw SQL fallback, full error logging (Turbopack prefix stripped), snake_case-aware dual-key mappers with safe date/number coercion, `recoveredTables` in response. |
| `src/lib/services/sync.ts` | `pullFromServer()` reads `recoveredTables` + carries it in `PullResult`. |
| `TURSO-SCHEMA-SYNC.md` | This runbook — updated with the new phases + flags. |

---

## TL;DR

```bash
npm run db:diagnose-turso   # see what's missing (read-only)
npm run db:push-turso       # apply schema + run data cleanup (fixes legacy rows)
npm run db:generate          # refresh Prisma Client
npm run dev                  # restart → all data now pulls correctly

# If you already ran db:push-turso and just want to re-clean legacy data:
npm run db:cleanup-turso
```

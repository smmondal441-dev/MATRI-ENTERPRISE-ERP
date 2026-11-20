#!/usr/bin/env node
// ============================================================================
// turso-schema-sync.mjs — Apply Prisma schema changes directly to Turso
// ----------------------------------------------------------------------------
// PROBLEM:
//   `prisma db push` targets the LOCAL `file:./prisma-dummy.db` (from
//   schema.prisma's datasource block) because Prisma 6.x's migration engine
//   does NOT support `libsql://` URLs. The driver adapter is runtime-only —
//   it lets Prisma QUERY Turso, but cannot MIGRATE Turso. So every schema
//   change (damage_source, bill_allocations, etc.) lands in the local dummy
//   file and never reaches the Turso remote. Runtime queries then fail with
//   P2022 "column does not exist".
//
// SOLUTION:
//   This script bypasses Prisma's migration engine entirely. It connects to
//   Turso via @libsql/client (the same low-level driver the adapter uses),
//   introspects the actual table/column state, and executes ALTER TABLE ADD
//   COLUMN / CREATE TABLE IF NOT EXISTS for anything that's missing.
//
//   Idempotent — safe to run multiple times. Only adds what's missing.
//
// USAGE:
//   node scripts/turso-schema-sync.mjs            # apply changes
//   node scripts/turso-schema-sync.mjs --dry-run  # show what WOULD change
//   node scripts/turso-schema-sync.mjs --diagnose # read-only introspection
//
// ENV (loaded from .env then .env.local,后者 overrides):
//   DATABASE_URL=libsql://your-db.turso.io
//   TURSO_AUTH_TOKEN=eyJ... (if your Turso DB requires auth)
// ============================================================================

import { createClient } from '@libsql/client'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

// ----------------------------------------------------------------------------
// Env loader — reads .env first, then .env.local (overrides). Does NOT use
// dotenv (not a dependency). Simple key=value parser.
// ----------------------------------------------------------------------------
function loadEnv() {
  const env = {}
  for (const file of ['.env', '.env.local']) {
    const path = join(PROJECT_ROOT, file)
    if (!existsSync(path)) continue
    const content = readFileSync(path, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      let val = trimmed.slice(eqIdx + 1).trim()
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      // .env.local overrides .env
      env[key] = val
    }
  }
  return env
}

// ----------------------------------------------------------------------------
// Expected schema — derived from prisma/schema.prisma
// ----------------------------------------------------------------------------
// Each table → array of column definitions.
// A column def = { name, sqlType, nullable, default, unique, primaryKey }
//
// SQLite type mapping:
//   BigInt  → INTEGER (64-bit)
//   String  → TEXT
//   Float   → REAL
//   DateTime → TEXT (ISO 8601 string)
//   Boolean → INTEGER (0 / 1)
//
// This is the SOURCE OF TRUTH for what the Turso database should look like.
// Update this array whenever schema.prisma changes, then re-run the script.
// ----------------------------------------------------------------------------

const EXPECTED_SCHEMA = {
  products: [
    { name: 'id', sqlType: 'INTEGER', primaryKey: true, autoincrement: true },
    { name: 'local_id', sqlType: 'INTEGER', nullable: false, unique: true },
    { name: 'sku', sqlType: 'TEXT', nullable: false },
    { name: 'company_name', sqlType: 'TEXT', nullable: false },
    { name: 'name', sqlType: 'TEXT', nullable: false },
    { name: 'category', sqlType: 'TEXT', nullable: true },
    { name: 'hsn_code', sqlType: 'TEXT', nullable: false },
    { name: 'base_unit', sqlType: 'TEXT', nullable: false },
    { name: 'outer_unit', sqlType: 'TEXT', nullable: false },
    { name: 'conversion_factor', sqlType: 'REAL', nullable: false },
    { name: 'pack_size', sqlType: 'TEXT', nullable: true },
    { name: 'purchase_rate_per_outer_unit', sqlType: 'REAL', nullable: false },
    { name: 'purchase_rate_per_piece', sqlType: 'REAL', nullable: false },
    { name: 'selling_rate_per_piece', sqlType: 'REAL', nullable: false },
    { name: 'selling_rate_per_outer_unit', sqlType: 'REAL', nullable: false },
    { name: 'purchase_rate', sqlType: 'REAL', nullable: true },
    { name: 'sales_rate', sqlType: 'REAL', nullable: true },
    { name: 'purchase_rate_per_pcs', sqlType: 'REAL', nullable: true },
    { name: 'sales_rate_per_pcs', sqlType: 'REAL', nullable: true },
    { name: 'gst_percent', sqlType: 'REAL', nullable: false },
    { name: 'opening_stock_pcs', sqlType: 'REAL', nullable: false },
    // ★ Loose Product flag — defaults to 0 (false) for backward compat.
    { name: 'is_loose', sqlType: 'INTEGER', nullable: false, default: '0' },
    // ★ Soft Delete (Recycle Bin) — defaults to 0 (false) for backward compat.
    { name: 'is_deleted', sqlType: 'INTEGER', nullable: false, default: '0' },
    { name: 'created_at', sqlType: 'TEXT', nullable: false },
    { name: 'synced_at', sqlType: 'TEXT', nullable: true },
  ],
  customers: [
    { name: 'id', sqlType: 'INTEGER', primaryKey: true, autoincrement: true },
    { name: 'local_id', sqlType: 'INTEGER', nullable: false, unique: true },
    { name: 'customer_id', sqlType: 'TEXT', nullable: false },
    { name: 'name', sqlType: 'TEXT', nullable: false },
    { name: 'route_area', sqlType: 'TEXT', nullable: false },
    { name: 'phone', sqlType: 'TEXT', nullable: false },
    { name: 'gstin', sqlType: 'TEXT', nullable: true },
    { name: 'opening_balance', sqlType: 'REAL', nullable: false },
    { name: 'bill_number', sqlType: 'TEXT', nullable: true },
    { name: 'is_deleted', sqlType: 'INTEGER', nullable: false, default: '0' },
    { name: 'customer_type', sqlType: 'TEXT', nullable: true },
    { name: 'created_at', sqlType: 'TEXT', nullable: false },
    { name: 'synced_at', sqlType: 'TEXT', nullable: true },
  ],
  purchases: [
    { name: 'id', sqlType: 'INTEGER', primaryKey: true, autoincrement: true },
    { name: 'local_id', sqlType: 'INTEGER', nullable: false, unique: true },
    { name: 'bill_no', sqlType: 'TEXT', nullable: false },
    { name: 'date', sqlType: 'TEXT', nullable: false },
    { name: 'supplier_name', sqlType: 'TEXT', nullable: false },
    { name: 'supplier_gstin', sqlType: 'TEXT', nullable: true },
    { name: 'product_id', sqlType: 'INTEGER', nullable: false },
    { name: 'product_sku', sqlType: 'TEXT', nullable: false },
    { name: 'product_name', sqlType: 'TEXT', nullable: false },
    { name: 'hsn_code', sqlType: 'TEXT', nullable: false },
    { name: 'bag_qty', sqlType: 'REAL', nullable: false },
    { name: 'pcs_qty', sqlType: 'REAL', nullable: false },
    { name: 'total_pcs', sqlType: 'REAL', nullable: false },
    { name: 'purchase_rate', sqlType: 'REAL', nullable: false },
    { name: 'gst_percent', sqlType: 'REAL', nullable: false },
    { name: 'taxable_amount', sqlType: 'REAL', nullable: false },
    { name: 'cgst', sqlType: 'REAL', nullable: false },
    { name: 'sgst', sqlType: 'REAL', nullable: false },
    { name: 'total_amount', sqlType: 'REAL', nullable: false },
    { name: 'mfg_date', sqlType: 'TEXT', nullable: true },
    { name: 'expiry_date', sqlType: 'TEXT', nullable: true },
    { name: 'is_deleted', sqlType: 'INTEGER', nullable: false, default: '0' },
    { name: 'created_at', sqlType: 'TEXT', nullable: false },
    { name: 'synced_at', sqlType: 'TEXT', nullable: true },
  ],
  sales: [
    { name: 'id', sqlType: 'INTEGER', primaryKey: true, autoincrement: true },
    { name: 'local_id', sqlType: 'INTEGER', nullable: false, unique: true },
    { name: 'invoice_no', sqlType: 'TEXT', nullable: false },
    { name: 'date', sqlType: 'TEXT', nullable: false },
    { name: 'customer_id', sqlType: 'INTEGER', nullable: false },
    { name: 'customer_name', sqlType: 'TEXT', nullable: false },
    { name: 'payment_mode', sqlType: 'TEXT', nullable: false },
    { name: 'subtotal', sqlType: 'REAL', nullable: false },
    { name: 'cgst', sqlType: 'REAL', nullable: false },
    { name: 'sgst', sqlType: 'REAL', nullable: false },
    { name: 'total_amount', sqlType: 'REAL', nullable: false },
    { name: 'total_profit', sqlType: 'REAL', nullable: false },
    { name: 'total_margin_percent', sqlType: 'REAL', nullable: false },
    { name: 'paid_amount', sqlType: 'REAL', nullable: false },
    { name: 'is_deleted', sqlType: 'INTEGER', nullable: false, default: '0' },
    { name: 'created_at', sqlType: 'TEXT', nullable: false },
    { name: 'synced_at', sqlType: 'TEXT', nullable: true },
  ],
  sale_items: [
    { name: 'id', sqlType: 'INTEGER', primaryKey: true, autoincrement: true },
    { name: 'local_id', sqlType: 'INTEGER', nullable: false, unique: true },
    { name: 'sale_local_id', sqlType: 'INTEGER', nullable: false },
    { name: 'product_id', sqlType: 'INTEGER', nullable: false },
    { name: 'product_name', sqlType: 'TEXT', nullable: false },
    { name: 'product_sku', sqlType: 'TEXT', nullable: false },
    { name: 'hsn_code', sqlType: 'TEXT', nullable: false },
    { name: 'quantity_pcs', sqlType: 'REAL', nullable: false },
    { name: 'rate', sqlType: 'REAL', nullable: false },
    { name: 'gst_percent', sqlType: 'REAL', nullable: false },
    { name: 'taxable_amount', sqlType: 'REAL', nullable: false },
    { name: 'cgst', sqlType: 'REAL', nullable: false },
    { name: 'sgst', sqlType: 'REAL', nullable: false },
    { name: 'total', sqlType: 'REAL', nullable: false },
    { name: 'purchase_rate', sqlType: 'REAL', nullable: false },
    { name: 'item_profit', sqlType: 'REAL', nullable: false },
    { name: 'item_margin_percent', sqlType: 'REAL', nullable: false },
    { name: 'is_deleted', sqlType: 'INTEGER', nullable: false, default: '0' },
    { name: 'created_at', sqlType: 'TEXT', nullable: false },
    { name: 'synced_at', sqlType: 'TEXT', nullable: true },
  ],
  collections: [
    { name: 'id', sqlType: 'INTEGER', primaryKey: true, autoincrement: true },
    { name: 'local_id', sqlType: 'INTEGER', nullable: false, unique: true },
    { name: 'date', sqlType: 'TEXT', nullable: false },
    { name: 'customer_id', sqlType: 'INTEGER', nullable: false },
    { name: 'customer_name', sqlType: 'TEXT', nullable: false },
    { name: 'amount', sqlType: 'REAL', nullable: false },
    { name: 'payment_mode', sqlType: 'TEXT', nullable: false },
    { name: 'notes', sqlType: 'TEXT', nullable: true },
    // ★ NEW COLUMN — Bill-by-bill allocation (Tally-style "Against Reference")
    { name: 'bill_allocations', sqlType: 'TEXT', nullable: true },
    { name: 'created_at', sqlType: 'TEXT', nullable: false },
    { name: 'synced_at', sqlType: 'TEXT', nullable: true },
  ],
  distributor_settings: [
    { name: 'id', sqlType: 'INTEGER', primaryKey: true, autoincrement: true },
    { name: 'local_id', sqlType: 'INTEGER', nullable: false, unique: true },
    { name: 'store_name', sqlType: 'TEXT', nullable: false },
    { name: 'subtitle', sqlType: 'TEXT', nullable: true },
    { name: 'gstin', sqlType: 'TEXT', nullable: false },
    { name: 'address', sqlType: 'TEXT', nullable: false },
    { name: 'phone', sqlType: 'TEXT', nullable: false },
    { name: 'email', sqlType: 'TEXT', nullable: false },
    { name: 'logo_url', sqlType: 'TEXT', nullable: true },
    { name: 'invoice_prefix', sqlType: 'TEXT', nullable: false },
    { name: 'state', sqlType: 'TEXT', nullable: false },
    { name: 'bank_details', sqlType: 'TEXT', nullable: true },
    { name: 'synced_at', sqlType: 'TEXT', nullable: true },
  ],
  damages: [
    { name: 'id', sqlType: 'INTEGER', primaryKey: true, autoincrement: true },
    { name: 'local_id', sqlType: 'INTEGER', nullable: false, unique: true },
    { name: 'date', sqlType: 'TEXT', nullable: false },
    { name: 'product_id', sqlType: 'INTEGER', nullable: false },
    { name: 'product_sku', sqlType: 'TEXT', nullable: false },
    { name: 'product_name', sqlType: 'TEXT', nullable: false },
    { name: 'hsn_code', sqlType: 'TEXT', nullable: false },
    { name: 'bag_qty', sqlType: 'REAL', nullable: false },
    { name: 'pcs_qty', sqlType: 'REAL', nullable: false },
    { name: 'total_pcs', sqlType: 'REAL', nullable: false },
    { name: 'reason', sqlType: 'TEXT', nullable: false },
    { name: 'notes', sqlType: 'TEXT', nullable: true },
    { name: 'expense_value', sqlType: 'REAL', nullable: false },
    // ★ NEW COLUMN — Damage Source: 'godown' (default) or 'store'
    { name: 'damage_source', sqlType: 'TEXT', nullable: false, default: "'godown'" },
    // ★ NEW COLUMN — Optional customer reference for store-damages
    { name: 'customer_id', sqlType: 'INTEGER', nullable: true },
    // ★ NEW COLUMN — Denormalized customer_name snapshot for fast display
    //    in the Damages log. Nullable so existing rows get NULL on migration.
    { name: 'customer_name', sqlType: 'TEXT', nullable: true },
    // ★ Task 2 NEW COLUMN — Bill-wise damage allocation (sale_id + against_invoice_no)
    { name: 'sale_id', sqlType: 'INTEGER', nullable: true },
    { name: 'against_invoice_no', sqlType: 'TEXT', nullable: true },
    { name: 'created_at', sqlType: 'TEXT', nullable: false },
    { name: 'synced_at', sqlType: 'TEXT', nullable: true },
  ],
  purchase_returns: [
    { name: 'id', sqlType: 'INTEGER', primaryKey: true, autoincrement: true },
    { name: 'local_id', sqlType: 'INTEGER', nullable: false, unique: true },
    { name: 'date', sqlType: 'TEXT', nullable: false },
    { name: 'original_purchase_id', sqlType: 'INTEGER', nullable: true },
    { name: 'return_no', sqlType: 'TEXT', nullable: false },
    { name: 'supplier_name', sqlType: 'TEXT', nullable: false },
    { name: 'supplier_gstin', sqlType: 'TEXT', nullable: true },
    { name: 'product_id', sqlType: 'INTEGER', nullable: false },
    { name: 'product_sku', sqlType: 'TEXT', nullable: false },
    { name: 'product_name', sqlType: 'TEXT', nullable: false },
    { name: 'hsn_code', sqlType: 'TEXT', nullable: false },
    { name: 'bag_qty', sqlType: 'REAL', nullable: false },
    { name: 'pcs_qty', sqlType: 'REAL', nullable: false },
    { name: 'total_pcs', sqlType: 'REAL', nullable: false },
    { name: 'purchase_rate', sqlType: 'REAL', nullable: false },
    { name: 'purchase_rate_per_pcs', sqlType: 'REAL', nullable: false },
    { name: 'gst_percent', sqlType: 'REAL', nullable: false },
    { name: 'taxable_amount', sqlType: 'REAL', nullable: false },
    { name: 'cgst', sqlType: 'REAL', nullable: false },
    { name: 'sgst', sqlType: 'REAL', nullable: false },
    { name: 'total_amount', sqlType: 'REAL', nullable: false },
    { name: 'reason', sqlType: 'TEXT', nullable: true },
    { name: 'created_at', sqlType: 'TEXT', nullable: false },
    { name: 'synced_at', sqlType: 'TEXT', nullable: true },
  ],
  sales_returns: [
    { name: 'id', sqlType: 'INTEGER', primaryKey: true, autoincrement: true },
    { name: 'local_id', sqlType: 'INTEGER', nullable: false, unique: true },
    { name: 'date', sqlType: 'TEXT', nullable: false },
    { name: 'original_sale_id', sqlType: 'INTEGER', nullable: true },
    { name: 'return_no', sqlType: 'TEXT', nullable: false },
    { name: 'customer_id', sqlType: 'INTEGER', nullable: false },
    { name: 'customer_name', sqlType: 'TEXT', nullable: false },
    { name: 'product_id', sqlType: 'INTEGER', nullable: false },
    { name: 'product_sku', sqlType: 'TEXT', nullable: false },
    { name: 'product_name', sqlType: 'TEXT', nullable: false },
    { name: 'hsn_code', sqlType: 'TEXT', nullable: false },
    { name: 'bag_qty', sqlType: 'REAL', nullable: false },
    { name: 'pcs_qty', sqlType: 'REAL', nullable: false },
    { name: 'total_pcs', sqlType: 'REAL', nullable: false },
    { name: 'sales_rate_per_pcs', sqlType: 'REAL', nullable: false },
    { name: 'gst_percent', sqlType: 'REAL', nullable: false },
    { name: 'taxable_amount', sqlType: 'REAL', nullable: false },
    { name: 'cgst', sqlType: 'REAL', nullable: false },
    { name: 'sgst', sqlType: 'REAL', nullable: false },
    { name: 'total_amount', sqlType: 'REAL', nullable: false },
    { name: 'restock', sqlType: 'INTEGER', nullable: false, default: '0' },
    { name: 'reason', sqlType: 'TEXT', nullable: true },
    { name: 'created_at', sqlType: 'TEXT', nullable: false },
    { name: 'synced_at', sqlType: 'TEXT', nullable: true },
  ],
  sync_audit_logs: [
    { name: 'id', sqlType: 'INTEGER', primaryKey: true, autoincrement: true },
    { name: 'event_type', sqlType: 'TEXT', nullable: false },
    { name: 'entity_type', sqlType: 'TEXT', nullable: true },
    { name: 'entity_id', sqlType: 'INTEGER', nullable: true },
    { name: 'record_count', sqlType: 'INTEGER', nullable: true },
    { name: 'status', sqlType: 'TEXT', nullable: false },
    { name: 'message', sqlType: 'TEXT', nullable: true },
    { name: 'created_at', sqlType: 'TEXT', nullable: false },
  ],
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function log(icon, msg) {
  console.log(`  ${icon}  ${msg}`)
}

function warn(icon, msg) {
  console.warn(`  ${icon}  ${msg}`)
}

// Build the column definition string for a CREATE TABLE statement.
function columnDef(col) {
  let parts = [col.name, col.sqlType]
  if (col.primaryKey) {
    parts.push('PRIMARY KEY')
    if (col.autoincrement) parts.push('AUTOINCREMENT')
  }
  if (col.unique && !col.primaryKey) parts.push('UNIQUE')
  if (!col.nullable && !col.primaryKey) parts.push('NOT NULL')
  if (col.default) parts.push(`DEFAULT ${col.default}`)
  return parts.join(' ')
}

// Build the CREATE TABLE IF NOT EXISTS statement.
function createTableSQL(tableName, columns) {
  const cols = columns.map(columnDef).join(',\n  ')
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n  ${cols}\n)`
}

// Build the ALTER TABLE ADD COLUMN statement.
// SQLite ALTER TABLE ADD COLUMN supports: type, nullable, default, but NOT
// PRIMARY KEY or UNIQUE or NOT NULL without default (for existing rows).
function alterAddColumnSQL(tableName, col) {
  let parts = [`ALTER TABLE "${tableName}" ADD COLUMN "${col.name}"`, col.sqlType]
  if (col.default) parts.push(`DEFAULT ${col.default}`)
  // For new nullable columns, no NOT NULL clause (existing rows get NULL).
  // For new NOT NULL columns with a default, add NOT NULL.
  if (!col.nullable && col.default) parts.push('NOT NULL')
  return parts.join(' ')
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const diagnoseOnly = args.includes('--diagnose')
  const skipCleanup = args.includes('--skip-cleanup')
  const cleanupOnly = args.includes('--cleanup-only')

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗')
  console.log('║  Turso Schema Sync — applies Prisma schema changes to Turso remote  ║')
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n')

  // ---- Load env vars ----
  const env = loadEnv()
  const url = env.DATABASE_URL || env.TURSO_DATABASE_URL
  const authToken = env.TURSO_AUTH_TOKEN

  if (!url) {
    console.error('\n❌ ERROR: DATABASE_URL not found in .env / .env.local')
    console.error('   Create a .env.local file with:')
    console.error('   DATABASE_URL=libsql://your-db.turso.io')
    console.error('   TURSO_AUTH_TOKEN=eyJ... (if your DB requires auth)\n')
    process.exit(1)
  }

  if (!url.startsWith('libsql://') && !url.startsWith('http://') && !url.startsWith('https://')) {
    console.error(`\n❌ ERROR: DATABASE_URL is "${url.slice(0, 60)}..."`)
    console.error('   Expected a libsql:// URL pointing to your Turso remote.')
    console.error('   If you see "file:..." here, your .env still has the old local')
    console.error('   SQLite path. Fix .env.local with your Turso URL first.\n')
    process.exit(1)
  }

  // Mask the URL for logging (hide the token if embedded)
  const maskedUrl = url.replace(/:\/\/.*@/, '://***@')
  console.log(`  📡 Connecting to: ${maskedUrl}`)
  console.log(`  🔑 Auth token:   ${authToken ? '✓ present' : '— (none)'}`)
  if (dryRun) console.log('  🏜️  DRY RUN — no changes will be applied\n')
  else if (diagnoseOnly) console.log('  🔍 DIAGNOSE ONLY — read-only introspection\n')
  else console.log('')

  // ---- Connect to Turso via @libsql/client ----
  const client = createClient({
    url,
    authToken: authToken || undefined,
    intMode: 'bigint',
  })

  // ---- Phase 1: Introspect existing schema ----
  console.log('── Phase 1: Introspecting current Turso schema ──────────────────────\n')

  const existingTables = new Set()
  const existingColumns = new Map() // tableName → Set of column names

  // Get all table names
  try {
    const tablesResult = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%' ORDER BY name"
    )
    for (const row of tablesResult.rows) {
      existingTables.add(row.name)
    }
    log('📋', `Found ${existingTables.size} existing table(s): ${[...existingTables].join(', ')}`)
  } catch (e) {
    console.error('\n❌ Failed to introspect tables:', e.message)
    process.exit(1)
  }

  // Get columns for each existing table
  for (const tableName of existingTables) {
    try {
      const colsResult = await client.execute(`PRAGMA table_info("${tableName}")`)
      const cols = new Set()
      for (const row of colsResult.rows) {
        cols.add(row.name)
      }
      existingColumns.set(tableName, cols)
      log('  ', `  ${tableName}: ${cols.size} columns`)
    } catch (e) {
      warn('⚠️', `Failed to introspect ${tableName}: ${e.message}`)
    }
  }

  // ---- Phase 2: Generate change plan ----
  console.log('\n── Phase 2: Comparing against expected schema ──────────────────────\n')

  const tablesToCreate = []
  const columnsToAdd = [] // { table, column, sql }
  const allGood = []

  for (const [tableName, expectedCols] of Object.entries(EXPECTED_SCHEMA)) {
    if (!existingTables.has(tableName)) {
      // Table doesn't exist → CREATE TABLE
      tablesToCreate.push({
        table: tableName,
        sql: createTableSQL(tableName, expectedCols),
      })
      log('🆕', `Table "${tableName}" → will CREATE TABLE (${expectedCols.length} columns)`)
    } else {
      // Table exists → check each expected column
      const actualCols = existingColumns.get(tableName) || new Set()
      for (const col of expectedCols) {
        if (!actualCols.has(col.name)) {
          const sql = alterAddColumnSQL(tableName, col)
          columnsToAdd.push({ table: tableName, column: col.name, sql })
          log('➕', `"${tableName}.${col.name}" (${col.sqlType}) → will ADD COLUMN`)
        }
      }
      // Report what's already correct
      const missing = expectedCols.filter(c => !actualCols.has(c.name))
      if (missing.length === 0) {
        allGood.push(tableName)
      }
    }
  }

  if (allGood.length > 0) {
    log('✅', `${allGood.length} table(s) already up-to-date: ${allGood.join(', ')}`)
  }

  if (tablesToCreate.length === 0 && columnsToAdd.length === 0 && !cleanupOnly) {
    console.log('\n  ✨ All tables and columns are already in sync with schema.prisma.')
    console.log('     Nothing to do. Your Turso database is healthy.\n')
    process.exit(0)
  }

  // ---- Phase 3: Show plan (dry-run stops here) ----
  // --cleanup-only skips the schema plan + apply phases entirely and jumps
  // straight to the data-cleanup phase at the end.
  if (cleanupOnly) {
    console.log('\n  🧹 Cleanup-only mode — skipping schema phases, jumping to data cleanup.\n')
  } else {
    console.log(`\n── Plan: ${tablesToCreate.length} CREATE TABLE + ${columnsToAdd.length} ADD COLUMN ────\n`)
  }

  if (diagnoseOnly) {
    console.log('  🔍 Diagnose mode — showing SQL that WOULD be executed:\n')
    for (const t of tablesToCreate) {
      console.log(`  ── CREATE TABLE: ${t.table} ──`)
      console.log(`  ${t.sql};`)
      console.log()
    }
    for (const c of columnsToAdd) {
      console.log(`  ── ADD COLUMN: ${c.table}.${c.column} ──`)
      console.log(`  ${c.sql};`)
      console.log()
    }
    console.log('  No changes applied (diagnose mode). Re-run without --diagnose to apply.\n')
    process.exit(0)
  }

  if (dryRun) {
    console.log('  🏜️  Dry run — showing SQL that WOULD be executed:\n')
    for (const t of tablesToCreate) {
      console.log(`  ${t.sql};`)
      console.log()
    }
    for (const c of columnsToAdd) {
      console.log(`  ${c.sql};`)
    }
    console.log('\n  No changes applied (dry run). Re-run without --dry-run to apply.\n')
    process.exit(0)
  }

  // ---- Phase 4: Execute changes (skipped in --cleanup-only mode) ----
  let successCount = 0
  let failCount = 0

  if (cleanupOnly) {
    console.log('── Phase 3: Apply schema (skipped — cleanup-only mode) ─────────────\n')
  } else {
    console.log('── Phase 3: Applying changes to Turso ───────────────────────────────\n')

    // CREATE TABLE statements
    for (const t of tablesToCreate) {
      try {
        await client.execute(t.sql)
        log('✅', `Created table: ${t.table}`)
        successCount++
      } catch (e) {
        warn('❌', `Failed to create table ${t.table}: ${e.message}`)
        failCount++
      }
    }

    // ALTER TABLE ADD COLUMN statements
    for (const c of columnsToAdd) {
      try {
        await client.execute(c.sql)
        log('✅', `Added column: ${c.table}.${c.column}`)
        successCount++
      } catch (e) {
        // If the column already exists (e.g., from a previous partial run),
        // SQLite returns "duplicate column name" — treat as non-fatal.
        if (e.message.includes('duplicate column name') || e.message.includes('already exists')) {
          log('ℹ️', `Column already exists (skipped): ${c.table}.${c.column}`)
        } else {
          warn('❌', `Failed to add column ${c.table}.${c.column}: ${e.message}`)
          failCount++
        }
      }
    }
  }

  // ---- Phase 5: Verify ----
  console.log('\n── Phase 4: Verification ───────────────────────────────────────────\n')

  let verifiedCount = 0
  for (const [tableName, expectedCols] of Object.entries(EXPECTED_SCHEMA)) {
    try {
      const colsResult = await client.execute(`PRAGMA table_info("${tableName}")`)
      const actualCols = new Set()
      for (const row of colsResult.rows) {
        actualCols.add(row.name)
      }
      const missing = expectedCols.filter(c => !actualCols.has(c.name))
      if (missing.length === 0) {
        log('✅', `${tableName}: ${actualCols.size} columns verified`)
        verifiedCount++
      } else {
        warn('⚠️', `${tableName}: still missing ${missing.length} column(s): ${missing.map(m => m.name).join(', ')}`)
      }
    } catch (e) {
      warn('⚠️', `Verification failed for ${tableName}: ${e.message}`)
    }
  }

  // ---- Phase 6: Data Cleanup (timestamps + NULLs) ----
  // After the schema is in place, walk every table and normalize legacy
  // data so Prisma's strict findMany() succeeds on the next pull:
  //   1. created_at / synced_at → valid ISO-8601 UTC 'Z' string (or NULL for synced_at)
  //   2. NOT NULL columns with NULL values → fill with sensible defaults
  //
  // This is the second half of the "incomplete pull" fix. Even after the
  // schema columns exist, Prisma can still choke on rows that have invalid
  // date strings (e.g. "2024-10-28" without time, "2024-10-28 14:30:00"
  // without 'T'/'Z') or NULLs in NOT NULL columns (from a botched import).
  // The cleanup phase fixes those rows in-place so the pull route's Prisma
  // query succeeds without needing the raw-SQL fallback.
  //
  // Skip when: --skip-cleanup, --dry-run, or --diagnose (read-only modes).
  // Run ONLY cleanup when: --cleanup-only (skip schema phases).
  let cleanupFixedCount = 0
  let cleanupFailCount = 0

  if (skipCleanup || dryRun || diagnoseOnly) {
    if (!cleanupOnly) {
      console.log('\n── Phase 5: Data Cleanup (skipped) ────────────────────────────────\n')
      console.log('  ℹ️  Skipping data cleanup (--skip-cleanup / --dry-run / --diagnose mode).')
      console.log('     Re-run without the flag to also normalize timestamps + fill NULLs.')
    }
  } else {
    console.log('\n── Phase 5: Data Cleanup — normalizing timestamps + filling NULLs ──\n')

    // Map of column → default value to use when filling NULLs in NOT NULL columns.
    // Typed per SQLite column type. These defaults match what the Prisma Client
    // would write for a fresh row, so legacy rows become indistinguishable.
    const NULL_DEFAULTS = {
      // Strings → empty string (safe for most non-empty-constraint columns)
      TEXT: "''",
      // Integers / BigInt → 0
      INTEGER: '0',
      // Reals / Floats → 0.0
      REAL: '0.0',
    }

    // Helper: normalize a date string to ISO-8601 UTC 'Z'. Returns the original
    // string if it's already valid, so we only UPDATE rows that actually need it.
    function normalizeDate(val) {
      if (val == null || val === '') return null
      const str = String(val).trim()
      if (!str) return null
      // Already a valid ISO string with 'Z'?
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(str)) return str
      // Try parsing
      let d = new Date(str)
      if (isNaN(d.getTime())) {
        // Try bare YYYY-MM-DD → UTC midnight
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
          d = new Date(str + 'T00:00:00.000Z')
        }
        // Try "YYYY-MM-DD HH:MM:SS" → replace space with 'T'
        else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(str)) {
          d = new Date(str.replace(' ', 'T'))
        }
      }
      if (!isNaN(d.getTime())) return d.toISOString()
      return null // can't parse — leave alone, raw fallback in pull route handles it
    }

    for (const [tableName, expectedCols] of Object.entries(EXPECTED_SCHEMA)) {
      // Find the date columns + NOT NULL columns for this table.
      const dateCols = expectedCols.filter(
        (c) => c.name === 'created_at' || c.name === 'synced_at'
      )
      const notNullCols = expectedCols.filter(
        (c) => !c.nullable && !c.primaryKey && c.name !== 'created_at' && c.name !== 'synced_at'
      )

      if (dateCols.length === 0 && notNullCols.length === 0) {
        continue // nothing to clean up on this table
      }

      let tableFixed = 0
      let tableFailed = 0

      // ---- Fix 1: normalize date columns ----
      for (const col of dateCols) {
        try {
          // Fetch all rows with this column so we can inspect + UPDATE individually.
          // (SQLite doesn't support UPDATE...FROM with a CASE on the same table in
          // a single statement, so we do it row by row. For large tables this is
          // slower but safe. The typical FMCG ERP table has <10k rows.)
          const selectSql = `SELECT id, "${col.name}" AS val FROM "${tableName}" WHERE "${col.name}" IS NOT NULL AND "${col.name}" != ''`
          const rows = await client.execute(selectSql)
          for (const row of rows.rows) {
            const original = row.val
            const normalized = normalizeDate(original)
            if (normalized && normalized !== String(original)) {
              try {
                await client.execute({
                  sql: `UPDATE "${tableName}" SET "${col.name}" = ? WHERE id = ?`,
                  args: [normalized, row.id],
                })
                tableFixed++
              } catch (e) {
                tableFailed++
                // Don't spam the log — just count + warn at the end.
              }
            }
          }
        } catch (e) {
          warn('⚠️', `${tableName}.${col.name}: date cleanup failed: ${e.message}`)
        }
      }

      // ---- Fix 2: fill NULLs in NOT NULL columns ----
      for (const col of notNullCols) {
        const defaultVal = NULL_DEFAULTS[col.sqlType]
        if (!defaultVal) continue // no default for this type
        try {
          // Single UPDATE statement — set NULL rows to the default.
          const sql = `UPDATE "${tableName}" SET "${col.name}" = ${defaultVal} WHERE "${col.name}" IS NULL`
          const result = await client.execute(sql)
          if (result.rowsAffected > 0) {
            tableFixed += result.rowsAffected
            log('🔧', `${tableName}.${col.name}: filled ${result.rowsAffected} NULL row(s) with default (${defaultVal})`)
          }
        } catch (e) {
          warn('⚠️', `${tableName}.${col.name}: NULL fill failed: ${e.message}`)
          tableFailed++
        }
      }

      if (tableFixed > 0) {
        log('✅', `${tableName}: ${tableFixed} row(s) cleaned up`)
      }
      cleanupFixedCount += tableFixed
      cleanupFailCount += tableFailed
    }

    if (cleanupFixedCount === 0 && cleanupFailCount === 0) {
      log('✨', 'No data cleanup needed — all timestamps + NOT NULL columns are already valid.')
    } else {
      console.log(`\n  📊 Cleanup: ${cleanupFixedCount} row(s) fixed, ${cleanupFailCount} failure(s)`)
    }
  }

  // ---- Summary ----
  console.log('\n══════════════════════════════════════════════════════════════════════')
  console.log(`  ✅ Applied: ${successCount}  |  ❌ Failed: ${failCount}  |  ✅ Verified: ${verifiedCount}/${Object.keys(EXPECTED_SCHEMA).length} tables`)
  if (!skipCleanup && !dryRun && !diagnoseOnly) {
    console.log(`  📊 Cleanup: ${cleanupFixedCount} row(s) fixed  |  ❌ Cleanup failures: ${cleanupFailCount}`)
  }
  if (failCount > 0) {
    console.log('  ⚠️  Some operations failed. Check the errors above and re-run.')
  } else if (cleanupFailCount > 0) {
    console.log('  ⚠️  Schema applied OK, but some cleanup operations failed. Re-run to retry.')
  } else {
    console.log('  🎉 All schema changes applied successfully to Turso!')
    console.log('     Sync push/pull will now work without P2022 errors.')
    if (!skipCleanup && !dryRun && !diagnoseOnly && cleanupFixedCount > 0) {
      console.log(`     ${cleanupFixedCount} legacy row(s) normalized — Prisma findMany() will now succeed.`)
    }
  }
  console.log('══════════════════════════════════════════════════════════════════════\n')

  client.close()
  process.exit(failCount > 0 || cleanupFailCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('\n💥 Fatal error:', e)
  process.exit(1)
})

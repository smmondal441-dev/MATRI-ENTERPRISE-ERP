// ============================================================================
// GET /api/sync/pull
// ----------------------------------------------------------------------------
// Fetches ALL active records from CockroachDB / PostgreSQL via Prisma and
// returns them as a single JSON payload. Used by new devices to pull existing
// data on first launch (instead of injecting mock seed data).
//
// Response shape mirrors the BackupService.export() format:
//   {
//     "ok": true,
//     "pulledAt": "2026-10-22T...",
//     "data": {
//       "products": [{ id, sku, company_name, ... }],
//       "customers": [{ id, customer_id, name, ... }],
//       "sales": [...],
//       "sale_items": [...],
//       "purchases": [...],
//       "collections": [...],
//       "distributor_settings": [...],
//       "damages": [...],
//       "purchase_returns": [...],
//       "sales_returns": [...]
//     }
//   }
//
// The `id` field in each record is the server's `localId` column (the original
// client-side Dexie ID). This lets the pulling device store records with the
// same ID so future pushes match correctly via `where: { localId }`.
//
// If the database is unreachable, returns 503 with a clear hint.
// ============================================================================

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// ----------------------------------------------------------------------------
// BigInt-safe JSON serialization helper
// ----------------------------------------------------------------------------
// With Turso's intMode: 'bigint', ALL integer columns (both Int and BigInt)
// are returned as native BigInt. JSON.stringify cannot serialize BigInt.
// This replacer converts any BigInt to a number (for Int fields like localId)
// or string (for BigInt id fields that may exceed Number.MAX_SAFE_INTEGER).
// ----------------------------------------------------------------------------

function bigIntReplacer(_key: string, value: any): any {
  if (typeof value === 'bigint') {
    // If the BigInt fits in a safe number range, convert to number.
    // Otherwise convert to string to prevent precision loss.
    if (value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER) {
      return Number(value)
    }
    return value.toString()
  }
  return value
}

// Helper: safely convert BigInt or string to number for Dexie ID fields
function toNum(val: any, fallback = 0): number {
  if (typeof val === 'bigint') return Number(val)
  if (val === null || val === undefined) return fallback
  const n = Number(val)
  return isNaN(n) ? fallback : n
}

// Helper: safely convert BigInt or string to number, returning undefined if null
function toNumOpt(val: any): number | undefined {
  if (val === null || val === undefined) return undefined
  if (typeof val === 'bigint') return Number(val)
  const n = Number(val)
  return isNaN(n) ? undefined : n
}

// Change 2 — normalize business date strings to YYYY-MM-DD (10 chars). The
// Prisma schema stores `date`, `mfg_date`, `expiry_date` as String columns.
// If a row was written via some legacy path with a full ISO timestamp, this
// slices it back to the calendar date so IST day-shift never occurs on the
// pulling device.
function isoDateOnly(val: any): string {
  if (val === null || val === undefined || val === '') return ''
  return String(val).slice(0, 10)
}

function isoDateOnlyOrUndef(val: any): string | undefined {
  if (val === null || val === undefined || val === '') return undefined
  return String(val).slice(0, 10)
}

// Bill-by-bill allocations: stored as JSON string in the `bill_allocations`
// column. Parse safely — any malformed / non-array value yields undefined
// (treated as a legacy lump-sum collection by the client UI).
function parseBillAllocations(val: any): any[] | undefined {
  if (val === null || val === undefined || val === '') return undefined
  if (Array.isArray(val)) return val // already parsed (e.g. from a fresh push echo)
  try {
    const parsed = JSON.parse(String(val))
    if (!Array.isArray(parsed)) return undefined
    return parsed.map((a: any) => ({
      sale_id: toNum(a.sale_id),
      invoice_no: String(a.invoice_no ?? ''),
      amount: Number(a.amount ?? 0),
    }))
  } catch {
    return undefined
  }
}

// ----------------------------------------------------------------------------
// Dual-key + safe-coercion helpers (raw SQL fallback support)
// ----------------------------------------------------------------------------
// When Prisma's findMany() fails (P2022, deserialization error on legacy rows,
// or Turbopack-wrapped module error), the safeQuery wrapper falls back to a
// raw `SELECT *` via $queryRawUnsafe. Raw rows come back with snake_case keys
// (the actual Turso column names: `local_id`, `created_at`, etc.) instead of
// Prisma's camelCase keys (`localId`, `createdAt`, etc.).
//
// These helpers let every map* function read EITHER key shape with safe
// defaults for nulls / invalid dates / missing columns — so 100% of
// historical rows pull into Dexie even if Prisma's strict parser chokes.
// ----------------------------------------------------------------------------

/**
 * Read a value from a row using EITHER the camelCase key (Prisma) or the
 * snake_case key (raw SQL). Falls back to a default if neither is present.
 *
 * Example: `pick(row, 'localId', 'local_id', 0)` → returns row.localId
 * (Prisma) OR row.local_id (raw) OR 0 (missing).
 */
function pick<T = any>(
  row: any,
  camelKey: string,
  snakeKey: string,
  fallback?: T
): T {
  if (row == null) return fallback as T
  if (row[camelKey] !== undefined && row[camelKey] !== null) {
    return row[camelKey] as T
  }
  if (row[snakeKey] !== undefined && row[snakeKey] !== null) {
    return row[snakeKey] as T
  }
  return fallback as T
}

/**
 * Coerce any value to a valid ISO-8601 UTC 'Z' string.
 * Handles:
 *   - Date objects → .toISOString()
 *   - Valid ISO strings → re-stamped via new Date(...).toISOString()
 *   - Bare YYYY-MM-DD → treated as UTC midnight
 *   - Invalid / null / empty → fallback (default: now)
 *
 * This is critical because legacy Turso rows may have created_at values that
 * Prisma's strict DateTime parser rejects (e.g. "2024-10-28" without time, or
 * "2024-10-28 14:30:00" without 'T' / 'Z', or null in a NOT NULL column).
 */
function safeISO(val: any, fallback: Date = new Date()): string {
  if (val == null || val === '') return fallback.toISOString()
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? fallback.toISOString() : val.toISOString()
  }
  const str = String(val).trim()
  if (!str) return fallback.toISOString()
  // Try parsing as-is first
  const d1 = new Date(str)
  if (!isNaN(d1.getTime())) return d1.toISOString()
  // Try treating bare YYYY-MM-DD as UTC midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d2 = new Date(str + 'T00:00:00.000Z')
    if (!isNaN(d2.getTime())) return d2.toISOString()
  }
  // Try replacing space with 'T' (some DBs store "YYYY-MM-DD HH:MM:SS")
  const d3 = new Date(str.replace(' ', 'T'))
  if (!isNaN(d3.getTime())) return d3.toISOString()
  // Last resort — use the fallback so the row still pulls (better than
  // dropping the entire record because of one bad date).
  return fallback.toISOString()
}

/**
 * Nullable variant — returns null if the value is missing/invalid, instead
 * of falling back to "now". Used for `synced_at` which is genuinely nullable.
 */
function safeISONullable(val: any): string | null {
  if (val == null || val === '') return null
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : val.toISOString()
  }
  const str = String(val).trim()
  if (!str) return null
  const d1 = new Date(str)
  if (!isNaN(d1.getTime())) return d1.toISOString()
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d2 = new Date(str + 'T00:00:00.000Z')
    if (!isNaN(d2.getTime())) return d2.toISOString()
  }
  const d3 = new Date(str.replace(' ', 'T'))
  if (!isNaN(d3.getTime())) return d3.toISOString()
  return null
}

/**
 * Coerce any value to a number with a safe default. Handles BigInt (from
 * libSQL intMode:'bigint'), strings, null, undefined.
 */
function safeNum(val: any, fallback = 0): number {
  if (val == null) return fallback
  if (typeof val === 'bigint') return Number(val)
  if (typeof val === 'number') return isNaN(val) ? fallback : val
  const n = Number(val)
  return isNaN(n) ? fallback : n
}

/**
 * Coerce any value to a string with a safe default.
 */
function safeStr(val: any, fallback = ''): string {
  if (val == null) return fallback
  return String(val)
}

/**
 * Coerce to string or null (for nullable string columns).
 */
function safeStrNull(val: any): string | null {
  if (val == null || val === '') return null
  return String(val)
}

export async function GET() {
  // ---- Query all tables from Turso ----
  // Two-tier strategy:
  //   1. Try Prisma's typed findMany() first — fast + type-safe.
  //   2. If Prisma throws (P2022 missing column, OR a deserialization error
  //      on legacy rows with invalid dates / NULLs in NOT NULL columns,
  //      OR a Turbopack-wrapped module error), fall back to a raw SQL
  //      `SELECT *` via $queryRawUnsafe. The raw rows come back in
  //      snake_case (the actual Turso column names) and are mapped with
  //      defensive coercion so 100% of historical rows pull into Dexie.
  //
  // This guarantees that even if Prisma's strict parser chokes on a single
  // bad row, the entire table still pulls — no more silent partial data.
  let products: any[] = []
  let customers: any[] = []
  let purchases: any[] = []
  let sales: any[] = []
  let saleItems: any[] = []
  let collections: any[] = []
  let distributorSettings: any[] = []
  let damages: any[] = []
  let purchaseReturns: any[] = []
  let salesReturns: any[] = []

  // Track per-table success/failure + recovery so the response body can
  // surface exactly what happened (Prisma OK / Prisma failed + raw recovered /
  // both failed).
  const tableStatus: Record<
    string,
    {
      ok: boolean
      count: number
      recovered?: boolean
      viaRaw?: boolean
      error?: string
      rawError?: string
    }
  > = {}

  /**
   * Strip the Turbopack/webpack module-path prefix that Next.js wraps around
   * errors thrown inside API route handlers. The actual Prisma error reason
   * is buried AFTER the long `__TURBOPACK__imported_module__...` prefix.
   *
   * Example input:
   *   "Invalid ()=>__TURBOPACK__imported_module__$5b$project$5d$2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript__.$3d$... PrismaClientKnownRequestError: ..."
   * Example output:
   *   "PrismaClientKnownRequestError: ..."
   */
  function stripTurbopackPrefix(msg: string): string {
    if (!msg) return String(msg)
    // Match everything up to and including the closing `__.$3d$` or `__.$3c$`
    // marker that ends the Turbopack module-path prefix.
    const patterns = [
      /^.*?__TURBOPACK__imported_module__[^\s]*?__\.$3d\$\s*/,
      /^.*?__TURBOPACK__imported_module__[^\s]*?__\.$3c\$\s*/,
      /^.*?__TURBOPACK__imported_module__[^\s]*?\s+/, // generic fallback
    ]
    let out = msg
    for (const p of patterns) {
      const stripped = out.replace(p, '')
      if (stripped.length < out.length) {
        out = stripped
        break
      }
    }
    return out.trim()
  }

  /**
   * Two-tier safe query: Prisma first, raw SQL fallback second.
   * Logs the FULL error (no truncation) to the server console so the actual
   * Prisma error reason is visible — not just the Turbopack prefix.
   */
  async function safeQuery(
    tableName: string,
    prismaQuery: () => Promise<any[]>,
    rawFallback?: () => Promise<any[]>
  ): Promise<any[]> {
    try {
      const rows = await prismaQuery()
      tableStatus[tableName] = { ok: true, count: rows.length }
      console.log(
        `[sync/pull] ✓ ${tableName}: ${rows.length} row(s) fetched (Prisma)`
      )
      return rows
    } catch (e: any) {
      // ---- FULL error logging (no truncation) ----
      // The previous version sliced err.message, which chopped off the actual
      // Prisma reason when Turbopack wrapped the error. Now we log:
      //   - The raw err.message (so Turbopack prefix is visible if present)
      //   - The stripped message (the actual Prisma reason)
      //   - err.code / err.meta (Prisma's structured error fields)
      //   - The first few stack frames (for locating the throw site)
      const rawMsg = e?.message ?? String(e)
      const cleanMsg = stripTurbopackPrefix(rawMsg)
      const code = e?.code
      const meta = e?.meta
      console.error(`[sync/pull] ✗ ${tableName} Prisma findMany() FAILED:`)
      console.error(`[sync/pull]   code:    ${code ?? '(none)'}`)
      console.error(`[sync/pull]   message: ${cleanMsg}`)
      if (rawMsg !== cleanMsg) {
        console.error(`[sync/pull]   (raw msg was ${rawMsg.length} chars; ` +
          `stripped ${rawMsg.length - cleanMsg.length} chars of Turbopack prefix)`)
      }
      if (meta) {
        console.error(`[sync/pull]   meta:   `, JSON.stringify(meta).slice(0, 500))
      }
      if (e?.stack) {
        const frames = e.stack.split('\n').slice(0, 4).join('\n  ')
        console.error(`[sync/pull]   stack:  ${frames}`)
      }

      // ---- Raw SQL fallback ----
      // If the caller provided a rawFallback, try it now. The raw query
      // bypasses Prisma's strict type parser, so legacy rows with invalid
      // dates / NULLs / weird number formats still come through. We tag each
      // row with __viaRaw = true so the mapper functions know to read
      // snake_case keys (the actual Turso column names) instead of camelCase.
      if (rawFallback) {
        try {
          const rawRows = await rawFallback()
          for (const r of rawRows) {
            r.__viaRaw = true
          }
          tableStatus[tableName] = {
            ok: true,
            count: rawRows.length,
            recovered: true,
            viaRaw: true,
            error: cleanMsg,
          }
          console.warn(
            `[sync/pull] ⚠️  ${tableName}: Prisma failed, recovered ${rawRows.length} row(s) via raw SQL SELECT *`
          )
          return rawRows
        } catch (rawE: any) {
          const rawErrMsg = stripTurbopackPrefix(rawE?.message ?? String(rawE))
          console.error(
            `[sync/pull] ✗ ${tableName} raw fallback ALSO failed: ${rawErrMsg}`
          )
          tableStatus[tableName] = {
            ok: false,
            count: 0,
            error: cleanMsg,
            rawError: rawErrMsg,
          }
          return []
        }
      }

      // No raw fallback provided — just record the failure.
      tableStatus[tableName] = { ok: false, count: 0, error: cleanMsg }
      return []
    }
  }

  // Helper: build a raw SQL fallback for a given table name.
  // Returns a function that runs `SELECT * FROM "<table>"` via
  // $queryRawUnsafe. Column names come back in snake_case (the actual
  // Turso column names), which the map* functions below handle via __viaRaw.
  const rawSelect = (tableName: string) => async (): Promise<any[]> => {
    // Quote the table name to handle reserved words / case sensitivity.
    // $queryRawUnsafe parameterizes the SQL string safely.
    return (await db.$queryRawUnsafe(
      `SELECT * FROM "${tableName}"`
    )) as any[]
  }

  products = await safeQuery(
    'products',
    () => db.product.findMany(),
    rawSelect('products')
  )
  customers = await safeQuery(
    'customers',
    () => db.customer.findMany(),
    rawSelect('customers')
  )
  purchases = await safeQuery(
    'purchases',
    () => db.purchase.findMany(),
    rawSelect('purchases')
  )
  sales = await safeQuery(
    'sales',
    () => db.sale.findMany(),
    rawSelect('sales')
  )
  saleItems = await safeQuery(
    'sale_items',
    () => db.saleItem.findMany(),
    rawSelect('sale_items')
  )
  collections = await safeQuery(
    'collections',
    () => db.collection.findMany(),
    rawSelect('collections')
  )
  distributorSettings = await safeQuery(
    'distributor_settings',
    () => db.distributorSetting.findMany(),
    rawSelect('distributor_settings')
  )
  damages = await safeQuery(
    'damages',
    () => db.damage.findMany(),
    rawSelect('damages')
  )
  purchaseReturns = await safeQuery(
    'purchase_returns',
    () => db.purchaseReturn.findMany(),
    rawSelect('purchase_returns')
  )
  salesReturns = await safeQuery(
    'sales_returns',
    () => db.salesReturn.findMany(),
    rawSelect('sales_returns')
  )

  // ---- Map server records back to client-side field names ----
  // The server uses camelCase (Prisma convention) with `localId`.
  // The client uses snake_case (Dexie convention) with `id`.
  // We convert back so the client can directly `bulkPut` into IndexedDB.

  const mapProduct = (p: any) => ({
    id: toNum(pick(p, 'localId', 'local_id', 0)),
    sku: safeStr(pick(p, 'sku', 'sku', '')),
    company_name: safeStr(pick(p, 'companyName', 'company_name', '')),
    name: safeStr(pick(p, 'name', 'name', '')),
    category: safeStrNull(pick(p, 'category', 'category', null)) ?? undefined,
    hsn_code: safeStr(pick(p, 'hsnCode', 'hsn_code', '')),
    base_unit: safeStr(pick(p, 'baseUnit', 'base_unit', 'Pcs')),
    outer_unit: safeStr(pick(p, 'outerUnit', 'outer_unit', 'Bag')),
    conversion_factor: safeNum(pick(p, 'conversionFactor', 'conversion_factor', 1), 1),
    pack_size: safeStrNull(pick(p, 'packSize', 'pack_size', null)) ?? undefined,
    // Loose Product flag — defaults to false for backward compat.
    is_loose: Boolean(pick(p, 'isLoose', 'is_loose', false)),
    is_deleted: Boolean(pick(p, 'isDeleted', 'is_deleted', false)),
    purchase_rate_per_outer_unit: safeNum(pick(p, 'purchaseRatePerOuterUnit', 'purchase_rate_per_outer_unit', 0)),
    purchase_rate_per_piece: safeNum(pick(p, 'purchaseRatePerPiece', 'purchase_rate_per_piece', 0)),
    selling_rate_per_piece: safeNum(pick(p, 'sellingRatePerPiece', 'selling_rate_per_piece', 0)),
    selling_rate_per_outer_unit: safeNum(pick(p, 'sellingRatePerOuterUnit', 'selling_rate_per_outer_unit', 0)),
    purchase_rate: pick(p, 'purchaseRate', 'purchase_rate', null) != null
      ? safeNum(pick(p, 'purchaseRate', 'purchase_rate', null))
      : undefined,
    sales_rate: pick(p, 'salesRate', 'sales_rate', null) != null
      ? safeNum(pick(p, 'salesRate', 'sales_rate', null))
      : undefined,
    purchase_rate_per_pcs: pick(p, 'purchaseRatePerPcs', 'purchase_rate_per_pcs', null) != null
      ? safeNum(pick(p, 'purchaseRatePerPcs', 'purchase_rate_per_pcs', null))
      : undefined,
    sales_rate_per_pcs: pick(p, 'salesRatePerPcs', 'sales_rate_per_pcs', null) != null
      ? safeNum(pick(p, 'salesRatePerPcs', 'sales_rate_per_pcs', null))
      : undefined,
    gst_percent: safeNum(pick(p, 'gstPercent', 'gst_percent', 0)),
    opening_stock_pcs: safeNum(pick(p, 'openingStockPcs', 'opening_stock_pcs', 0)),
    created_at: safeISO(pick(p, 'createdAt', 'created_at', null)),
    isSynced: true,
    synced_at: safeISONullable(pick(p, 'syncedAt', 'synced_at', null)),
  })

  const mapCustomer = (c: any) => ({
    id: toNum(pick(c, 'localId', 'local_id', 0)),
    customer_id: safeStr(pick(c, 'customerId', 'customer_id', '')),
    name: safeStr(pick(c, 'name', 'name', '')),
    route_area: safeStr(pick(c, 'routeArea', 'route_area', '')),
    phone: safeStr(pick(c, 'phone', 'phone', '')),
    gstin: safeStrNull(pick(c, 'gstin', 'gstin', null)) ?? undefined,
    opening_balance: safeNum(pick(c, 'openingBalance', 'opening_balance', 0)),
    bill_number: safeStrNull(pick(c, 'billNumber', 'bill_number', null)) ?? undefined,
    is_deleted: Boolean(pick(c, 'isDeleted', 'is_deleted', false)),
    created_at: safeISO(pick(c, 'createdAt', 'created_at', null)),
    isSynced: true,
    synced_at: safeISONullable(pick(c, 'syncedAt', 'synced_at', null)),
  })

  const mapPurchase = (p: any) => ({
    id: toNum(pick(p, 'localId', 'local_id', 0)),
    bill_no: safeStr(pick(p, 'billNo', 'bill_no', '')),
    date: isoDateOnly(pick(p, 'date', 'date', '')),
    supplier_name: safeStr(pick(p, 'supplierName', 'supplier_name', '')),
    supplier_gstin: safeStrNull(pick(p, 'supplierGstin', 'supplier_gstin', null)) ?? undefined,
    product_id: toNum(pick(p, 'productId', 'product_id', 0)),
    product_sku: safeStr(pick(p, 'productSku', 'product_sku', '')),
    product_name: safeStr(pick(p, 'productName', 'product_name', '')),
    hsn_code: safeStr(pick(p, 'hsnCode', 'hsn_code', '')),
    bag_qty: safeNum(pick(p, 'bagQty', 'bag_qty', 0)),
    pcs_qty: safeNum(pick(p, 'pcsQty', 'pcs_qty', 0)),
    total_pcs: safeNum(pick(p, 'totalPcs', 'total_pcs', 0)),
    purchase_rate: safeNum(pick(p, 'purchaseRate', 'purchase_rate', 0)),
    gst_percent: safeNum(pick(p, 'gstPercent', 'gst_percent', 0)),
    taxable_amount: safeNum(pick(p, 'taxableAmount', 'taxable_amount', 0)),
    cgst: safeNum(pick(p, 'cgst', 'cgst', 0)),
    sgst: safeNum(pick(p, 'sgst', 'sgst', 0)),
    total_amount: safeNum(pick(p, 'totalAmount', 'total_amount', 0)),
    mfg_date: isoDateOnlyOrUndef(pick(p, 'mfgDate', 'mfg_date', null)),
    expiry_date: isoDateOnlyOrUndef(pick(p, 'expiryDate', 'expiry_date', null)),
    is_deleted: Boolean(pick(p, 'isDeleted', 'is_deleted', false)),
    created_at: safeISO(pick(p, 'createdAt', 'created_at', null)),
    isSynced: true,
    synced_at: safeISONullable(pick(p, 'syncedAt', 'synced_at', null)),
  })

  const mapSale = (s: any) => ({
    id: toNum(pick(s, 'localId', 'local_id', 0)),
    invoice_no: safeStr(pick(s, 'invoiceNo', 'invoice_no', '')),
    date: isoDateOnly(pick(s, 'date', 'date', '')),
    customer_id: toNum(pick(s, 'customerId', 'customer_id', 0)),
    customer_name: safeStr(pick(s, 'customerName', 'customer_name', '')),
    payment_mode: safeStr(pick(s, 'paymentMode', 'payment_mode', 'Cash'), 'Cash'),
    subtotal: safeNum(pick(s, 'subtotal', 'subtotal', 0)),
    cgst: safeNum(pick(s, 'cgst', 'cgst', 0)),
    sgst: safeNum(pick(s, 'sgst', 'sgst', 0)),
    total_amount: safeNum(pick(s, 'totalAmount', 'total_amount', 0)),
    total_profit: safeNum(pick(s, 'totalProfit', 'total_profit', 0)),
    total_margin_percent: safeNum(pick(s, 'totalMarginPercent', 'total_margin_percent', 0)),
    paid_amount: safeNum(pick(s, 'paidAmount', 'paid_amount', 0)),
    is_deleted: Boolean(pick(s, 'isDeleted', 'is_deleted', false)),
    created_at: safeISO(pick(s, 'createdAt', 'created_at', null)),
    isSynced: true,
    synced_at: safeISONullable(pick(s, 'syncedAt', 'synced_at', null)),
  })

  const mapSaleItem = (si: any) => ({
    id: toNum(pick(si, 'localId', 'local_id', 0)),
    sale_id: toNum(pick(si, 'saleLocalId', 'sale_local_id', 0)),
    product_id: toNum(pick(si, 'productId', 'product_id', 0)),
    product_name: safeStr(pick(si, 'productName', 'product_name', '')),
    product_sku: safeStr(pick(si, 'productSku', 'product_sku', '')),
    hsn_code: safeStr(pick(si, 'hsnCode', 'hsn_code', '')),
    quantity_pcs: safeNum(pick(si, 'quantityPcs', 'quantity_pcs', 0)),
    rate: safeNum(pick(si, 'rate', 'rate', 0)),
    gst_percent: safeNum(pick(si, 'gstPercent', 'gst_percent', 0)),
    taxable_amount: safeNum(pick(si, 'taxableAmount', 'taxable_amount', 0)),
    cgst: safeNum(pick(si, 'cgst', 'cgst', 0)),
    sgst: safeNum(pick(si, 'sgst', 'sgst', 0)),
    total: safeNum(pick(si, 'total', 'total', 0)),
    purchase_rate: safeNum(pick(si, 'purchaseRate', 'purchase_rate', 0)),
    item_profit: safeNum(pick(si, 'itemProfit', 'item_profit', 0)),
    item_margin_percent: safeNum(pick(si, 'itemMarginPercent', 'item_margin_percent', 0)),
    is_deleted: Boolean(pick(si, 'isDeleted', 'is_deleted', false)),
    created_at: safeISO(pick(si, 'createdAt', 'created_at', null)),
    isSynced: true,
    synced_at: safeISONullable(pick(si, 'syncedAt', 'synced_at', null)),
  })

  const mapCollection = (c: any) => ({
    id: toNum(pick(c, 'localId', 'local_id', 0)),
    date: isoDateOnly(pick(c, 'date', 'date', '')),
    customer_id: toNum(pick(c, 'customerId', 'customer_id', 0)),
    customer_name: safeStr(pick(c, 'customerName', 'customer_name', '')),
    amount: safeNum(pick(c, 'amount', 'amount', 0)),
    payment_mode: safeStr(pick(c, 'paymentMode', 'payment_mode', 'Cash'), 'Cash'),
    notes: safeStrNull(pick(c, 'notes', 'notes', null)) ?? undefined,
    // Bill-by-bill allocations: server stores as JSON string; client gets
    // a native JS array. Parse safely — malformed/null → undefined (lump-sum).
    bill_allocations: parseBillAllocations(pick(c, 'billAllocations', 'bill_allocations', null)),
    created_at: safeISO(pick(c, 'createdAt', 'created_at', null)),
    isSynced: true,
    synced_at: safeISONullable(pick(c, 'syncedAt', 'synced_at', null)),
  })

  const mapDistributorSetting = (d: any) => ({
    id: toNum(pick(d, 'localId', 'local_id', 0)),
    store_name: safeStr(pick(d, 'storeName', 'store_name', '')),
    subtitle: safeStrNull(pick(d, 'subtitle', 'subtitle', null)) ?? undefined,
    gstin: safeStr(pick(d, 'gstin', 'gstin', '')),
    address: safeStr(pick(d, 'address', 'address', '')),
    phone: safeStr(pick(d, 'phone', 'phone', '')),
    email: safeStr(pick(d, 'email', 'email', '')),
    logo_url: safeStrNull(pick(d, 'logoUrl', 'logo_url', null)) ?? undefined,
    invoice_prefix: safeStr(pick(d, 'invoicePrefix', 'invoice_prefix', 'INV'), 'INV'),
    state: safeStr(pick(d, 'state', 'state', '')),
    bank_details: safeStrNull(pick(d, 'bankDetails', 'bank_details', null)) ?? undefined,
    isSynced: true,
    synced_at: safeISONullable(pick(d, 'syncedAt', 'synced_at', null)),
  })

  const mapDamage = (d: any) => {
    // Explicitly type as string so the comparison below doesn't narrow to the
    // literal default 'godown' (TS would otherwise flag it as impossible).
    const damageSource: string = pick<string>(d, 'damageSource', 'damage_source', 'godown')
    const customerId = pick(d, 'customerId', 'customer_id', null)
    // Task 2 — Bill-wise damage allocation fields. Both nullable.
    const saleId = pick(d, 'saleId', 'sale_id', null)
    const againstInvoiceNo = pick(d, 'againstInvoiceNo', 'against_invoice_no', null)
    return {
      id: toNum(pick(d, 'localId', 'local_id', 0)),
      date: isoDateOnly(pick(d, 'date', 'date', '')),
      product_id: toNum(pick(d, 'productId', 'product_id', 0)),
      product_sku: safeStr(pick(d, 'productSku', 'product_sku', '')),
      product_name: safeStr(pick(d, 'productName', 'product_name', '')),
      hsn_code: safeStr(pick(d, 'hsnCode', 'hsn_code', '')),
      bag_qty: safeNum(pick(d, 'bagQty', 'bag_qty', 0)),
      pcs_qty: safeNum(pick(d, 'pcsQty', 'pcs_qty', 0)),
      total_pcs: safeNum(pick(d, 'totalPcs', 'total_pcs', 0)),
      reason: safeStr(pick(d, 'reason', 'reason', 'Broken'), 'Broken'),
      notes: safeStrNull(pick(d, 'notes', 'notes', null)) ?? undefined,
      expense_value: safeNum(pick(d, 'expenseValue', 'expense_value', 0)),
      // Upgrade 3 — Damage source. Old rows / old servers may not have the
      // column yet; default to 'godown' so behavior matches pre-upgrade.
      damage_source: damageSource === 'store' ? 'store' : 'godown',
      // customer_id only present for store damages; null → undefined for Dexie.
      customer_id: customerId != null ? toNum(customerId) : undefined,
      // Task 2 — sale_id + against_invoice_no only present for bill-linked
      // store damages; null → undefined for Dexie.
      sale_id: saleId != null ? toNum(saleId) : undefined,
      against_invoice_no: againstInvoiceNo != null ? safeStr(againstInvoiceNo) : undefined,
      created_at: safeISO(pick(d, 'createdAt', 'created_at', null)),
      isSynced: true,
      synced_at: safeISONullable(pick(d, 'syncedAt', 'synced_at', null)),
    }
  }

  const mapPurchaseReturn = (r: any) => {
    const origPurId = pick(r, 'originalPurchaseId', 'original_purchase_id', null)
    return {
      id: toNum(pick(r, 'localId', 'local_id', 0)),
      date: isoDateOnly(pick(r, 'date', 'date', '')),
      original_purchase_id: origPurId != null ? toNum(origPurId) : undefined,
      return_no: safeStr(pick(r, 'returnNo', 'return_no', '')),
      supplier_name: safeStr(pick(r, 'supplierName', 'supplier_name', '')),
      supplier_gstin: safeStrNull(pick(r, 'supplierGstin', 'supplier_gstin', null)) ?? undefined,
      product_id: toNum(pick(r, 'productId', 'product_id', 0)),
      product_sku: safeStr(pick(r, 'productSku', 'product_sku', '')),
      product_name: safeStr(pick(r, 'productName', 'product_name', '')),
      hsn_code: safeStr(pick(r, 'hsnCode', 'hsn_code', '')),
      bag_qty: safeNum(pick(r, 'bagQty', 'bag_qty', 0)),
      pcs_qty: safeNum(pick(r, 'pcsQty', 'pcs_qty', 0)),
      total_pcs: safeNum(pick(r, 'totalPcs', 'total_pcs', 0)),
      purchase_rate: safeNum(pick(r, 'purchaseRate', 'purchase_rate', 0)),
      purchase_rate_per_pcs: safeNum(pick(r, 'purchaseRatePerPcs', 'purchase_rate_per_pcs', 0)),
      gst_percent: safeNum(pick(r, 'gstPercent', 'gst_percent', 0)),
      taxable_amount: safeNum(pick(r, 'taxableAmount', 'taxable_amount', 0)),
      cgst: safeNum(pick(r, 'cgst', 'cgst', 0)),
      sgst: safeNum(pick(r, 'sgst', 'sgst', 0)),
      total_amount: safeNum(pick(r, 'totalAmount', 'total_amount', 0)),
      reason: safeStrNull(pick(r, 'reason', 'reason', null)) ?? undefined,
      created_at: safeISO(pick(r, 'createdAt', 'created_at', null)),
      isSynced: true,
      synced_at: safeISONullable(pick(r, 'syncedAt', 'synced_at', null)),
    }
  }

  const mapSalesReturn = (r: any) => {
    const origSaleId = pick(r, 'originalSaleId', 'original_sale_id', null)
    return {
      id: toNum(pick(r, 'localId', 'local_id', 0)),
      date: isoDateOnly(pick(r, 'date', 'date', '')),
      original_sale_id: origSaleId != null ? toNum(origSaleId) : undefined,
      return_no: safeStr(pick(r, 'returnNo', 'return_no', '')),
      customer_id: toNum(pick(r, 'customerId', 'customer_id', 0)),
      customer_name: safeStr(pick(r, 'customerName', 'customer_name', '')),
      product_id: toNum(pick(r, 'productId', 'product_id', 0)),
      product_sku: safeStr(pick(r, 'productSku', 'product_sku', '')),
      product_name: safeStr(pick(r, 'productName', 'product_name', '')),
      hsn_code: safeStr(pick(r, 'hsnCode', 'hsn_code', '')),
      bag_qty: safeNum(pick(r, 'bagQty', 'bag_qty', 0)),
      pcs_qty: safeNum(pick(r, 'pcsQty', 'pcs_qty', 0)),
      total_pcs: safeNum(pick(r, 'totalPcs', 'total_pcs', 0)),
      sales_rate_per_pcs: safeNum(pick(r, 'salesRatePerPcs', 'sales_rate_per_pcs', 0)),
      gst_percent: safeNum(pick(r, 'gstPercent', 'gst_percent', 0)),
      taxable_amount: safeNum(pick(r, 'taxableAmount', 'taxable_amount', 0)),
      cgst: safeNum(pick(r, 'cgst', 'cgst', 0)),
      sgst: safeNum(pick(r, 'sgst', 'sgst', 0)),
      total_amount: safeNum(pick(r, 'totalAmount', 'total_amount', 0)),
      restock: Boolean(pick(r, 'restock', 'restock', false)),
      reason: safeStrNull(pick(r, 'reason', 'reason', null)) ?? undefined,
      created_at: safeISO(pick(r, 'createdAt', 'created_at', null)),
      isSynced: true,
      synced_at: safeISONullable(pick(r, 'syncedAt', 'synced_at', null)),
    }
  }

  const totalRecords =
    products.length + customers.length + purchases.length +
    sales.length + saleItems.length + collections.length +
    distributorSettings.length + damages.length +
    purchaseReturns.length + salesReturns.length

  // ---- Diagnostic summary ----
  // Per-table counts + any failures + recovery info, so the client can
  // distinguish "empty table" from "Prisma failed + raw recovered" from
  // "both failed (needs schema sync)".
  const failedTables = Object.entries(tableStatus)
    .filter(([, s]) => !s.ok)
    .map(([name, s]) => ({ table: name, error: s.error, rawError: s.rawError }))

  const recoveredTables = Object.entries(tableStatus)
    .filter(([, s]) => s.recovered)
    .map(([name]) => name)

  const tableCounts = Object.fromEntries(
    Object.entries(tableStatus).map(([name, s]) => [name, s.count])
  )

  console.log('[sync/pull] ── Pull summary ──')
  console.log(
    `[sync/pull] Total: ${totalRecords} records across ${Object.keys(tableStatus).length} tables`
  )
  console.log(`[sync/pull] Per-table:`, tableCounts)
  if (recoveredTables.length > 0) {
    console.warn(
      `[sync/pull] ⚠️  ${recoveredTables.length} table(s) recovered via raw SQL fallback: ` +
        recoveredTables.join(', ')
    )
    console.warn(
      '[sync/pull]   (Prisma findMany() failed on these — likely legacy rows with ' +
        'invalid dates / NULLs. Raw SELECT * recovered all rows. ' +
        'Run `npm run db:push-turso` to also run the data-cleanup phase ' +
        'and fix the underlying rows so Prisma succeeds next time.)'
    )
  }
  if (failedTables.length > 0) {
    console.error(
      `[sync/pull] ✗ ${failedTables.length} table(s) FAILED completely (Prisma + raw both failed): ` +
        failedTables.map((f) => f.table).join(', ')
    )
    for (const f of failedTables) {
      console.error(
        `[sync/pull]   ✗ ${f.table}: ${f.error?.slice(0, 200)}`
      )
      if (f.rawError) {
        console.error(
          `[sync/pull]     raw error: ${f.rawError.slice(0, 200)}`
        )
      }
    }
  }
  if (failedTables.length === 0 && recoveredTables.length === 0) {
    console.log('[sync/pull] ✓ All tables queried successfully via Prisma')
  }

  const responseBody = {
    ok: true,
    pulledAt: new Date().toISOString(),
    totalRecords,
    // Surface per-table diagnostics so the client UI can show a helpful
    // warning when a table failed (instead of silently showing partial data).
    tableCounts,
    failedTables,
    recoveredTables,
    needsSchemaSync: failedTables.length > 0,
    data: {
      products: products.map(mapProduct),
      customers: customers.map(mapCustomer),
      purchases: purchases.map(mapPurchase),
      sales: sales.map(mapSale),
      sale_items: saleItems.map(mapSaleItem),
      collections: collections.map(mapCollection),
      distributor_settings: distributorSettings.map(mapDistributorSetting),
      damages: damages.map(mapDamage),
      purchase_returns: purchaseReturns.map(mapPurchaseReturn),
      sales_returns: salesReturns.map(mapSalesReturn),
    },
  }

  return new NextResponse(JSON.stringify(responseBody, bigIntReplacer), {
    headers: { 'Content-Type': 'application/json' },
  })
}

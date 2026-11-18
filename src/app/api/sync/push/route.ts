// ============================================================================
// POST /api/sync/push — DYNAMIC UPSERT ROUTER
// ----------------------------------------------------------------------------
// Replaces 10 hardcoded upsert functions with a single generic dynamicUpsert()
// that auto-maps snake_case → camelCase + auto-coerces types using convention.
//
// When you add a new column to schema.prisma, the dynamic mapper automatically
// passes it through — zero code changes needed here. Just run:
//   prisma generate + db:push-turso
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface BatchPayload {
  products?: any[]
  customers?: any[]
  purchases?: any[]
  sales?: any[]
  sale_items?: any[]
  collections?: any[]
  distributor_settings?: any[]
  damages?: any[]
  purchase_returns?: any[]
  sales_returns?: any[]
}

interface SyncResult {
  count: number
  ids: (number | string)[]
}

interface PushResponse {
  success: boolean
  results: Record<string, SyncResult>
  errors: { entity: string; id?: number | string; message: string }[]
}

function bigIntReplacer(_key: string, value: any): any {
  if (typeof value === 'bigint') return value.toString()
  return value
}

// ----------------------------------------------------------------------------
// Type coercion helpers
// ----------------------------------------------------------------------------

function toBigInt(val: any, fallback: bigint = BigInt(0)): bigint {
  if (typeof val === 'bigint') return val
  if (val === null || val === undefined || val === '') return fallback
  const n = Number(val)
  if (isNaN(n)) return fallback
  return BigInt(Math.trunc(n))
}

function toNullableBigInt(val: any): bigint | null {
  if (val === null || val === undefined || val === '') return null
  if (typeof val === 'bigint') return val
  const n = Number(val)
  if (isNaN(n)) return null
  return BigInt(Math.trunc(n))
}

function toNum(val: any, fallback = 0): number {
  if (typeof val === 'bigint') return Number(val)
  const n = Number(val)
  return isNaN(n) ? fallback : n
}

function toStr(val: any, fallback = ''): string {
  if (val === null || val === undefined) return fallback
  return String(val)
}

function toNullableStr(val: any): string | null {
  if (val === null || val === undefined || val === '') return null
  return String(val)
}

function toDate(val: any): Date {
  if (val) {
    const d = new Date(val)
    if (!isNaN(d.getTime())) return new Date(d.toISOString())
  }
  return new Date()
}

function isoDateOnly(val: any): string {
  if (val === null || val === undefined || val === '') return ''
  return String(val).slice(0, 10)
}

function nullableIsoDateOnly(val: any): string | null {
  if (val === null || val === undefined || val === '') return null
  return String(val).slice(0, 10)
}

// ----------------------------------------------------------------------------
// SNAKE_CASE → CAMELCASE converter
// ----------------------------------------------------------------------------
// "customer_type" → "customerType"
// "is_deleted" → "isDeleted"
// "bill_allocations" → "billAllocations"
// "against_invoice_no" → "againstInvoiceNo"
// ----------------------------------------------------------------------------

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

// ----------------------------------------------------------------------------
// CONVENTION-BASED TYPE INFERENCE  (v2)
// ----------------------------------------------------------------------------
// Same convention-based inference as before, but with three new escape hatches
// that fix the Vercel production errors:
//
//   1. ENTITY_FIELD_OVERRIDES — per-entity type override for fields whose
//      name matches the BigInt convention but is actually a String.
//      Example: Customer.customerId is "CUST-0246" (String), while
//      Sale.customerId / Collection.customerId / SalesReturn.customerId
//      are BigInt FKs. Without the override, the convention treats every
//      "customerId" as BigInt and corrupts the Customer table.
//
//   2. ENTITY_KEY_RENAMES — per-entity key rename for cases where Dexie's
//      snake_case column name doesn't match Prisma's expected key.
//      Example: sale_items in Dexie stores the parent sale FK as
//      "sale_id" (because Dexie uses the sale's auto-increment id which
//      IS its localId), but Prisma's SaleItem model expects
//      "saleLocalId" (mapped from column "sale_local_id"). Without the
//      rename, the mapper passes saleId=<bigint> but never sets
//      saleLocalId → Prisma throws "Argument saleLocalId is missing."
//
//   3. ENTITY_NULLABLE_STRINGS — per-entity allowlist of String columns
//      that genuinely accept NULL. Every other String column is treated
//      as non-null and defaults to "" (empty string) when null/undefined/
//      empty, preventing "Argument X must not be null" errors on
//      non-null String columns like Product.hsnCode,
//      DistributorSetting.email, SaleItem.hsnCode, etc.
// ----------------------------------------------------------------------------

// Fields that should be STRIPPED from the payload (server manages these)
const STRIP_FIELDS = new Set([
  'isSynced', 'synced_at', 'is_synced',
  'id', // the Dexie auto-increment id — we use localId instead
])

// BigInt field name patterns (by suffix or exact match).
// NOTE: `customerId` is intentionally NOT here — it is a String on Customer
// ("CUST-0246") but a BigInt FK on Sale / Collection / SalesReturn / Damage.
// It is resolved via ENTITY_FIELD_OVERRIDES below.
const BIGINT_FIELDS = new Set([
  'localId', 'productId', 'saleLocalId', 'saleId',
  'originalPurchaseId', 'originalSaleId', 'entityId', 'recordCount',
])

// Per-entity field type overrides — applied BEFORE the convention rules.
// 'string' forces String coercion; 'bigint' forces BigInt coercion.
const ENTITY_FIELD_OVERRIDES: Record<string, Record<string, 'string' | 'bigint'>> = {
  // Customer.customerId = "CUST-0246" — String, NOT a BigInt FK.
  // Sale/Collection/SalesReturn/Damage.customerId are BigInt — handled by
  // the default convention (endsWith('Id')) since they have no override here.
  customers: { customerId: 'string' },
}

// Per-entity key renames — applied BEFORE type coercion.
// Maps the snake_case key as it appears in the Dexie record to the camelCase
// key Prisma expects.
const ENTITY_KEY_RENAMES: Record<string, Record<string, string>> = {
  // Dexie stores parent sale FK as "sale_id"; Prisma SaleItem expects
  // "saleLocalId" (column "sale_local_id"). Without this rename,
  // dynamicUpsert sets data.saleId=<bigint> and Prisma throws
  // "Argument saleLocalId is missing."
  sale_items: { sale_id: 'saleLocalId' },
}

// Per-entity allowlist of String columns that genuinely accept NULL.
// Any String column NOT listed here defaults to "" instead of null when the
// incoming value is null/undefined/empty. This prevents Prisma's
// "Argument X must not be null" error on non-null String columns like
// Product.hsnCode, DistributorSetting.email, SaleItem.hsnCode, etc.
//
// Note: mfgDate / expiryDate are handled separately by isBusinessDateField
// and accept null regardless of this list.
const ENTITY_NULLABLE_STRINGS: Record<string, Set<string>> = {
  products:            new Set(['category', 'packSize']),
  customers:           new Set(['gstin', 'billNumber', 'customerType']),
  purchases:           new Set(['supplierGstin']),
  sales:               new Set(),
  sale_items:          new Set(),
  collections:         new Set(['notes', 'billAllocations']),
  distributor_settings: new Set(['subtitle', 'logoUrl', 'bankDetails']),
  // NOTE: Damage.reason is NON-NULL String in the schema — do NOT list it here.
  damages:             new Set(['notes', 'againstInvoiceNo']),
  purchase_returns:    new Set(['supplierGstin', 'reason']),
  sales_returns:       new Set(['reason']),
}

function isBigIntField(camelName: string): boolean {
  if (BIGINT_FIELDS.has(camelName)) return true
  // Any field ending in "Id" (camelCase) that's NOT in STRIP_FIELDS
  if (camelName.endsWith('Id') && !STRIP_FIELDS.has(camelName)) return true
  return false
}

function isBooleanField(camelName: string): boolean {
  return camelName.startsWith('is') && camelName.length > 2 &&
    camelName[2] === camelName[2].toUpperCase()
}

function isDateField(camelName: string): boolean {
  return camelName === 'createdAt' || camelName === 'syncedAt'
}

function isBusinessDateField(snakeName: string): boolean {
  return snakeName === 'date' || snakeName === 'mfg_date' ||
    snakeName === 'expiry_date'
}

function isFloatField(camelName: string, snakeName: string): boolean {
  const floatSuffixes = ['Amount', 'Rate', 'Pcs', 'Qty', 'Value', 'Percent',
    'Factor', 'Balance', 'ExpenseValue', 'BagValue', 'MarginPercent']
  const floatExact = new Set([
    'subtotal', 'cgst', 'sgst', 'total', 'rate', 'openingStockPcs',
    'conversionFactor', 'gstPercent', 'purchaseRate', 'salesRate',
    'purchaseRatePerPcs', 'salesRatePerPcs', 'purchaseRatePerPiece',
    'sellingRatePerPiece', 'purchaseRatePerOuterUnit',
    'sellingRatePerOuterUnit', 'openingBalance', 'paidAmount',
    'totalAmount', 'totalProfit', 'itemProfit', 'itemMarginPercent',
    'taxableAmount', 'totalMarginPercent', 'bagQty', 'pcsQty', 'totalPcs',
    'quantityPcs', 'salesRatePerPcs', 'purchaseRatePerPcs',
    'expenseValue', 'amount', 'openingStockPcs',
  ])
  if (floatExact.has(camelName)) return true
  return floatSuffixes.some(s => camelName.endsWith(s))
}

// ----------------------------------------------------------------------------
// DYNAMIC UPSERT — the single generic function that replaces all 10 handlers
// ----------------------------------------------------------------------------

/**
 * Dynamically maps a snake_case client record to a camelCase Prisma data
 * object, coercing types by convention + per-entity overrides. Then upserts
 * via the given Prisma model delegate.
 *
 * Three layers of type resolution (in priority order):
 *   1. ENTITY_FIELD_OVERRIDES — explicit per-entity overrides (e.g. Customer.
 *      customerId is String, not BigInt)
 *   2. ENTITY_KEY_RENAMES — per-entity snake_case key → camelCase Prisma key
 *      (e.g. sale_items.sale_id → saleLocalId)
 *   3. Convention rules — isBigIntField / isBooleanField / isFloatField /
 *      isDateField / isBusinessDateField / String fallback
 *
 * String fallback respects ENTITY_NULLABLE_STRINGS — fields in the allowlist
 * accept null; all other String columns default to "" when value is
 * null/undefined/empty (prevents Prisma "must not be null" errors).
 *
 * @param rec        - The raw client record (snake_case keys)
 * @param model       - The Prisma model delegate (e.g. db.product)
 * @param entityName - The batch key (e.g. "sale_items", "customers") —
 *                     used to resolve per-entity overrides & key renames
 * @returns          - The localId as a number (for the client's markSynced)
 */
async function dynamicUpsert(
  rec: any,
  model: any,
  entityName: string,
): Promise<number> {
  const localId = toBigInt(rec.id)
  const data: Record<string, any> = { localId }

  // Per-entity config snapshots (lookup once per record)
  const fieldOverrides   = ENTITY_FIELD_OVERRIDES[entityName] ?? {}
  const keyRenames       = ENTITY_KEY_RENAMES[entityName] ?? {}
  const nullableStrings  = ENTITY_NULLABLE_STRINGS[entityName] ?? new Set<string>()

  for (const snakeKey of Object.keys(rec)) {
    // Skip stripped fields (by snake_case OR camelCase form)
    if (STRIP_FIELDS.has(snakeKey) || STRIP_FIELDS.has(snakeToCamel(snakeKey))) continue

    // Apply per-entity key rename FIRST — e.g. sale_items.sale_id → saleLocalId
    const camelKey = keyRenames[snakeKey] ?? snakeToCamel(snakeKey)
    const rawVal = rec[snakeKey]

    // Skip undefined values (don't send them to Prisma)
    if (rawVal === undefined) continue

    // ---- Type resolution: override → convention ----
    const override = fieldOverrides[camelKey]

    if (override === 'string') {
      // Explicit String override (e.g. Customer.customerId = "CUST-0246").
      // Treat as a non-null String — default to "" when missing.
      data[camelKey] = (rawVal === null || rawVal === undefined) ? '' : String(rawVal)
    } else if (override === 'bigint') {
      // Explicit BigInt override (nullable when value is null/empty)
      data[camelKey] = (rawVal === null || rawVal === '') ? null : toBigInt(rawVal)
    } else if (isBigIntField(camelKey)) {
      // Nullable BigInt fields (saleId on Damage, originalPurchaseId, etc.)
      data[camelKey] = (rawVal === null || rawVal === '') ? null : toBigInt(rawVal)
    } else if (isBooleanField(camelKey)) {
      data[camelKey] = Boolean(rawVal ?? false)
    } else if (isDateField(camelKey)) {
      data[camelKey] = toDate(rawVal)
    } else if (isBusinessDateField(snakeKey)) {
      // Business dates are String columns (YYYY-MM-DD) and are nullable
      data[camelKey] = (rawVal === null || rawVal === undefined || rawVal === '')
        ? null : isoDateOnly(rawVal)
    } else if (isFloatField(camelKey, snakeKey)) {
      data[camelKey] = rawVal === null ? null : toNum(rawVal)
    } else {
      // String field — check per-entity nullable allowlist.
      // If the column accepts NULL (per Prisma schema), pass null through.
      // Otherwise default to "" to satisfy non-null String constraints.
      const isNullable = nullableStrings.has(camelKey)
      if (rawVal === null || rawVal === undefined || rawVal === '') {
        data[camelKey] = isNullable ? null : ''
      } else {
        data[camelKey] = String(rawVal)
      }
    }
  }

  // Always set syncedAt
  data.syncedAt = new Date()

  // ---- SPECIAL CASE: sale_items orphan cleanup ----
  // When upserting a Sale, delete all existing sale_items first to prevent
  // orphaned duplicates from previous edits.
  if (model === db.sale) {
    try {
      await db.saleItem.deleteMany({
        where: { saleLocalId: localId },
      })
    } catch (e: any) {
      console.warn(`[sync/push] Failed to clear old sale_items for sale ${localId}:`, e?.message)
    }
  }

  await model.upsert({
    where: { localId },
    create: data,
    update: data,
  })

  return Number(localId)
}

// ----------------------------------------------------------------------------
// Entity name → Prisma model delegate map
// ----------------------------------------------------------------------------

const MODEL_MAP: Record<string, any> = {
  products: db.product,
  customers: db.customer,
  purchases: db.purchase,
  sales: db.sale,
  sale_items: db.saleItem,
  collections: db.collection,
  distributor_settings: db.distributorSetting,
  damages: db.damage,
  purchase_returns: db.purchaseReturn,
  sales_returns: db.salesReturn,
}

// ----------------------------------------------------------------------------
// POST handler
// ----------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { batches?: BatchPayload }
    | null

  if (!body?.batches) {
    return NextResponse.json(
      { success: false, error: 'Missing `batches` in request body' },
      { status: 400 }
    )
  }

  const batches = body.batches
  const results: Record<string, SyncResult> = {}
  const errors: PushResponse['errors'] = []

  console.log('[sync/push] Received batch:', {
    products: batches.products?.length ?? 0,
    customers: batches.customers?.length ?? 0,
    purchases: batches.purchases?.length ?? 0,
    sales: batches.sales?.length ?? 0,
    sale_items: batches.sale_items?.length ?? 0,
    collections: batches.collections?.length ?? 0,
    distributor_settings: batches.distributor_settings?.length ?? 0,
    damages: batches.damages?.length ?? 0,
    purchase_returns: batches.purchase_returns?.length ?? 0,
    sales_returns: batches.sales_returns?.length ?? 0,
  })

  for (const entityName of Object.keys(batches) as (keyof BatchPayload)[]) {
    const records = batches[entityName] ?? []
    if (records.length === 0) continue

    const model = MODEL_MAP[entityName]
    if (!model) {
      errors.push({
        entity: entityName,
        message: `Unknown entity type: ${entityName}`,
      })
      continue
    }

    const ids: (number | string)[] = []
    for (const rec of records) {
      try {
        const id = await dynamicUpsert(rec, model, entityName as string)
        ids.push(id)
      } catch (e: any) {
        console.error(`[sync/push] FAILED to upsert ${entityName} id=${rec?.id}:`, {
          entity: entityName,
          localId: rec?.id,
          error: {
            message: e?.message,
            code: e?.code,
            meta: e?.meta,
            cause: e?.cause,
            stack: e?.stack?.split('\n').slice(0, 5).join('\n'),
          },
          record: JSON.stringify(rec).slice(0, 500),
        })

        errors.push({
          entity: entityName,
          id: rec?.id,
          message: e?.message ?? String(e),
        })
      }
    }
    results[entityName] = { count: ids.length, ids }

    if (ids.length > 0) {
      console.log(`[sync/push] ${entityName}: ${ids.length}/${records.length} synced OK`)
    }
    if (records.length - ids.length > 0) {
      console.error(`[sync/push] ${entityName}: ${records.length - ids.length} FAILED`)
    }
  }

  const totalErrors = errors.length
  const totalSynced = Object.values(results).reduce((s, r) => s + r.count, 0)
  console.log(`[sync/push] Done: ${totalSynced} synced, ${totalErrors} errors`)

  const responseBody = {
    success: totalErrors === 0,
    results,
    errors,
  } satisfies PushResponse

  return new NextResponse(JSON.stringify(responseBody, bigIntReplacer), {
    headers: { 'Content-Type': 'application/json' },
  })
}

// ----------------------------------------------------------------------------
// GET handler — health check
// ----------------------------------------------------------------------------

export async function GET() {
  const body = {
    ok: true,
    service: 'FMCG ERP Sync — Push Endpoint (DYNAMIC)',
    version: 9,
    strategy: 'dynamic upsert by localId — convention-based type coercion',
    entities: Object.keys(MODEL_MAP),
  }
  return new NextResponse(JSON.stringify(body, bigIntReplacer), {
    headers: { 'Content-Type': 'application/json' },
  })
}

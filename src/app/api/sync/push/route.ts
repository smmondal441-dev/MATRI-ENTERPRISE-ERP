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
// CONVENTION-BASED TYPE INFERENCE
// ----------------------------------------------------------------------------
// Since we can't reliably access Prisma's DMMF in adapter mode, we infer the
// Prisma type from the field name + value:
//
//   - Fields ending in "_id" or named "id" / "local_id" / "sale_local_id"
//     → BigInt (nullable if value is null/undefined)
//   - Fields starting with "is_" → Boolean
//   - Fields ending in "_at" or named "created_at" / "synced_at" → DateTime
//   - Fields named "date" / "mfg_date" / "expiry_date" → String (YYYY-MM-DD)
//   - Fields ending in "_amount" / "_rate" / "_pcs" / "_qty" / "_value" /
//     "_percent" / "_factor" / "_balance" / "subtotal" / "cgst" / "sgst" /
//     "total" / "rate" → Float
//   - Everything else → String (nullable if value is null/undefined)
// ----------------------------------------------------------------------------

// Fields that should be STRIPPED from the payload (server manages these)
const STRIP_FIELDS = new Set([
  'isSynced', 'synced_at', 'is_synced',
  'id', // the Dexie auto-increment id — we use localId instead
])

// BigInt field name patterns (by suffix or exact match)
const BIGINT_FIELDS = new Set([
  'localId', 'productId', 'customerId', 'saleLocalId', 'saleId',
  'originalPurchaseId', 'originalSaleId', 'entityId', 'recordCount',
])

function isBigIntField(camelName: string): boolean {
  if (BIGINT_FIELDS.has(camelName)) return true
  // Any field ending in "Id" (camelCase) or "_id" (snake_case) that's NOT in STRIP_FIELDS
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
 * object, coercing types by convention. Then upserts via the given Prisma
 * model delegate.
 *
 * @param rec       - The raw client record (snake_case keys)
 * @param model     - The Prisma model delegate (e.g. db.product)
 * @returns         - The localId as a number (for the client's markSynced)
 */
async function dynamicUpsert(
  rec: any,
  model: any
): Promise<number> {
  const localId = toBigInt(rec.id)
  const data: Record<string, any> = { localId }

  for (const snakeKey of Object.keys(rec)) {
    // Skip stripped fields
    if (STRIP_FIELDS.has(snakeKey) || STRIP_FIELDS.has(snakeToCamel(snakeKey))) continue

    const camelKey = snakeToCamel(snakeKey)
    const rawVal = rec[snakeKey]

    // Skip undefined values (don't send them to Prisma)
    if (rawVal === undefined) continue

    // Auto-coerce based on convention
    if (isBigIntField(camelKey)) {
      // Nullable BigInt fields (like customerId on Damage, originalPurchaseId, etc.)
      if (rawVal === null || rawVal === '') {
        data[camelKey] = null
      } else {
        data[camelKey] = toBigInt(rawVal)
      }
    } else if (isBooleanField(camelKey)) {
      data[camelKey] = Boolean(rawVal ?? false)
    } else if (isDateField(camelKey)) {
      data[camelKey] = toDate(rawVal)
    } else if (isBusinessDateField(snakeKey)) {
      // Business dates are String columns (YYYY-MM-DD)
      data[camelKey] = rawVal === null || rawVal === undefined || rawVal === ''
        ? null : isoDateOnly(rawVal)
    } else if (isFloatField(camelKey, snakeKey)) {
      data[camelKey] = rawVal === null ? null : toNum(rawVal)
    } else {
      // String field — nullable if null/undefined
      data[camelKey] = (rawVal === null || rawVal === undefined || rawVal === '')
        ? null : String(rawVal)
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
        const id = await dynamicUpsert(rec, model)
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
    version: 8,
    strategy: 'dynamic upsert by localId — convention-based type coercion',
    entities: Object.keys(MODEL_MAP),
  }
  return new NextResponse(JSON.stringify(body, bigIntReplacer), {
    headers: { 'Content-Type': 'application/json' },
  })
}

// ============================================================================
// POST /api/sync/push
// ----------------------------------------------------------------------------
// Receives a batch of locally-created records from the offline-first ERP and
// upserts them into PostgreSQL / CockroachDB via Prisma.
//
// STRATEGY (v2 — CockroachDB-safe):
//   - The server table has its own auto-increment `id` (primary key) PLUS a
//     `local_id` column that stores the client-side Dexie ID.
//   - Upserts match on `localId` (not `id`), so there's never a conflict
//     between client-provided IDs and server-generated sequence IDs.
//   - If a record with the same `localId` already exists, we update its data
//     fields. If not, we create a new row with a server-generated `id` and
//     the client's `localId`.
//   - Every failed record is logged to console.error with full detail so the
//     developer can trace exact database rejection reasons.
//
// Request body:
//   { "batches": { "products": [{...}], "customers": [{...}], ... } }
//
// Response:
//   {
//     "success": true,
//     "results": { "products": { "count": 5, "ids": [1, 2, 3, 4, 5] } },
//     "errors": []
//   }
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

// ----------------------------------------------------------------------------
// Helper — safe number coercion
// ----------------------------------------------------------------------------

function num(val: any, fallback = 0): number {
  const n = Number(val)
  return isNaN(n) ? fallback : n
}

function str(val: any, fallback = ''): string {
  if (val === null || val === undefined) return fallback
  return String(val)
}

function nullableStr(val: any): string | null {
  if (val === null || val === undefined || val === '') return null
  return String(val)
}

function dateOrNow(val: any): Date {
  if (val) {
    const d = new Date(val)
    if (!isNaN(d.getTime())) return d
  }
  return new Date()
}

// ----------------------------------------------------------------------------
// Per-entity upsert handlers
// ----------------------------------------------------------------------------
// Each handler:
//   1. Extracts the local Dexie `id` from the record
//   2. Uses Prisma `upsert` with `where: { localId: <dexie_id> }`
//   3. On create: lets the server auto-generate the `id` column
//   4. On update: refreshes all data fields (not just syncedAt)
//   5. Returns the local ID so the client can mark isSynced=true
//
// IMPORTANT: The `localId` column must exist in the Prisma schema with a
// @@unique constraint. See prisma/schema.prisma for the updated models.
// ----------------------------------------------------------------------------

async function upsertProduct(rec: any): Promise<number> {
  const localId = num(rec.id)
  const data = {
    localId,
    sku: str(rec.sku),
    companyName: str(rec.company_name),
    name: str(rec.name),
    category: nullableStr(rec.category),
    hsnCode: str(rec.hsn_code),
    baseUnit: str(rec.base_unit, 'Pcs'),
    outerUnit: str(rec.outer_unit, 'Bag'),
    conversionFactor: num(rec.conversion_factor, 1),
    packSize: nullableStr(rec.pack_size),
    purchaseRatePerOuterUnit: num(rec.purchase_rate_per_outer_unit ?? rec.purchase_rate),
    purchaseRatePerPiece: num(rec.purchase_rate_per_piece ?? rec.purchase_rate_per_pcs),
    sellingRatePerPiece: num(rec.selling_rate_per_piece ?? rec.sales_rate_per_pcs),
    sellingRatePerOuterUnit: num(rec.selling_rate_per_outer_unit ?? rec.sales_rate),
    purchaseRate: rec.purchase_rate != null ? num(rec.purchase_rate) : null,
    salesRate: rec.sales_rate != null ? num(rec.sales_rate) : null,
    purchaseRatePerPcs: rec.purchase_rate_per_pcs != null ? num(rec.purchase_rate_per_pcs) : null,
    salesRatePerPcs: rec.sales_rate_per_pcs != null ? num(rec.sales_rate_per_pcs) : null,
    gstPercent: num(rec.gst_percent),
    openingStockPcs: num(rec.opening_stock_pcs),
    createdAt: dateOrNow(rec.created_at),
    syncedAt: new Date(),
  }
  const result = await db.product.upsert({
    where: { localId },
    create: data,
    update: data,
  })
  return localId
}

async function upsertCustomer(rec: any): Promise<number> {
  const localId = num(rec.id)
  const data = {
    localId,
    customerId: str(rec.customer_id),
    name: str(rec.name),
    routeArea: str(rec.route_area),
    phone: str(rec.phone),
    gstin: nullableStr(rec.gstin),
    openingBalance: num(rec.opening_balance),
    createdAt: dateOrNow(rec.created_at),
    syncedAt: new Date(),
  }
  const result = await db.customer.upsert({
    where: { localId },
    create: data,
    update: data,
  })
  return localId
}

async function upsertPurchase(rec: any): Promise<number> {
  const localId = num(rec.id)
  const data = {
    localId,
    billNo: str(rec.bill_no),
    date: str(rec.date),
    supplierName: str(rec.supplier_name),
    supplierGstin: nullableStr(rec.supplier_gstin),
    productId: num(rec.product_id),
    productSku: str(rec.product_sku),
    productName: str(rec.product_name),
    hsnCode: str(rec.hsn_code),
    bagQty: num(rec.bag_qty),
    pcsQty: num(rec.pcs_qty),
    totalPcs: num(rec.total_pcs),
    purchaseRate: num(rec.purchase_rate),
    gstPercent: num(rec.gst_percent),
    taxableAmount: num(rec.taxable_amount),
    cgst: num(rec.cgst),
    sgst: num(rec.sgst),
    totalAmount: num(rec.total_amount),
    createdAt: dateOrNow(rec.created_at),
    syncedAt: new Date(),
  }
  await db.purchase.upsert({
    where: { localId },
    create: data,
    update: data,
  })
  return localId
}

async function upsertSale(rec: any): Promise<number> {
  const localId = num(rec.id)
  const data = {
    localId,
    invoiceNo: str(rec.invoice_no),
    date: str(rec.date),
    customerId: num(rec.customer_id),
    customerName: str(rec.customer_name),
    paymentMode: str(rec.payment_mode, 'Cash'),
    subtotal: num(rec.subtotal),
    cgst: num(rec.cgst),
    sgst: num(rec.sgst),
    totalAmount: num(rec.total_amount),
    totalProfit: num(rec.total_profit),
    totalMarginPercent: num(rec.total_margin_percent),
    paidAmount: num(rec.paid_amount),
    createdAt: dateOrNow(rec.created_at),
    syncedAt: new Date(),
  }
  await db.sale.upsert({
    where: { localId },
    create: data,
    update: data,
  })
  return localId
}

async function upsertSaleItem(rec: any): Promise<number> {
  const localId = num(rec.id)
  const data = {
    localId,
    saleLocalId: num(rec.sale_id),
    productId: num(rec.product_id),
    productName: str(rec.product_name),
    productSku: str(rec.product_sku),
    hsnCode: str(rec.hsn_code),
    quantityPcs: num(rec.quantity_pcs),
    rate: num(rec.rate),
    gstPercent: num(rec.gst_percent),
    taxableAmount: num(rec.taxable_amount),
    cgst: num(rec.cgst),
    sgst: num(rec.sgst),
    total: num(rec.total),
    purchaseRate: num(rec.purchase_rate),
    itemProfit: num(rec.item_profit),
    itemMarginPercent: num(rec.item_margin_percent),
    syncedAt: new Date(),
  }
  await db.saleItem.upsert({
    where: { localId },
    create: data,
    update: data,
  })
  return localId
}

async function upsertCollection(rec: any): Promise<number> {
  const localId = num(rec.id)
  const data = {
    localId,
    date: str(rec.date),
    customerId: num(rec.customer_id),
    customerName: str(rec.customer_name),
    amount: num(rec.amount),
    paymentMode: str(rec.payment_mode, 'Cash'),
    notes: nullableStr(rec.notes),
    createdAt: dateOrNow(rec.created_at),
    syncedAt: new Date(),
  }
  await db.collection.upsert({
    where: { localId },
    create: data,
    update: data,
  })
  return localId
}

async function upsertDistributorSetting(rec: any): Promise<number> {
  const localId = num(rec.id)
  const data = {
    localId,
    storeName: str(rec.store_name),
    subtitle: nullableStr(rec.subtitle),
    gstin: str(rec.gstin),
    address: str(rec.address),
    phone: str(rec.phone),
    email: str(rec.email),
    logoUrl: nullableStr(rec.logo_url),
    invoicePrefix: str(rec.invoice_prefix, 'INV'),
    state: str(rec.state),
    bankDetails: nullableStr(rec.bank_details),
    syncedAt: new Date(),
  }
  await db.distributorSetting.upsert({
    where: { localId },
    create: data,
    update: data,
  })
  return localId
}

async function upsertDamage(rec: any): Promise<number> {
  const localId = num(rec.id)
  const data = {
    localId,
    date: str(rec.date),
    productId: num(rec.product_id),
    productSku: str(rec.product_sku),
    productName: str(rec.product_name),
    hsnCode: str(rec.hsn_code),
    bagQty: num(rec.bag_qty),
    pcsQty: num(rec.pcs_qty),
    totalPcs: num(rec.total_pcs),
    reason: str(rec.reason, 'Broken'),
    notes: nullableStr(rec.notes),
    expenseValue: num(rec.expense_value),
    createdAt: dateOrNow(rec.created_at),
    syncedAt: new Date(),
  }
  await db.damage.upsert({
    where: { localId },
    create: data,
    update: data,
  })
  return localId
}

async function upsertPurchaseReturn(rec: any): Promise<number> {
  const localId = num(rec.id)
  const data = {
    localId,
    date: str(rec.date),
    originalPurchaseId: rec.original_purchase_id != null ? num(rec.original_purchase_id) : null,
    returnNo: str(rec.return_no),
    supplierName: str(rec.supplier_name),
    supplierGstin: nullableStr(rec.supplier_gstin),
    productId: num(rec.product_id),
    productSku: str(rec.product_sku),
    productName: str(rec.product_name),
    hsnCode: str(rec.hsn_code),
    bagQty: num(rec.bag_qty),
    pcsQty: num(rec.pcs_qty),
    totalPcs: num(rec.total_pcs),
    purchaseRate: num(rec.purchase_rate),
    purchaseRatePerPcs: num(rec.purchase_rate_per_pcs),
    gstPercent: num(rec.gst_percent),
    taxableAmount: num(rec.taxable_amount),
    cgst: num(rec.cgst),
    sgst: num(rec.sgst),
    totalAmount: num(rec.total_amount),
    reason: nullableStr(rec.reason),
    createdAt: dateOrNow(rec.created_at),
    syncedAt: new Date(),
  }
  await db.purchaseReturn.upsert({
    where: { localId },
    create: data,
    update: data,
  })
  return localId
}

async function upsertSalesReturn(rec: any): Promise<number> {
  const localId = num(rec.id)
  const data = {
    localId,
    date: str(rec.date),
    originalSaleId: rec.original_sale_id != null ? num(rec.original_sale_id) : null,
    returnNo: str(rec.return_no),
    customerId: num(rec.customer_id),
    customerName: str(rec.customer_name),
    productId: num(rec.product_id),
    productSku: str(rec.product_sku),
    productName: str(rec.product_name),
    hsnCode: str(rec.hsn_code),
    bagQty: num(rec.bag_qty),
    pcsQty: num(rec.pcs_qty),
    totalPcs: num(rec.total_pcs),
    salesRatePerPcs: num(rec.sales_rate_per_pcs),
    gstPercent: num(rec.gst_percent),
    taxableAmount: num(rec.taxable_amount),
    cgst: num(rec.cgst),
    sgst: num(rec.sgst),
    totalAmount: num(rec.total_amount),
    restock: Boolean(rec.restock ?? false),
    reason: nullableStr(rec.reason),
    createdAt: dateOrNow(rec.created_at),
    syncedAt: new Date(),
  }
  await db.salesReturn.upsert({
    where: { localId },
    create: data,
    update: data,
  })
  return localId
}

// ----------------------------------------------------------------------------
// Entity name -> upsert function map
// ----------------------------------------------------------------------------

const UPSERT_HANDLERS: Record<
  keyof BatchPayload,
  (rec: any) => Promise<number>
> = {
  products: upsertProduct,
  customers: upsertCustomer,
  purchases: upsertPurchase,
  sales: upsertSale,
  sale_items: upsertSaleItem,
  collections: upsertCollection,
  distributor_settings: upsertDistributorSetting,
  damages: upsertDamage,
  purchase_returns: upsertPurchaseReturn,
  sales_returns: upsertSalesReturn,
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

    const handler = UPSERT_HANDLERS[entityName]
    if (!handler) {
      errors.push({
        entity: entityName,
        message: `Unknown entity type: ${entityName}`,
      })
      continue
    }

    const ids: (number | string)[] = []
    for (const rec of records) {
      try {
        const id = await handler(rec)
        ids.push(id)
      } catch (e: any) {
        // ---- DETAILED SERVER-SIDE LOGGING ----
        // Log the full error to the server console so developers can trace
        // exact database rejection reasons (constraint names, column names,
        // SQL state codes, etc.)
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

  return NextResponse.json({
    success: totalErrors === 0,
    results,
    errors,
  } satisfies PushResponse)
}

// ----------------------------------------------------------------------------
// GET handler — health check
// ----------------------------------------------------------------------------

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'FMCG ERP Sync — Push Endpoint (v2 CockroachDB-safe)',
    version: 6,
    strategy: 'upsert by localId (not by id) — server auto-generates id',
    endpoints: Object.keys(UPSERT_HANDLERS),
    usage:
      'POST a { batches: { products: [...], sales: [...] } } payload. ' +
      'Records are upserted by their localId column. ' +
      'Response includes successfully-synced local IDs per entity.',
  })
}

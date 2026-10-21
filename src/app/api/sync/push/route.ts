// ============================================================================
// POST /api/sync/push
// ----------------------------------------------------------------------------
// Receives a batch of locally-created records from the offline-first ERP and
// upserts them into PostgreSQL via Prisma.
//
// Request body:
//   {
//     "batches": {
//       "products": [{...}, {...}],
//       "customers": [{...}],
//       "sales": [{...}],
//       ...
//     }
//   }
//
// Response:
//   {
//     "success": true,
//     "results": {
//       "products": { "count": 5, "ids": [1, 2, 3, 4, 5] },
//       "customers": { "count": 1, "ids": [10] },
//       ...
//     },
//     "errors": []
//   }
//
// All records are upserted by their local Dexie `id` (the primary key). The
// server echoes back the IDs that were successfully synced so the client can
// flip their `isSynced` flag to true.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Disable static optimization — this is a dynamic API route
export const dynamic = 'force-dynamic'

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
// Per-entity upsert handlers — each takes a record and returns its id.
// All fields use Prisma's upsert (create-or-update) so re-pushing the same
// record is idempotent.
// ----------------------------------------------------------------------------

async function upsertProduct(rec: any): Promise<number> {
  const result = await db.product.upsert({
    where: { id: Number(rec.id) },
    create: {
      id: Number(rec.id),
      sku: String(rec.sku ?? ''),
      companyName: String(rec.company_name ?? ''),
      name: String(rec.name ?? ''),
      category: rec.category ?? null,
      hsnCode: String(rec.hsn_code ?? ''),
      baseUnit: String(rec.base_unit ?? 'Pcs'),
      outerUnit: String(rec.outer_unit ?? 'Bag'),
      conversionFactor: Number(rec.conversion_factor ?? 1),
      packSize: rec.pack_size ?? null,
      purchaseRatePerOuterUnit: Number(rec.purchase_rate_per_outer_unit ?? rec.purchase_rate ?? 0),
      purchaseRatePerPiece: Number(rec.purchase_rate_per_piece ?? rec.purchase_rate_per_pcs ?? 0),
      sellingRatePerPiece: Number(rec.selling_rate_per_piece ?? rec.sales_rate_per_pcs ?? 0),
      sellingRatePerOuterUnit: Number(rec.selling_rate_per_outer_unit ?? rec.sales_rate ?? 0),
      purchaseRate: rec.purchase_rate ?? null,
      salesRate: rec.sales_rate ?? null,
      purchaseRatePerPcs: rec.purchase_rate_per_pcs ?? null,
      salesRatePerPcs: rec.sales_rate_per_pcs ?? null,
      gstPercent: Number(rec.gst_percent ?? 0),
      openingStockPcs: Number(rec.opening_stock_pcs ?? 0),
      createdAt: rec.created_at ? new Date(rec.created_at) : new Date(),
      syncedAt: new Date(),
    },
    update: {
      sku: String(rec.sku ?? ''),
      companyName: String(rec.company_name ?? ''),
      name: String(rec.name ?? ''),
      category: rec.category ?? null,
      hsnCode: String(rec.hsn_code ?? ''),
      baseUnit: String(rec.base_unit ?? 'Pcs'),
      outerUnit: String(rec.outer_unit ?? 'Bag'),
      conversionFactor: Number(rec.conversion_factor ?? 1),
      packSize: rec.pack_size ?? null,
      purchaseRatePerOuterUnit: Number(rec.purchase_rate_per_outer_unit ?? rec.purchase_rate ?? 0),
      purchaseRatePerPiece: Number(rec.purchase_rate_per_piece ?? rec.purchase_rate_per_pcs ?? 0),
      sellingRatePerPiece: Number(rec.selling_rate_per_piece ?? rec.sales_rate_per_pcs ?? 0),
      sellingRatePerOuterUnit: Number(rec.selling_rate_per_outer_unit ?? rec.sales_rate ?? 0),
      purchaseRate: rec.purchase_rate ?? null,
      salesRate: rec.sales_rate ?? null,
      purchaseRatePerPcs: rec.purchase_rate_per_pcs ?? null,
      salesRatePerPcs: rec.sales_rate_per_pcs ?? null,
      gstPercent: Number(rec.gst_percent ?? 0),
      openingStockPcs: Number(rec.opening_stock_pcs ?? 0),
      syncedAt: new Date(),
    },
  })
  return result.id
}

async function upsertCustomer(rec: any): Promise<number> {
  const result = await db.customer.upsert({
    where: { id: Number(rec.id) },
    create: {
      id: Number(rec.id),
      customerId: String(rec.customer_id ?? ''),
      name: String(rec.name ?? ''),
      routeArea: String(rec.route_area ?? ''),
      phone: String(rec.phone ?? ''),
      gstin: rec.gstin ?? null,
      openingBalance: Number(rec.opening_balance ?? 0),
      createdAt: rec.created_at ? new Date(rec.created_at) : new Date(),
      syncedAt: new Date(),
    },
    update: {
      customerId: String(rec.customer_id ?? ''),
      name: String(rec.name ?? ''),
      routeArea: String(rec.route_area ?? ''),
      phone: String(rec.phone ?? ''),
      gstin: rec.gstin ?? null,
      openingBalance: Number(rec.opening_balance ?? 0),
      syncedAt: new Date(),
    },
  })
  return result.id
}

async function upsertPurchase(rec: any): Promise<number> {
  const result = await db.purchase.upsert({
    where: { id: Number(rec.id) },
    create: {
      id: Number(rec.id),
      billNo: String(rec.bill_no ?? ''),
      date: String(rec.date ?? ''),
      supplierName: String(rec.supplier_name ?? ''),
      supplierGstin: rec.supplier_gstin ?? null,
      productId: Number(rec.product_id ?? 0),
      productSku: String(rec.product_sku ?? ''),
      productName: String(rec.product_name ?? ''),
      hsnCode: String(rec.hsn_code ?? ''),
      bagQty: Number(rec.bag_qty ?? 0),
      pcsQty: Number(rec.pcs_qty ?? 0),
      totalPcs: Number(rec.total_pcs ?? 0),
      purchaseRate: Number(rec.purchase_rate ?? 0),
      gstPercent: Number(rec.gst_percent ?? 0),
      taxableAmount: Number(rec.taxable_amount ?? 0),
      cgst: Number(rec.cgst ?? 0),
      sgst: Number(rec.sgst ?? 0),
      totalAmount: Number(rec.total_amount ?? 0),
      createdAt: rec.created_at ? new Date(rec.created_at) : new Date(),
      syncedAt: new Date(),
    },
    update: { syncedAt: new Date() },
  })
  return result.id
}

async function upsertSale(rec: any): Promise<number> {
  const result = await db.sale.upsert({
    where: { id: Number(rec.id) },
    create: {
      id: Number(rec.id),
      invoiceNo: String(rec.invoice_no ?? ''),
      date: String(rec.date ?? ''),
      customerId: Number(rec.customer_id ?? 0),
      customerName: String(rec.customer_name ?? ''),
      paymentMode: String(rec.payment_mode ?? 'Cash'),
      subtotal: Number(rec.subtotal ?? 0),
      cgst: Number(rec.cgst ?? 0),
      sgst: Number(rec.sgst ?? 0),
      totalAmount: Number(rec.total_amount ?? 0),
      totalProfit: Number(rec.total_profit ?? 0),
      totalMarginPercent: Number(rec.total_margin_percent ?? 0),
      paidAmount: Number(rec.paid_amount ?? 0),
      createdAt: rec.created_at ? new Date(rec.created_at) : new Date(),
      syncedAt: new Date(),
    },
    update: { syncedAt: new Date() },
  })
  return result.id
}

async function upsertSaleItem(rec: any): Promise<number> {
  const result = await db.saleItem.upsert({
    where: { id: Number(rec.id) },
    create: {
      id: Number(rec.id),
      saleId: Number(rec.sale_id ?? 0),
      productId: Number(rec.product_id ?? 0),
      productName: String(rec.product_name ?? ''),
      productSku: String(rec.product_sku ?? ''),
      hsnCode: String(rec.hsn_code ?? ''),
      quantityPcs: Number(rec.quantity_pcs ?? 0),
      rate: Number(rec.rate ?? 0),
      gstPercent: Number(rec.gst_percent ?? 0),
      taxableAmount: Number(rec.taxable_amount ?? 0),
      cgst: Number(rec.cgst ?? 0),
      sgst: Number(rec.sgst ?? 0),
      total: Number(rec.total ?? 0),
      purchaseRate: Number(rec.purchase_rate ?? 0),
      itemProfit: Number(rec.item_profit ?? 0),
      itemMarginPercent: Number(rec.item_margin_percent ?? 0),
      syncedAt: new Date(),
    },
    update: { syncedAt: new Date() },
  })
  return result.id
}

async function upsertCollection(rec: any): Promise<number> {
  const result = await db.collection.upsert({
    where: { id: Number(rec.id) },
    create: {
      id: Number(rec.id),
      date: String(rec.date ?? ''),
      customerId: Number(rec.customer_id ?? 0),
      customerName: String(rec.customer_name ?? ''),
      amount: Number(rec.amount ?? 0),
      paymentMode: String(rec.payment_mode ?? 'Cash'),
      notes: rec.notes ?? null,
      createdAt: rec.created_at ? new Date(rec.created_at) : new Date(),
      syncedAt: new Date(),
    },
    update: { syncedAt: new Date() },
  })
  return result.id
}

async function upsertDistributorSetting(rec: any): Promise<number> {
  const result = await db.distributorSetting.upsert({
    where: { id: Number(rec.id) },
    create: {
      id: Number(rec.id),
      storeName: String(rec.store_name ?? ''),
      subtitle: rec.subtitle ?? null,
      gstin: String(rec.gstin ?? ''),
      address: String(rec.address ?? ''),
      phone: String(rec.phone ?? ''),
      email: String(rec.email ?? ''),
      logoUrl: rec.logo_url ?? null,
      invoicePrefix: String(rec.invoice_prefix ?? 'INV'),
      state: String(rec.state ?? ''),
      bankDetails: rec.bank_details ?? null,
      syncedAt: new Date(),
    },
    update: {
      storeName: String(rec.store_name ?? ''),
      subtitle: rec.subtitle ?? null,
      gstin: String(rec.gstin ?? ''),
      address: String(rec.address ?? ''),
      phone: String(rec.phone ?? ''),
      email: String(rec.email ?? ''),
      logoUrl: rec.logo_url ?? null,
      invoicePrefix: String(rec.invoice_prefix ?? 'INV'),
      state: String(rec.state ?? ''),
      bankDetails: rec.bank_details ?? null,
      syncedAt: new Date(),
    },
  })
  return result.id
}

async function upsertDamage(rec: any): Promise<number> {
  const result = await db.damage.upsert({
    where: { id: Number(rec.id) },
    create: {
      id: Number(rec.id),
      date: String(rec.date ?? ''),
      productId: Number(rec.product_id ?? 0),
      productSku: String(rec.product_sku ?? ''),
      productName: String(rec.product_name ?? ''),
      hsnCode: String(rec.hsn_code ?? ''),
      bagQty: Number(rec.bag_qty ?? 0),
      pcsQty: Number(rec.pcs_qty ?? 0),
      totalPcs: Number(rec.total_pcs ?? 0),
      reason: String(rec.reason ?? 'Broken'),
      notes: rec.notes ?? null,
      expenseValue: Number(rec.expense_value ?? 0),
      createdAt: rec.created_at ? new Date(rec.created_at) : new Date(),
      syncedAt: new Date(),
    },
    update: { syncedAt: new Date() },
  })
  return result.id
}

async function upsertPurchaseReturn(rec: any): Promise<number> {
  const result = await db.purchaseReturn.upsert({
    where: { id: Number(rec.id) },
    create: {
      id: Number(rec.id),
      date: String(rec.date ?? ''),
      originalPurchaseId: rec.original_purchase_id ?? null,
      returnNo: String(rec.return_no ?? ''),
      supplierName: String(rec.supplier_name ?? ''),
      supplierGstin: rec.supplier_gstin ?? null,
      productId: Number(rec.product_id ?? 0),
      productSku: String(rec.product_sku ?? ''),
      productName: String(rec.product_name ?? ''),
      hsnCode: String(rec.hsn_code ?? ''),
      bagQty: Number(rec.bag_qty ?? 0),
      pcsQty: Number(rec.pcs_qty ?? 0),
      totalPcs: Number(rec.total_pcs ?? 0),
      purchaseRate: Number(rec.purchase_rate ?? 0),
      purchaseRatePerPcs: Number(rec.purchase_rate_per_pcs ?? 0),
      gstPercent: Number(rec.gst_percent ?? 0),
      taxableAmount: Number(rec.taxable_amount ?? 0),
      cgst: Number(rec.cgst ?? 0),
      sgst: Number(rec.sgst ?? 0),
      totalAmount: Number(rec.total_amount ?? 0),
      reason: rec.reason ?? null,
      createdAt: rec.created_at ? new Date(rec.created_at) : new Date(),
      syncedAt: new Date(),
    },
    update: { syncedAt: new Date() },
  })
  return result.id
}

async function upsertSalesReturn(rec: any): Promise<number> {
  const result = await db.salesReturn.upsert({
    where: { id: Number(rec.id) },
    create: {
      id: Number(rec.id),
      date: String(rec.date ?? ''),
      originalSaleId: rec.original_sale_id ?? null,
      returnNo: String(rec.return_no ?? ''),
      customerId: Number(rec.customer_id ?? 0),
      customerName: String(rec.customer_name ?? ''),
      productId: Number(rec.product_id ?? 0),
      productSku: String(rec.product_sku ?? ''),
      productName: String(rec.product_name ?? ''),
      hsnCode: String(rec.hsn_code ?? ''),
      bagQty: Number(rec.bag_qty ?? 0),
      pcsQty: Number(rec.pcs_qty ?? 0),
      totalPcs: Number(rec.total_pcs ?? 0),
      salesRatePerPcs: Number(rec.sales_rate_per_pcs ?? 0),
      gstPercent: Number(rec.gst_percent ?? 0),
      taxableAmount: Number(rec.taxable_amount ?? 0),
      cgst: Number(rec.cgst ?? 0),
      sgst: Number(rec.sgst ?? 0),
      totalAmount: Number(rec.total_amount ?? 0),
      restock: Boolean(rec.restock ?? false),
      reason: rec.reason ?? null,
      createdAt: rec.created_at ? new Date(rec.created_at) : new Date(),
      syncedAt: new Date(),
    },
    update: { syncedAt: new Date() },
  })
  return result.id
}

// ----------------------------------------------------------------------------
// Entity name → upsert function map
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
        errors.push({
          entity: entityName,
          id: rec?.id,
          message: e?.message ?? String(e),
        })
      }
    }
    results[entityName] = { count: ids.length, ids }
  }

  return NextResponse.json({
    success: errors.length === 0,
    results,
    errors,
  } satisfies PushResponse)
}

// ----------------------------------------------------------------------------
// GET handler — health check / list of pending endpoints
// ----------------------------------------------------------------------------

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'FMCG ERP Sync — Push Endpoint',
    version: 5,
    endpoints: Object.keys(UPSERT_HANDLERS),
    usage:
      'POST a { batches: { products: [...], sales: [...] } } payload. ' +
      'All records are upserted by their local Dexie id. Response includes ' +
      'successfully-synced IDs per entity so the client can flip isSynced=true.',
  })
}

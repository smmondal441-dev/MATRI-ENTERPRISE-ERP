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
// Prisma returns BigInt for BigInt columns (CockroachDB BIGINT). JSON.stringify
// cannot serialize BigInt natively — it throws "Do not know how to serialize
// a BigInt". This replacer converts any BigInt to a string so the response
// survives JSON serialization. The client's num() helper then converts it
// back to a JavaScript number via Number(val).
// ----------------------------------------------------------------------------

function bigIntReplacer(_key: string, value: any): any {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
}

export async function GET() {
  try {
    const [
      products,
      customers,
      purchases,
      sales,
      saleItems,
      collections,
      distributorSettings,
      damages,
      purchaseReturns,
      salesReturns,
    ] = await Promise.all([
      db.product.findMany(),
      db.customer.findMany(),
      db.purchase.findMany(),
      db.sale.findMany(),
      db.saleItem.findMany(),
      db.collection.findMany(),
      db.distributorSetting.findMany(),
      db.damage.findMany(),
      db.purchaseReturn.findMany(),
      db.salesReturn.findMany(),
    ])

    // ---- Map server records back to client-side field names ----
    // The server uses camelCase (Prisma convention) with `localId`.
    // The client uses snake_case (Dexie convention) with `id`.
    // We convert back so the client can directly `bulkPut` into IndexedDB.

    const mapProduct = (p: any) => ({
      id: p.localId,
      sku: p.sku,
      company_name: p.companyName,
      name: p.name,
      category: p.category ?? undefined,
      hsn_code: p.hsnCode,
      base_unit: p.baseUnit,
      outer_unit: p.outerUnit,
      conversion_factor: p.conversionFactor,
      pack_size: p.packSize ?? undefined,
      purchase_rate_per_outer_unit: p.purchaseRatePerOuterUnit,
      purchase_rate_per_piece: p.purchaseRatePerPiece,
      selling_rate_per_piece: p.sellingRatePerPiece,
      selling_rate_per_outer_unit: p.sellingRatePerOuterUnit,
      purchase_rate: p.purchaseRate ?? undefined,
      sales_rate: p.salesRate ?? undefined,
      purchase_rate_per_pcs: p.purchaseRatePerPcs ?? undefined,
      sales_rate_per_pcs: p.salesRatePerPcs ?? undefined,
      gst_percent: p.gstPercent,
      opening_stock_pcs: p.openingStockPcs,
      created_at: p.createdAt?.toISOString() ?? new Date().toISOString(),
      isSynced: true,
      synced_at: p.syncedAt?.toISOString() ?? null,
    })

    const mapCustomer = (c: any) => ({
      id: c.localId,
      customer_id: c.customerId,
      name: c.name,
      route_area: c.routeArea,
      phone: c.phone,
      gstin: c.gstin ?? undefined,
      opening_balance: c.openingBalance,
      bill_number: c.billNumber ?? undefined,
      created_at: c.createdAt?.toISOString() ?? new Date().toISOString(),
      isSynced: true,
      synced_at: c.syncedAt?.toISOString() ?? null,
    })

    const mapPurchase = (p: any) => ({
      id: p.localId,
      bill_no: p.billNo,
      date: p.date,
      supplier_name: p.supplierName,
      supplier_gstin: p.supplierGstin ?? undefined,
      product_id: p.productId,
      product_sku: p.productSku,
      product_name: p.productName,
      hsn_code: p.hsnCode,
      bag_qty: p.bagQty,
      pcs_qty: p.pcsQty,
      total_pcs: p.totalPcs,
      purchase_rate: p.purchaseRate,
      gst_percent: p.gstPercent,
      taxable_amount: p.taxableAmount,
      cgst: p.cgst,
      sgst: p.sgst,
      total_amount: p.totalAmount,
      mfg_date: p.mfgDate ?? undefined,
      expiry_date: p.expiryDate ?? undefined,
      created_at: p.createdAt?.toISOString() ?? new Date().toISOString(),
      isSynced: true,
      synced_at: p.syncedAt?.toISOString() ?? null,
    })

    const mapSale = (s: any) => ({
      id: s.localId,
      invoice_no: s.invoiceNo,
      date: s.date,
      customer_id: s.customerId,
      customer_name: s.customerName,
      payment_mode: s.paymentMode,
      subtotal: s.subtotal,
      cgst: s.cgst,
      sgst: s.sgst,
      total_amount: s.totalAmount,
      total_profit: s.totalProfit,
      total_margin_percent: s.totalMarginPercent,
      paid_amount: s.paidAmount,
      created_at: s.createdAt?.toISOString() ?? new Date().toISOString(),
      isSynced: true,
      synced_at: s.syncedAt?.toISOString() ?? null,
    })

    const mapSaleItem = (si: any) => ({
      id: si.localId,
      sale_id: si.saleLocalId,
      product_id: si.productId,
      product_name: si.productName,
      product_sku: si.productSku,
      hsn_code: si.hsnCode,
      quantity_pcs: si.quantityPcs,
      rate: si.rate,
      gst_percent: si.gstPercent,
      taxable_amount: si.taxableAmount,
      cgst: si.cgst,
      sgst: si.sgst,
      total: si.total,
      purchase_rate: si.purchaseRate,
      item_profit: si.itemProfit,
      item_margin_percent: si.itemMarginPercent,
      created_at: si.createdAt?.toISOString() ?? new Date().toISOString(),
      isSynced: true,
      synced_at: si.syncedAt?.toISOString() ?? null,
    })

    const mapCollection = (c: any) => ({
      id: c.localId,
      date: c.date,
      customer_id: c.customerId,
      customer_name: c.customerName,
      amount: c.amount,
      payment_mode: c.paymentMode,
      notes: c.notes ?? undefined,
      created_at: c.createdAt?.toISOString() ?? new Date().toISOString(),
      isSynced: true,
      synced_at: c.syncedAt?.toISOString() ?? null,
    })

    const mapDistributorSetting = (d: any) => ({
      id: d.localId,
      store_name: d.storeName,
      subtitle: d.subtitle ?? undefined,
      gstin: d.gstin,
      address: d.address,
      phone: d.phone,
      email: d.email,
      logo_url: d.logoUrl ?? undefined,
      invoice_prefix: d.invoicePrefix,
      state: d.state,
      bank_details: d.bankDetails ?? undefined,
      isSynced: true,
      synced_at: d.syncedAt?.toISOString() ?? null,
    })

    const mapDamage = (d: any) => ({
      id: d.localId,
      date: d.date,
      product_id: d.productId,
      product_sku: d.productSku,
      product_name: d.productName,
      hsn_code: d.hsnCode,
      bag_qty: d.bagQty,
      pcs_qty: d.pcsQty,
      total_pcs: d.totalPcs,
      reason: d.reason,
      notes: d.notes ?? undefined,
      expense_value: d.expenseValue,
      created_at: d.createdAt?.toISOString() ?? new Date().toISOString(),
      isSynced: true,
      synced_at: d.syncedAt?.toISOString() ?? null,
    })

    const mapPurchaseReturn = (r: any) => ({
      id: r.localId,
      date: r.date,
      original_purchase_id: r.originalPurchaseId ?? undefined,
      return_no: r.returnNo,
      supplier_name: r.supplierName,
      supplier_gstin: r.supplierGstin ?? undefined,
      product_id: r.productId,
      product_sku: r.productSku,
      product_name: r.productName,
      hsn_code: r.hsnCode,
      bag_qty: r.bagQty,
      pcs_qty: r.pcsQty,
      total_pcs: r.totalPcs,
      purchase_rate: r.purchaseRate,
      purchase_rate_per_pcs: r.purchaseRatePerPcs,
      gst_percent: r.gstPercent,
      taxable_amount: r.taxableAmount,
      cgst: r.cgst,
      sgst: r.sgst,
      total_amount: r.totalAmount,
      reason: r.reason ?? undefined,
      created_at: r.createdAt?.toISOString() ?? new Date().toISOString(),
      isSynced: true,
      synced_at: r.syncedAt?.toISOString() ?? null,
    })

    const mapSalesReturn = (r: any) => ({
      id: r.localId,
      date: r.date,
      original_sale_id: r.originalSaleId ?? undefined,
      return_no: r.returnNo,
      customer_id: r.customerId,
      customer_name: r.customerName,
      product_id: r.productId,
      product_sku: r.productSku,
      product_name: r.productName,
      hsn_code: r.hsnCode,
      bag_qty: r.bagQty,
      pcs_qty: r.pcsQty,
      total_pcs: r.totalPcs,
      sales_rate_per_pcs: r.salesRatePerPcs,
      gst_percent: r.gstPercent,
      taxable_amount: r.taxableAmount,
      cgst: r.cgst,
      sgst: r.sgst,
      total_amount: r.totalAmount,
      restock: r.restock,
      reason: r.reason ?? undefined,
      created_at: r.createdAt?.toISOString() ?? new Date().toISOString(),
      isSynced: true,
      synced_at: r.syncedAt?.toISOString() ?? null,
    })

    const totalRecords =
      products.length + customers.length + purchases.length +
      sales.length + saleItems.length + collections.length +
      distributorSettings.length + damages.length +
      purchaseReturns.length + salesReturns.length

    console.log(`[sync/pull] Returning ${totalRecords} records from CockroachDB`)

    // Use BigInt-safe JSON serialization — Prisma may return BigInt values
    // from BigInt columns (CockroachDB BIGINT), which JSON.stringify cannot
    // handle natively. The bigIntReplacer converts BigInt → string.
    const responseBody = {
      ok: true,
      pulledAt: new Date().toISOString(),
      totalRecords,
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
  } catch (e: any) {
    console.error('[sync/pull] Database error:', {
      message: e?.message,
      code: e?.code,
      meta: e?.meta,
    })

    return NextResponse.json(
      {
        ok: false,
        pulledAt: new Date().toISOString(),
        error: e?.message ?? 'Database connection failed',
        hint:
          'CockroachDB/PostgreSQL backend is unreachable. The app will ' +
          'fall back to local seed data. Once the backend is available, ' +
          'records will sync automatically.',
      },
      { status: 503 }
    )
  }
}

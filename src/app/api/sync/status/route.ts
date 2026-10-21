// ============================================================================
// GET /api/sync/status
// ----------------------------------------------------------------------------
// Returns server-side counts per entity so the client can compare with its
// local DB and verify that all records have been pushed.
//
// Response:
//   {
//     "ok": true,
//     "counts": {
//       "products": 5,
//       "customers": 4,
//       "purchases": 12,
//       ...
//     },
//     "serverTime": "2026-10-19T15:30:00.000Z"
//   }
//
// If DATABASE_URL is not configured or the connection fails, returns 503
// with a clear error message — the offline ERP continues to work normally.
// ============================================================================

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [
      products, customers, purchases, sales, saleItems,
      collections, distributorSettings, damages, purchaseReturns, salesReturns,
    ] = await Promise.all([
      db.product.count(),
      db.customer.count(),
      db.purchase.count(),
      db.sale.count(),
      db.saleItem.count(),
      db.collection.count(),
      db.distributorSetting.count(),
      db.damage.count(),
      db.purchaseReturn.count(),
      db.salesReturn.count(),
    ])

    return NextResponse.json({
      ok: true,
      serverTime: new Date().toISOString(),
      counts: {
        products,
        customers,
        purchases,
        sales,
        sale_items: saleItems,
        collections,
        distributor_settings: distributorSettings,
        damages,
        purchase_returns: purchaseReturns,
        sales_returns: salesReturns,
      },
    })
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        serverTime: new Date().toISOString(),
        error: e?.message ?? 'Database connection failed',
        hint:
          'PostgreSQL backend is unreachable. The offline ERP continues to work — ' +
          'records will be queued locally (isSynced=false) and pushed once the ' +
          'backend is available.',
      },
      { status: 503 }
    )
  }
}

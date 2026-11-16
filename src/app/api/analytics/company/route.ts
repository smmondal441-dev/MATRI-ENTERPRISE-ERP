// ============================================================================
// GET /api/analytics/company?month=YYYY-MM&company=Parle Products
// ----------------------------------------------------------------------------
// Company-wise analytics dashboard backed by Pure Vanilla JavaScript.
//
// Query Parameters:
//   month    : YYYY-MM format (default: current month). Filters Purchases by
//              their `date` field and SaleItems by their parent Sale's `date`.
//              If omitted, returns ALL-TIME data.
//   company  : Company name to filter by (default: "All"). When set, only
//              that company's row is returned + summary recalculated for it.
//
// Key design: the base list of companies comes from the Product table. EVERY
// company that exists in the Product table appears in the response — even if
// it has 0 purchases and 0 sales for the selected month. This ensures newly
// added companies (like "Dukes") always show up.
// ============================================================================

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

function bigIntReplacer(_key: string, value: any): any {
  if (typeof value === 'bigint') return Number(value)
  return value
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const monthParam = url.searchParams.get('month') // "2024-10" or null
    const companyFilter = url.searchParams.get('company') // company name or null/"All"

    // ---- 1. Fetch ALL active products (base list of companies) ----
    // This is the source of truth for the company list. Every company that
    // exists in the Product table will appear in the response, even with 0s.
    const products = await db.product.findMany({
      where: { isDeleted: false },
    })

    // ---- 2. Build productId → company_name lookup + base company set ----
    const productCompanyMap = new Map<string, string>()
    const baseCompanySet = new Set<string>()

    for (const p of products) {
      const company = p.companyName || 'Unknown'
      productCompanyMap.set(String(p.localId), company)
      baseCompanySet.add(company)
    }

    // ---- 3. Determine the date filter ----
    // monthParam = "2024-10" → filter records where date starts with "2024-10"
    // The `date` field on Purchase and Sale is a String "YYYY-MM-DD".
    // SaleItem has no date — we join via SaleItem.saleLocalId → Sale.localId
    // to get the Sale.date, then filter.
    const monthPrefix = monthParam ? monthParam.slice(0, 7) : null // "YYYY-MM"

    // ---- 4. Fetch purchases (filtered by month if specified) ----
    let purchases: any[]
    if (monthPrefix) {
      // Purchase.date is "YYYY-MM-DD" — filter with startsWith
      purchases = await db.purchase.findMany({
        where: {
          isDeleted: false,
          date: { startsWith: monthPrefix },
        },
      })
    } else {
      purchases = await db.purchase.findMany({
        where: { isDeleted: false },
      })
    }

    // ---- 5. Fetch sales + sale_items (filtered by month) ----
    // SaleItem doesn't have its own date. We fetch Sales filtered by date,
    // build a set of valid saleLocalIds, then fetch SaleItems whose
    // saleLocalId is in that set.
    let saleItems: any[]

    if (monthPrefix) {
      const sales = await db.sale.findMany({
        where: {
          isDeleted: false,
          date: { startsWith: monthPrefix },
        },
        select: { localId: true },
      })
      const validSaleLocalIds = new Set(sales.map((s) => String(s.localId)))

      // Fetch all non-deleted sale_items and filter in JS by saleLocalId
      // (Prisma doesn't support "where saleLocalId IN [list]" with BigInt
      // natively, so we fetch all and filter — the data volume is small).
      const allSaleItems = await db.saleItem.findMany({
        where: { isDeleted: false },
      })
      saleItems = allSaleItems.filter((si) =>
        validSaleLocalIds.has(String(si.saleLocalId))
      )
    } else {
      saleItems = await db.saleItem.findMany({
        where: { isDeleted: false },
      })
    }

    console.log('[analytics/company] filtered data:', {
      month: monthPrefix ?? 'all-time',
      company: companyFilter ?? 'all',
      products: products.length,
      purchases: purchases.length,
      saleItems: saleItems.length,
      baseCompanies: baseCompanySet.size,
    })

    // ---- 6. Aggregate purchases by company ----
    const purchaseAgg = new Map<
      string,
      { bought_pcs: number; purchase_value: number }
    >()

    for (const pu of purchases) {
      const company = productCompanyMap.get(String(pu.productId)) ?? 'Unknown'
      const existing = purchaseAgg.get(company) ?? {
        bought_pcs: 0,
        purchase_value: 0,
      }
      existing.bought_pcs += pu.totalPcs ?? 0
      existing.purchase_value += pu.totalAmount ?? 0
      purchaseAgg.set(company, existing)
    }

    // ---- 7. Aggregate sales by company ----
    const salesAgg = new Map<
      string,
      { sold_pcs: number; sales_value: number; gross_profit: number }
    >()

    for (const si of saleItems) {
      const company = productCompanyMap.get(String(si.productId)) ?? 'Unknown'
      const existing = salesAgg.get(company) ?? {
        sold_pcs: 0,
        sales_value: 0,
        gross_profit: 0,
      }
      existing.sold_pcs += si.quantityPcs ?? 0
      existing.sales_value += si.total ?? 0
      existing.gross_profit += si.itemProfit ?? 0
      salesAgg.set(company, existing)
    }

    // ---- 8. Merge — iterate ALL base companies (from Product table) ----
    // This ensures companies with 0 purchases and 0 sales still appear.
    const companies: any[] = []
    let totalDeadStockValue = 0
    let totalGrossProfit = 0
    let totalPurchaseValue = 0

    for (const company of baseCompanySet) {
      const purch = purchaseAgg.get(company) ?? {
        bought_pcs: 0,
        purchase_value: 0,
      }
      const sales = salesAgg.get(company) ?? {
        sold_pcs: 0,
        sales_value: 0,
        gross_profit: 0,
      }

      const deadStockPcs = purch.bought_pcs - sales.sold_pcs
      const avgCostPerPiece =
        purch.bought_pcs > 0
          ? purch.purchase_value / purch.bought_pcs
          : 0
      const deadStockValue = deadStockPcs * avgCostPerPiece
      const profitPercent =
        purch.purchase_value > 0
          ? (sales.gross_profit / purch.purchase_value) * 100
          : 0

      companies.push({
        company_name: company,
        bought_pcs: String(Math.round(purch.bought_pcs)),
        purchase_value: purch.purchase_value,
        sold_pcs: String(Math.round(sales.sold_pcs)),
        sales_value: sales.sales_value,
        gross_profit: sales.gross_profit,
        dead_stock_pcs: String(Math.round(deadStockPcs)),
        dead_stock_value: deadStockValue,
        profit_percent: profitPercent,
      })

      totalDeadStockValue += deadStockValue
      totalGrossProfit += sales.gross_profit
      totalPurchaseValue += purch.purchase_value
    }

    // ---- 9. Sort by sales_value descending ----
    companies.sort((a, b) => b.sales_value - a.sales_value)

    // ---- 10. Apply company filter (if not "All") ----
    let filteredCompanies = companies
    if (companyFilter && companyFilter !== 'All') {
      filteredCompanies = companies.filter(
        (c) => c.company_name === companyFilter
      )
      // Recalculate summary for ONLY this company
      totalDeadStockValue = filteredCompanies.reduce(
        (s, c) => s + c.dead_stock_value,
        0
      )
      totalGrossProfit = filteredCompanies.reduce(
        (s, c) => s + c.gross_profit,
        0
      )
      totalPurchaseValue = filteredCompanies.reduce(
        (s, c) => s + c.purchase_value,
        0
      )
    }

    // ---- 11. Build summary ----
    const topCompany =
      filteredCompanies.length > 0
        ? {
            name: filteredCompanies[0].company_name,
            sales_value: filteredCompanies[0].sales_value,
            profit_percent: filteredCompanies[0].profit_percent,
          }
        : null

    const responseBody = {
      ok: true,
      month: monthPrefix ?? 'all-time',
      company: companyFilter ?? 'All',
      // Always return ALL companies (sorted) so the dropdown stays populated.
      // The UI can highlight the filtered one.
      allCompanies: Array.from(baseCompanySet).sort(),
      companies: filteredCompanies,
      summary: {
        topCompany,
        totalDeadStockValue,
        totalGrossProfit,
        avgProfitPercent:
          totalPurchaseValue > 0
            ? (totalGrossProfit / totalPurchaseValue) * 100
            : 0,
        totalCompanies: filteredCompanies.length,
      },
    }

    return new NextResponse(JSON.stringify(responseBody, bigIntReplacer), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    console.error('[analytics/company] Error:', e?.message ?? e)
    return NextResponse.json(
      {
        ok: false,
        error: e?.message ?? 'Analytics aggregation failed',
        companies: [],
        allCompanies: [],
        summary: null,
      },
      { status: 500 }
    )
  }
}

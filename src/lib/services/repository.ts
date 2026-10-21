// ============================================================================
// Repository layer (Hexagonal core)
// UI plugins (Billing, Inventory, GST Reports, Collections, etc.) consume these
// services. Adding / modifying UI features does NOT require altering this layer.
// ----------------------------------------------------------------------------
// v5 — Hybrid sync: every create/update now writes `isSynced: false` and then
// schedules a background SyncService.push (if navigator.onLine). Deletes are
// not propagated to the backend yet (TODO); they leave a tombstone locally.
// ============================================================================

import { db } from '@/lib/db/dexie'
import { scheduleSync } from '@/lib/services/sync'
import type {
  Product,
  Customer,
  Purchase,
  Sale,
  SaleItem,
  Collection,
  DistributorSettings,
  Damage,
  PurchaseReturn,
  SalesReturn,
  DamageReason,
} from '@/lib/db/dexie'

// ----------------------------------------------------------------------------
// Helpers — per-piece rate computation (v4 model)
// ----------------------------------------------------------------------------
// Inputs:
//   purchase_rate_per_outer_unit (e.g. ₹600 per Bag)        ← user input
//   selling_rate_per_piece       (e.g. ₹3.50 per Pcs)       ← user input (primary)
//
// Auto-computed:
//   purchase_rate_per_piece      = purchase_rate_per_outer_unit / conversion_factor
//   selling_rate_per_outer_unit  = selling_rate_per_piece * conversion_factor
// ----------------------------------------------------------------------------

/**
 * purchase_rate_per_piece = purchase_rate_per_outer_unit / conversion_factor
 * e.g. ₹600 per Bag of 200 Pcs → ₹3.00 per Pcs.
 */
export function computePurchaseRatePerPiece(
  purchaseRatePerOuterUnit: number,
  conversionFactor: number
): number {
  const cf = Number(conversionFactor) || 1
  if (cf <= 0) return Number(purchaseRatePerOuterUnit) || 0
  return (Number(purchaseRatePerOuterUnit) || 0) / cf
}

/**
 * selling_rate_per_outer_unit = selling_rate_per_piece * conversion_factor
 * e.g. ₹3.50 per Pcs × 200 Pcs/Bag → ₹700.00 per Bag.
 */
export function computeSellingRatePerOuterUnit(
  sellingRatePerPiece: number,
  conversionFactor: number
): number {
  const cf = Number(conversionFactor) || 1
  return (Number(sellingRatePerPiece) || 0) * cf
}

/**
 * Read the per-piece purchase rate from a Product row.
 * Prefers the v4 persisted `purchase_rate_per_piece`; falls back to legacy
 * `purchase_rate_per_pcs`, then to on-the-fly computation from
 * `purchase_rate_per_outer_unit` (or legacy `purchase_rate`) ÷ conversion_factor.
 */
export function getPurchaseRatePerPiece(p: Product): number {
  if (typeof p.purchase_rate_per_piece === 'number' && p.purchase_rate_per_piece > 0) {
    return p.purchase_rate_per_piece
  }
  if (typeof p.purchase_rate_per_pcs === 'number' && p.purchase_rate_per_pcs > 0) {
    return p.purchase_rate_per_pcs
  }
  const outer =
    (typeof p.purchase_rate_per_outer_unit === 'number'
      ? p.purchase_rate_per_outer_unit
      : 0) || p.purchase_rate || 0
  return computePurchaseRatePerPiece(outer, p.conversion_factor)
}

/**
 * Read the per-piece selling rate from a Product row.
 * Prefers the v4 persisted `selling_rate_per_piece`; falls back to legacy
 * `sales_rate_per_pcs`, then to on-the-fly computation from legacy
 * `sales_rate` (per outer) ÷ conversion-factor (handles pre-v4 rows).
 */
export function getSellingRatePerPiece(p: Product): number {
  if (typeof p.selling_rate_per_piece === 'number' && p.selling_rate_per_piece > 0) {
    return p.selling_rate_per_piece
  }
  if (typeof p.sales_rate_per_pcs === 'number' && p.sales_rate_per_pcs > 0) {
    return p.sales_rate_per_pcs
  }
  // Legacy fallback: derive per-piece from per-outer sales_rate
  const cf = Number(p.conversion_factor) || 1
  const outerSales = (typeof p.selling_rate_per_outer_unit === 'number'
    ? p.selling_rate_per_outer_unit
    : 0) || p.sales_rate || 0
  return cf > 0 ? outerSales / cf : outerSales
}

/**
 * Read the per-outer-unit purchase rate from a Product row.
 */
export function getPurchaseRatePerOuterUnit(p: Product): number {
  if (typeof p.purchase_rate_per_outer_unit === 'number') {
    return p.purchase_rate_per_outer_unit
  }
  return p.purchase_rate || 0
}

/**
 * Read the per-outer-unit selling rate from a Product row.
 * Prefers v4 persisted value; falls back to computing from per-piece × cf.
 */
export function getSellingRatePerOuterUnit(p: Product): number {
  if (typeof p.selling_rate_per_outer_unit === 'number' && p.selling_rate_per_outer_unit > 0) {
    return p.selling_rate_per_outer_unit
  }
  if (p.sales_rate && p.sales_rate > 0) {
    return p.sales_rate
  }
  return computeSellingRatePerOuterUnit(getSellingRatePerPiece(p), p.conversion_factor)
}

/**
 * Real-time per-piece profit margin = selling_rate_per_piece − purchase_rate_per_piece
 * (excludes GST). Used by POS line items for live display.
 */
export function getProfitPerPiece(p: Product): number {
  return getSellingRatePerPiece(p) - getPurchaseRatePerPiece(p)
}

/**
 * Per-piece profit margin as a percentage of selling rate.
 */
export function getMarginPercentPerPiece(p: Product): number {
  const sp = getSellingRatePerPiece(p)
  if (sp <= 0) return 0
  return (getProfitPerPiece(p) / sp) * 100
}

// ----------------------------------------------------------------------------
// Legacy aliases (kept so existing imports don't break)
// ----------------------------------------------------------------------------

/** @deprecated use computePurchaseRatePerPiece */
export const computePurchaseRatePerPcs = computePurchaseRatePerPiece

/** @deprecated use getPurchaseRatePerPiece */
export const getPurchaseRatePerPcs = getPurchaseRatePerPiece

/** @deprecated use getSellingRatePerPiece */
export const getSalesRatePerPcs = getSellingRatePerPiece

/** @deprecated retained for legacy callers — computes per-Pcs selling rate
 *  from a per-outer rate. New code should use getSellingRatePerPiece instead. */
export function computeSalesRatePerPcs(
  salesRate: number,
  conversionFactor: number
): number {
  const cf = Number(conversionFactor) || 1
  return cf > 0 ? (Number(salesRate) || 0) / cf : Number(salesRate) || 0
}

// ----------------------------------------------------------------------------
// Product services
// ----------------------------------------------------------------------------

export const ProductService = {
  async all(): Promise<Product[]> {
    return db.products.orderBy('created_at').reverse().toArray()
  },

  async get(id: number): Promise<Product | undefined> {
    return db.products.get(id)
  },

  /**
   * Persist a new product using the v4 per-piece pricing model.
   *
   * USER INPUTS (primary):
   *   - purchase_rate_per_outer_unit  (per Bag/Peti — total buying price)
   *   - selling_rate_per_piece         (per Pcs — default selling rate)
   *
   * AUTO-COMPUTED & PERSISTED:
   *   - purchase_rate_per_piece        = purchase_rate_per_outer_unit / conversion_factor
   *   - selling_rate_per_outer_unit    = selling_rate_per_piece * conversion_factor
   *
   * Legacy aliases (`purchase_rate`, `sales_rate`, `*_per_pcs`) are also written
   * so older UI code continues to work after a DB read.
   */
  async create(p: Omit<Product, 'id' | 'created_at'>): Promise<number> {
    const cf = Number(p.conversion_factor) || 1
    const purchaseRatePerOuterUnit =
      Number(p.purchase_rate_per_outer_unit ?? p.purchase_rate ?? 0) || 0
    const sellingRatePerPiece =
      Number(p.selling_rate_per_piece ?? p.sales_rate_per_pcs ?? 0) || 0
    const purchaseRatePerPiece = computePurchaseRatePerPiece(purchaseRatePerOuterUnit, cf)
    const sellingRatePerOuterUnit = computeSellingRatePerOuterUnit(sellingRatePerPiece, cf)

    const payload: Product = {
      ...p,
      conversion_factor: cf,
      // v4 canonical fields
      purchase_rate_per_outer_unit: purchaseRatePerOuterUnit,
      purchase_rate_per_piece: purchaseRatePerPiece,
      selling_rate_per_piece: sellingRatePerPiece,
      selling_rate_per_outer_unit: sellingRatePerOuterUnit,
      // Legacy aliases (kept in sync so older code paths still resolve)
      purchase_rate: purchaseRatePerOuterUnit,
      sales_rate: sellingRatePerOuterUnit,
      purchase_rate_per_pcs: purchaseRatePerPiece,
      sales_rate_per_pcs: sellingRatePerPiece,
      created_at: new Date().toISOString(),
      // v5 — mark as un-synced; SyncService will flip this once pushed to PostgreSQL
      isSynced: false,
      synced_at: null,
    }
    const id = await db.products.add(payload)
    scheduleSync('products')
    return id
  },

  async update(id: number, p: Partial<Product>): Promise<number> {
    const patch: Partial<Product> = { ...p }
    // Recompute the auto-derived rate fields whenever any of the source
    // inputs (purchase_rate_per_outer_unit, selling_rate_per_piece,
    // conversion_factor) change.
    const triggersRateRecompute =
      p.purchase_rate_per_outer_unit !== undefined ||
      p.purchase_rate !== undefined ||
      p.selling_rate_per_piece !== undefined ||
      p.sales_rate_per_pcs !== undefined ||
      p.sales_rate !== undefined ||
      p.conversion_factor !== undefined

    if (triggersRateRecompute) {
      const existing = await db.products.get(id)
      const cf = Number(p.conversion_factor ?? existing?.conversion_factor ?? 1) || 1
      // Resolve the two primary inputs (with fallback to existing/legacy values)
      const purchaseRatePerOuterUnit = Number(
        p.purchase_rate_per_outer_unit ??
          (p.purchase_rate !== undefined ? p.purchase_rate : existing?.purchase_rate_per_outer_unit) ??
          existing?.purchase_rate ??
          0
      ) || 0
      const sellingRatePerPiece = Number(
        p.selling_rate_per_piece ??
          (p.sales_rate_per_pcs !== undefined ? p.sales_rate_per_pcs : existing?.selling_rate_per_piece) ??
          existing?.sales_rate_per_pcs ??
          0
      ) || 0

      // If only the legacy `sales_rate` (per outer) was updated, derive
      // selling_rate_per_piece from it.
      let resolvedSellingPerPiece = sellingRatePerPiece
      if (
        sellingRatePerPiece === 0 &&
        (p.sales_rate !== undefined || p.selling_rate_per_outer_unit !== undefined)
      ) {
        const outerSelling = Number(
          p.selling_rate_per_outer_unit ?? p.sales_rate ?? existing?.selling_rate_per_outer_unit ?? existing?.sales_rate ?? 0
        ) || 0
        resolvedSellingPerPiece = cf > 0 ? outerSelling / cf : outerSelling
      }

      const purchaseRatePerPiece = computePurchaseRatePerPiece(purchaseRatePerOuterUnit, cf)
      const sellingRatePerOuterUnit = computeSellingRatePerOuterUnit(resolvedSellingPerPiece, cf)

      patch.conversion_factor = cf
      patch.purchase_rate_per_outer_unit = purchaseRatePerOuterUnit
      patch.purchase_rate_per_piece = purchaseRatePerPiece
      patch.selling_rate_per_piece = resolvedSellingPerPiece
      patch.selling_rate_per_outer_unit = sellingRatePerOuterUnit
      // Legacy aliases kept in sync
      patch.purchase_rate = purchaseRatePerOuterUnit
      patch.sales_rate = sellingRatePerOuterUnit
      patch.purchase_rate_per_pcs = purchaseRatePerPiece
      patch.sales_rate_per_pcs = resolvedSellingPerPiece
    }
    // v5 — any update marks the record as un-synced; SyncService will re-push it.
    patch.isSynced = false
    patch.synced_at = null
    await db.products.update(id, patch)
    scheduleSync('products')
    return id
  },

  async remove(id: number): Promise<void> {
    await db.products.delete(id)
    // Note: deletion is not currently propagated to the PostgreSQL backend.
    // Local-only delete is sufficient for now — the next sync will re-push
    // the surviving records, and the deleted row will simply not appear.
  },

  async search(query: string): Promise<Product[]> {
    const q = query.trim().toLowerCase()
    if (!q) return this.all()
    const all = await this.all()
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.company_name.toLowerCase().includes(q) ||
        p.hsn_code.toLowerCase().includes(q)
    )
  },
}

// ----------------------------------------------------------------------------
// Customer services
// ----------------------------------------------------------------------------

export const CustomerService = {
  async all(): Promise<Customer[]> {
    return db.customers.orderBy('created_at').reverse().toArray()
  },

  async get(id: number): Promise<Customer | undefined> {
    return db.customers.get(id)
  },

  async create(c: Omit<Customer, 'id' | 'created_at'>): Promise<number> {
    const id = await db.customers.add({
      ...c,
      created_at: new Date().toISOString(),
      isSynced: false,
      synced_at: null,
    })
    scheduleSync('customers')
    return id
  },

  async update(id: number, c: Partial<Customer>): Promise<number> {
    await db.customers.update(id, {
      ...c,
      isSynced: false,
      synced_at: null,
    })
    scheduleSync('customers')
    return id
  },

  async remove(id: number): Promise<void> {
    await db.customers.delete(id)
  },

  async nextCustomerId(): Promise<string> {
    const count = await db.customers.count()
    return `CUST-${String(count + 1).padStart(4, '0')}`
  },
}

// ----------------------------------------------------------------------------
// Purchase services — writes purchase record + adjusts product stock
// ----------------------------------------------------------------------------

export const PurchaseService = {
  async all(): Promise<Purchase[]> {
    return db.purchases.orderBy('created_at').reverse().toArray()
  },

  async create(p: Omit<Purchase, 'id' | 'created_at'>): Promise<number> {
    // Add purchase + bump opening stock on the product, all in one transaction.
    const id = await db.transaction('rw', db.purchases, db.products, async () => {
      const purchaseId = await db.purchases.add({
        ...p,
        created_at: new Date().toISOString(),
        isSynced: false,
        synced_at: null,
      })
      const prod = await db.products.get(p.product_id)
      if (prod) {
        await db.products.update(p.product_id, {
          opening_stock_pcs: prod.opening_stock_pcs + p.total_pcs,
          // v5 — product stock changed → mark un-synced so the backend gets the latest count
          isSynced: false,
          synced_at: null,
        })
      }
      return purchaseId
    })
    scheduleSync('purchases')
    return id
  },

  async remove(id: number): Promise<void> {
    const purchase = await db.purchases.get(id)
    if (!purchase) return
    await db.transaction('rw', db.purchases, db.products, async () => {
      const prod = await db.products.get(purchase.product_id)
      if (prod) {
        await db.products.update(purchase.product_id, {
          opening_stock_pcs: Math.max(0, prod.opening_stock_pcs - purchase.total_pcs),
          isSynced: false,
          synced_at: null,
        })
      }
      await db.purchases.delete(id)
    })
    scheduleSync('products')
  },
}

// ----------------------------------------------------------------------------
// Sales services — atomic transaction: sale + sale_items + stock decrement
// ----------------------------------------------------------------------------

export interface SaleDraftItem {
  product_id: number
  product_name: string
  product_sku: string
  hsn_code: string
  quantity_pcs: number
  rate: number
  gst_percent: number
  taxable_amount: number
  cgst: number
  sgst: number
  total: number
  purchase_rate: number
  item_profit: number
  item_margin_percent: number
}

export interface SaleDraft {
  invoice_no: string
  date: string
  customer_id: number
  customer_name: string
  payment_mode: 'Cash' | 'Credit'
  subtotal: number
  cgst: number
  sgst: number
  total_amount: number
  total_profit: number
  total_margin_percent: number
  items: SaleDraftItem[]
}

export const SaleService = {
  async all(): Promise<Sale[]> {
    return db.sales.orderBy('created_at').reverse().toArray()
  },

  async get(id: number): Promise<{ sale: Sale; items: SaleItem[] } | undefined> {
    const sale = await db.sales.get(id)
    if (!sale) return undefined
    const items = await db.sale_items.where('sale_id').equals(id).toArray()
    return { sale, items }
  },

  async itemsBySale(saleId: number): Promise<SaleItem[]> {
    return db.sale_items.where('sale_id').equals(saleId).toArray()
  },

  async create(draft: SaleDraft): Promise<number> {
    const saleId = await db.transaction('rw', db.sales, db.sale_items, db.products, async () => {
      const saleId = await db.sales.add({
        invoice_no: draft.invoice_no,
        date: draft.date,
        customer_id: draft.customer_id,
        customer_name: draft.customer_name,
        payment_mode: draft.payment_mode,
        subtotal: draft.subtotal,
        cgst: draft.cgst,
        sgst: draft.sgst,
        total_amount: draft.total_amount,
        total_profit: draft.total_profit,
        total_margin_percent: draft.total_margin_percent,
        paid_amount: draft.payment_mode === 'Cash' ? draft.total_amount : 0,
        created_at: new Date().toISOString(),
        // v5 — new sale is un-synced
        isSynced: false,
        synced_at: null,
      })

      for (const it of draft.items) {
        await db.sale_items.add({
          ...it,
          sale_id: saleId as number,
          // v5 — each line item is also marked un-synced
          isSynced: false,
          synced_at: null,
        })
        // Decrement product stock + flag product as un-synced
        const prod = await db.products.get(it.product_id)
        if (prod) {
          await db.products.update(it.product_id, {
            opening_stock_pcs: Math.max(0, prod.opening_stock_pcs - it.quantity_pcs),
            isSynced: false,
            synced_at: null,
          })
        }
      }
      return saleId as number
    })
    // After the local transaction commits, schedule a background sync.
    scheduleSync('sales')
    return saleId
  },

  async nextInvoiceNo(prefix = 'INV'): Promise<string> {
    const count = await db.sales.count()
    const year = new Date().getFullYear()
    return `${prefix}-${year}-${String(count + 1).padStart(4, '0')}`
  },

  async remove(id: number): Promise<void> {
    await db.transaction('rw', db.sales, db.sale_items, async () => {
      await db.sale_items.where('sale_id').equals(id).delete()
      await db.sales.delete(id)
    })
    scheduleSync('sales')
  },
}

// ----------------------------------------------------------------------------
// Collection services — records customer payment, no balance mutation needed
// (balance is derived: opening + sales-credit - collections)
// ----------------------------------------------------------------------------

export const CollectionService = {
  async all(): Promise<Collection[]> {
    return db.collections.orderBy('created_at').reverse().toArray()
  },

  async byCustomer(customerId: number): Promise<Collection[]> {
    return db.collections.where('customer_id').equals(customerId).toArray()
  },

  async create(c: Omit<Collection, 'id' | 'created_at'>): Promise<number> {
    const id = await db.collections.add({
      ...c,
      created_at: new Date().toISOString(),
      isSynced: false,
      synced_at: null,
    })
    scheduleSync('collections')
    return id
  },

  async remove(id: number): Promise<void> {
    await db.collections.delete(id)
  },
}

// ----------------------------------------------------------------------------
// Inventory services — derived real-time stock ledger
// Includes movements from: opening + purchases − sales − damages
//                                            − purchase_returns + sales_returns(restock)
// ----------------------------------------------------------------------------

export interface InventoryRow {
  product: Product
  opening_stock_pcs: number
  purchased_pcs: number
  sold_pcs: number
  damaged_pcs: number
  purchase_returned_pcs: number
  sales_returned_pcs: number // only restock=true entries
  closing_pcs: number
  closing_bags: number
  bag_value: number
}

export const InventoryService = {
  async all(): Promise<InventoryRow[]> {
    const products = await db.products.toArray()
    const purchases = await db.purchases.toArray()
    const saleItems = await db.sale_items.toArray()
    const damages = await db.damages.toArray()
    const purchaseReturns = await db.purchase_returns.toArray()
    const salesReturns = await db.sales_returns.toArray()

    return products.map((p) => {
      const purchased = purchases
        .filter((pu) => pu.product_id === p.id)
        .reduce((s, pu) => s + pu.total_pcs, 0)
      const sold = saleItems
        .filter((si) => si.product_id === p.id)
        .reduce((s, si) => s + si.quantity_pcs, 0)
      const damaged = damages
        .filter((d) => d.product_id === p.id)
        .reduce((s, d) => s + d.total_pcs, 0)
      const purchaseReturned = purchaseReturns
        .filter((pr) => pr.product_id === p.id)
        .reduce((s, pr) => s + pr.total_pcs, 0)
      const salesReturned = salesReturns
        .filter((sr) => sr.product_id === p.id && sr.restock)
        .reduce((s, sr) => s + sr.total_pcs, 0)

      // opening_stock_pcs is mutated as purchases/sales/damages/returns happen.
      // Reconstruct the original opening by reversing every mutation.
      const originalOpening =
        p.opening_stock_pcs -
        purchased +
        sold +
        damaged +
        purchaseReturned -
        salesReturned

      const closing = p.opening_stock_pcs
      const closingBags = p.conversion_factor
        ? Math.floor(closing / p.conversion_factor)
        : 0
      const perPiecePurchaseRate = getPurchaseRatePerPiece(p)
      const perOuterPurchaseRate = getPurchaseRatePerOuterUnit(p)
      const bagValue = p.conversion_factor
        ? (closing / p.conversion_factor) * perOuterPurchaseRate
        : closing * perPiecePurchaseRate

      return {
        product: p,
        opening_stock_pcs: originalOpening,
        purchased_pcs: purchased,
        sold_pcs: sold,
        damaged_pcs: damaged,
        purchase_returned_pcs: purchaseReturned,
        sales_returned_pcs: salesReturned,
        closing_pcs: closing,
        closing_bags: closingBags,
        bag_value: bagValue,
      }
    })
  },
}

// ----------------------------------------------------------------------------
// Customer Dues — derived from opening_balance + credit sales - collections
// ----------------------------------------------------------------------------

export interface CustomerDues {
  customer: Customer
  opening_balance: number
  credit_sales: number
  sales_returns: number // credit value returned by customer
  collections: number
  closing_dues: number
}

export const DuesService = {
  async all(): Promise<CustomerDues[]> {
    const customers = await db.customers.toArray()
    const sales = await db.sales.toArray()
    const collections = await db.collections.toArray()
    const salesReturns = await db.sales_returns.toArray()
    return customers.map((c) => {
      const creditSales = sales
        .filter((s) => s.customer_id === c.id && s.payment_mode === 'Credit')
        .reduce((sum, s) => sum + s.total_amount, 0)
      const coll = collections
        .filter((col) => col.customer_id === c.id)
        .reduce((sum, col) => sum + col.amount, 0)
      // Sales returns credit the customer's outstanding dues
      const returns = salesReturns
        .filter((sr) => sr.customer_id === c.id)
        .reduce((sum, sr) => sum + sr.total_amount, 0)
      return {
        customer: c,
        opening_balance: c.opening_balance,
        credit_sales: creditSales,
        sales_returns: returns,
        collections: coll,
        closing_dues: c.opening_balance + creditSales - coll - returns,
      }
    })
  },

  async byCustomer(customerId: number): Promise<CustomerDues | undefined> {
    const all = await this.all()
    return all.find((d) => d.customer.id === customerId)
  },
}

// ----------------------------------------------------------------------------
// Distributor settings
// ----------------------------------------------------------------------------

export const SettingsService = {
  async get(): Promise<DistributorSettings | undefined> {
    const all = await db.distributor_settings.toArray()
    return all[0]
  },

  async save(s: Omit<DistributorSettings, 'id'>): Promise<number> {
    const existing = await this.get()
    if (existing?.id) {
      await db.distributor_settings.update(existing.id, {
        ...s,
        isSynced: false,
        synced_at: null,
      })
      scheduleSync('distributor_settings')
      return existing.id
    }
    const id = await db.distributor_settings.add({
      ...s,
      isSynced: false,
      synced_at: null,
    } as DistributorSettings)
    scheduleSync('distributor_settings')
    return id
  },
}

// ----------------------------------------------------------------------------
// Damage / Stock-Adjustment services
// Records damaged/expired/leaked goods; deducts stock atomically and stores
// the cost value as an expense for P&L reporting.
// ----------------------------------------------------------------------------

export const DamageService = {
  async all(): Promise<Damage[]> {
    return db.damages.orderBy('created_at').reverse().toArray()
  },

  async create(d: Omit<Damage, 'id' | 'created_at'>): Promise<number> {
    const damageId = await db.transaction('rw', db.damages, db.products, async () => {
      const prod = await db.products.get(d.product_id)
      // Compute the cost value at the moment of damage using the persisted
      // per-piece purchase rate (falls back to derived rate for legacy rows)
      const perPiece = prod ? getPurchaseRatePerPiece(prod) : 0
      const expenseValue = perPiece * d.total_pcs
      const damageId = await db.damages.add({
        ...d,
        expense_value: expenseValue,
        created_at: new Date().toISOString(),
        isSynced: false,
        synced_at: null,
      })
      // Decrement product stock + mark un-synced
      if (prod) {
        await db.products.update(d.product_id, {
          opening_stock_pcs: Math.max(0, prod.opening_stock_pcs - d.total_pcs),
          isSynced: false,
          synced_at: null,
        })
      }
      return damageId as number
    })
    scheduleSync('damages')
    return damageId
  },

  async remove(id: number): Promise<void> {
    const damage = await db.damages.get(id)
    if (!damage) return
    await db.transaction('rw', db.damages, db.products, async () => {
      const prod = await db.products.get(damage.product_id)
      if (prod) {
        await db.products.update(damage.product_id, {
          opening_stock_pcs: prod.opening_stock_pcs + damage.total_pcs,
          isSynced: false,
          synced_at: null,
        })
      }
      await db.damages.delete(id)
    })
    scheduleSync('products')
  },

  async totals(): Promise<{ count: number; totalExpense: number; totalPcs: number }> {
    const all = await db.damages.toArray()
    return {
      count: all.length,
      totalExpense: all.reduce((s, d) => s + d.expense_value, 0),
      totalPcs: all.reduce((s, d) => s + d.total_pcs, 0),
    }
  },
}

// ----------------------------------------------------------------------------
// Purchase Return services — return TO supplier.
// Decrements stock and creates a supplier credit (logged for accounting).
// ----------------------------------------------------------------------------

export const PurchaseReturnService = {
  async all(): Promise<PurchaseReturn[]> {
    return db.purchase_returns.orderBy('created_at').reverse().toArray()
  },

  async nextReturnNo(): Promise<string> {
    const count = await db.purchase_returns.count()
    const year = new Date().getFullYear()
    return `PR-${year}-${String(count + 1).padStart(4, '0')}`
  },

  async create(r: Omit<PurchaseReturn, 'id' | 'created_at' | 'return_no'>): Promise<number> {
    const returnId = await db.transaction('rw', db.purchase_returns, db.products, async () => {
      const prod = await db.products.get(r.product_id)
      const returnNo = await this.nextReturnNo()
      const returnId = await db.purchase_returns.add({
        ...r,
        return_no: returnNo,
        created_at: new Date().toISOString(),
        isSynced: false,
        synced_at: null,
      })
      // Decrement product stock + mark un-synced
      if (prod) {
        await db.products.update(r.product_id, {
          opening_stock_pcs: Math.max(0, prod.opening_stock_pcs - r.total_pcs),
          isSynced: false,
          synced_at: null,
        })
      }
      return returnId as number
    })
    scheduleSync('purchase_returns')
    return returnId
  },

  async remove(id: number): Promise<void> {
    const ret = await db.purchase_returns.get(id)
    if (!ret) return
    await db.transaction('rw', db.purchase_returns, db.products, async () => {
      const prod = await db.products.get(ret.product_id)
      if (prod) {
        await db.products.update(ret.product_id, {
          opening_stock_pcs: prod.opening_stock_pcs + ret.total_pcs,
          isSynced: false,
          synced_at: null,
        })
      }
      await db.purchase_returns.delete(id)
    })
    scheduleSync('products')
  },
}

// ----------------------------------------------------------------------------
// Sales Return services — return FROM customer.
// If restock=true, goods re-enter inventory; otherwise treated as a write-off.
// Customer dues ledger is credited with the return value.
// ----------------------------------------------------------------------------

export const SalesReturnService = {
  async all(): Promise<SalesReturn[]> {
    return db.sales_returns.orderBy('created_at').reverse().toArray()
  },

  async nextReturnNo(): Promise<string> {
    const count = await db.sales_returns.count()
    const year = new Date().getFullYear()
    return `SR-${year}-${String(count + 1).padStart(4, '0')}`
  },

  async create(r: Omit<SalesReturn, 'id' | 'created_at' | 'return_no'>): Promise<number> {
    const returnId = await db.transaction('rw', db.sales_returns, db.products, async () => {
      const prod = await db.products.get(r.product_id)
      const returnNo = await this.nextReturnNo()
      const returnId = await db.sales_returns.add({
        ...r,
        return_no: returnNo,
        created_at: new Date().toISOString(),
        isSynced: false,
        synced_at: null,
      })
      // Restock goods only if restock=true
      if (r.restock && prod) {
        await db.products.update(r.product_id, {
          opening_stock_pcs: prod.opening_stock_pcs + r.total_pcs,
          isSynced: false,
          synced_at: null,
        })
      }
      return returnId as number
    })
    scheduleSync('sales_returns')
    return returnId
  },

  async remove(id: number): Promise<void> {
    const ret = await db.sales_returns.get(id)
    if (!ret) return
    await db.transaction('rw', db.sales_returns, db.products, async () => {
      if (ret.restock) {
        const prod = await db.products.get(ret.product_id)
        if (prod) {
          await db.products.update(ret.product_id, {
            opening_stock_pcs: Math.max(0, prod.opening_stock_pcs - ret.total_pcs),
            isSynced: false,
            synced_at: null,
          })
        }
      }
      await db.sales_returns.delete(id)
    })
    scheduleSync('products')
  },
}

// ----------------------------------------------------------------------------
// Backup & Restore — full JSON export / import of every table
// ----------------------------------------------------------------------------

export const BackupService = {
  async export(): Promise<string> {
    const data = {
      meta: {
        app: 'FMCG ERP',
        version: 5,
        exported_at: new Date().toISOString(),
      },
      products: await db.products.toArray(),
      customers: await db.customers.toArray(),
      purchases: await db.purchases.toArray(),
      sales: await db.sales.toArray(),
      sale_items: await db.sale_items.toArray(),
      collections: await db.collections.toArray(),
      distributor_settings: await db.distributor_settings.toArray(),
      damages: await db.damages.toArray(),
      purchase_returns: await db.purchase_returns.toArray(),
      sales_returns: await db.sales_returns.toArray(),
    }
    return JSON.stringify(data, null, 2)
  },

  async import(json: string): Promise<void> {
    const data = JSON.parse(json)
    await db.transaction(
      'rw',
      [
        db.products, db.customers, db.purchases, db.sales, db.sale_items,
        db.collections, db.distributor_settings, db.damages,
        db.purchase_returns, db.sales_returns,
      ],
      async () => {
        await db.products.clear()
        await db.customers.clear()
        await db.purchases.clear()
        await db.sales.clear()
        await db.sale_items.clear()
        await db.collections.clear()
        await db.distributor_settings.clear()
        await db.damages.clear()
        await db.purchase_returns.clear()
        await db.sales_returns.clear()
        // v5 — imported records are marked un-synced so they get pushed to the
        // PostgreSQL backend on the next sync cycle.
        const markUnsynced = (arr: any[]) =>
          (arr ?? []).map((r) => ({ ...r, isSynced: false, synced_at: null }))
        if (data.products?.length) await db.products.bulkPut(markUnsynced(data.products))
        if (data.customers?.length) await db.customers.bulkPut(markUnsynced(data.customers))
        if (data.purchases?.length) await db.purchases.bulkPut(markUnsynced(data.purchases))
        if (data.sales?.length) await db.sales.bulkPut(markUnsynced(data.sales))
        if (data.sale_items?.length) await db.sale_items.bulkPut(markUnsynced(data.sale_items))
        if (data.collections?.length) await db.collections.bulkPut(markUnsynced(data.collections))
        if (data.distributor_settings?.length) await db.distributor_settings.bulkPut(markUnsynced(data.distributor_settings))
        if (data.damages?.length) await db.damages.bulkPut(markUnsynced(data.damages))
        if (data.purchase_returns?.length) await db.purchase_returns.bulkPut(markUnsynced(data.purchase_returns))
        if (data.sales_returns?.length) await db.sales_returns.bulkPut(markUnsynced(data.sales_returns))
      }
    )
    // After import, push everything to the backend (if online).
    scheduleSync('products')
  },

  async seedIfEmpty(): Promise<void> {
    const productCount = await db.products.count()
    const customerCount = await db.customers.count()
    // v5 — seeded records are marked un-synced so the SyncService will push
    // them to the PostgreSQL backend on first launch (if configured).
    const UNSYNCED = { isSynced: false, synced_at: null }
    if (productCount === 0) {
      const now = new Date().toISOString()
      await db.products.bulkAdd([
        {
          sku: 'PARLE-G-001',
          company_name: 'Parle Products',
          name: 'Parle-G Glucose Biscuit',
          category: 'Biscuits',
          hsn_code: '1905',
          base_unit: 'Pcs',
          outer_unit: 'Bag',
          conversion_factor: 200,
          pack_size: '55g',
          // v4 pricing model — per-outer buy, per-piece sell (primary)
          purchase_rate_per_outer_unit: 240,
          purchase_rate_per_piece: 240 / 200,           // ₹1.20 / Pcs
          selling_rate_per_piece: 1.30,                  // primary sell rate
          selling_rate_per_outer_unit: 1.30 * 200,      // ₹260 / Bag
          // legacy aliases
          purchase_rate: 240,
          sales_rate: 1.30 * 200,
          purchase_rate_per_pcs: 240 / 200,
          sales_rate_per_pcs: 1.30,
          gst_percent: 18,
          opening_stock_pcs: 800,
          created_at: now,
          ...UNSYNCED,
        },
        {
          sku: 'BRITANN-MARIE-001',
          company_name: 'Britannia',
          name: 'Marie Gold Biscuit',
          category: 'Biscuits',
          hsn_code: '1905',
          base_unit: 'Pcs',
          outer_unit: 'Bag',
          conversion_factor: 120,
          pack_size: '70g',
          purchase_rate_per_outer_unit: 360,
          purchase_rate_per_piece: 360 / 120,
          selling_rate_per_piece: 3.40,
          selling_rate_per_outer_unit: 3.40 * 120,
          purchase_rate: 360,
          sales_rate: 3.40 * 120,
          purchase_rate_per_pcs: 360 / 120,
          sales_rate_per_pcs: 3.40,
          gst_percent: 18,
          opening_stock_pcs: 480,
          created_at: now,
          ...UNSYNCED,
        },
        {
          sku: 'MAGGI-2M-001',
          company_name: 'Nestle',
          name: 'Maggi 2-Min Masala Noodles',
          category: 'Instant Food',
          hsn_code: '1902',
          base_unit: 'Pcs',
          outer_unit: 'Bag',
          conversion_factor: 48,
          pack_size: '70g',
          purchase_rate_per_outer_unit: 432,
          purchase_rate_per_piece: 432 / 48,
          selling_rate_per_piece: 10.00,
          selling_rate_per_outer_unit: 10.00 * 48,
          purchase_rate: 432,
          sales_rate: 10.00 * 48,
          purchase_rate_per_pcs: 432 / 48,
          sales_rate_per_pcs: 10.00,
          gst_percent: 18,
          opening_stock_pcs: 240,
          created_at: now,
          ...UNSYNCED,
        },
        {
          sku: 'COLGATE-100G-001',
          company_name: 'Colgate-Palmolive',
          name: 'Colgate Strong Teeth 100g',
          category: 'Personal Care',
          hsn_code: '3306',
          base_unit: 'Pcs',
          outer_unit: 'Bag',
          conversion_factor: 48,
          pack_size: '100g',
          purchase_rate_per_outer_unit: 1680,
          purchase_rate_per_piece: 1680 / 48,
          selling_rate_per_piece: 37.92,
          selling_rate_per_outer_unit: 37.92 * 48,
          purchase_rate: 1680,
          sales_rate: 37.92 * 48,
          purchase_rate_per_pcs: 1680 / 48,
          sales_rate_per_pcs: 37.92,
          gst_percent: 18,
          opening_stock_pcs: 96,
          created_at: now,
          ...UNSYNCED,
        },
        {
          sku: 'SURF-1KG-001',
          company_name: 'Hindustan Unilever',
          name: 'Surf Excel Easy Wash 1kg',
          category: 'Home Care',
          hsn_code: '3402',
          base_unit: 'Pcs',
          outer_unit: 'Bag',
          conversion_factor: 12,
          pack_size: '1kg',
          purchase_rate_per_outer_unit: 1680,
          purchase_rate_per_piece: 1680 / 12,
          selling_rate_per_piece: 151.67,
          selling_rate_per_outer_unit: 151.67 * 12,
          purchase_rate: 1680,
          sales_rate: 151.67 * 12,
          purchase_rate_per_pcs: 1680 / 12,
          sales_rate_per_pcs: 151.67,
          gst_percent: 18,
          opening_stock_pcs: 36,
          created_at: now,
          ...UNSYNCED,
        },
      ])
    }
    if (customerCount === 0) {
      const now = new Date().toISOString()
      await db.customers.bulkAdd([
        {
          customer_id: 'CUST-0001',
          name: 'Sharma General Store',
          route_area: 'MG Road',
          phone: '9876543210',
          gstin: '29ABCDE1234F1Z5',
          opening_balance: 12500,
          created_at: now,
          ...UNSYNCED,
        },
        {
          customer_id: 'CUST-0002',
          name: 'Gupta Kirana Corner',
          route_area: 'Civil Lines',
          phone: '9876501234',
          gstin: '29XYZAB5678C1Z2',
          opening_balance: 8200,
          created_at: now,
          ...UNSYNCED,
        },
        {
          customer_id: 'CUST-0003',
          name: 'Verma Super Market',
          route_area: 'Sector 14',
          phone: '9123456789',
          gstin: '',
          opening_balance: 0,
          created_at: now,
          ...UNSYNCED,
        },
        {
          customer_id: 'CUST-0004',
          name: 'Singh Provision Store',
          route_area: 'Old Market',
          phone: '9000011122',
          gstin: '',
          opening_balance: 4500,
          created_at: now,
          ...UNSYNCED,
        },
      ])
    }
    const settings = await db.distributor_settings.count()
    if (settings === 0) {
      await db.distributor_settings.add({
        store_name: 'MATRI ENTERPRISE',
        subtitle: 'Distributor Of: Too Yumm / Trsna Water',
        gstin: '19DSFPM8845F1Z8',
        address: '51, ELACHI CHAKRABORTYPARA ROAD, KOLKATA-700 151',
        phone: '8777746395 / 9874532121',
        email: '',
        invoice_prefix: 'INV',
        state: 'West Bengal (19)',
        bank_details:
          'Bandhan Bank, Rajpur Branch | A/c No: 20100077079708 | IFSC: BDBL0001028',
        isSynced: false,
        synced_at: null,
      })
    }
  },
}

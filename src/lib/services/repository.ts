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
  BillAllocation,
} from '@/lib/db/dexie'

// Re-export BillAllocation so UI modules can import it from the repository
// layer without reaching into dexie.ts directly (keeps the hexagonal boundary).
export type { BillAllocation } from '@/lib/db/dexie'

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
// Date normalization helpers (Change 2 — strict ISO-8601 UTC 'Z')
// ----------------------------------------------------------------------------
// Business dates (`date`, `mfg_date`, `expiry_date`) are stored as String
// YYYY-MM-DD in the Prisma schema. We slice any incoming value to its first
// 10 characters so a stray ISO timestamp (which would shift the calendar day
// in IST) is clipped back to the plain date.
//
// `created_at` / `synced_at` are real DateTime fields and are always stamped
// via `new Date(...).toISOString()` (UTC 'Z'). The server's push route also
// enforces this on inbound payloads.
// ----------------------------------------------------------------------------

function isoBusinessDate(val: any): string {
  if (val === null || val === undefined || val === '') return ''
  return String(val).slice(0, 10)
}

function isoNullableBusinessDate(val: any): string | undefined {
  if (val === null || val === undefined || val === '') return undefined
  return String(val).slice(0, 10)
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
    return db.products
      .orderBy('created_at')
      .reverse()
      .toArray()
      .then(rows => rows.filter(r => !r.is_deleted))
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
    // ---- Loose Product normalization ----
    // When is_loose is true, force conversion_factor = 1 and outer_unit =
    // base_unit so the pricing math stays consistent (per-piece == per-outer
    // when cf=1). The UI hides Outer Unit + Conversion Factor inputs for loose
    // products, but we enforce it here as a backend safety net.
    const isLoose = Boolean(p.is_loose)
    const baseUnit = isLoose
      ? String(p.base_unit || 'Kg')
      : String(p.base_unit || 'Pcs')
    const outerUnit = isLoose ? baseUnit : String(p.outer_unit || 'Bag')
    const cf = isLoose ? 1 : Number(p.conversion_factor) || 1

    const purchaseRatePerOuterUnit =
      Number(p.purchase_rate_per_outer_unit ?? p.purchase_rate ?? 0) || 0
    const sellingRatePerPiece =
      Number(p.selling_rate_per_piece ?? p.sales_rate_per_pcs ?? 0) || 0
    const purchaseRatePerPiece = computePurchaseRatePerPiece(purchaseRatePerOuterUnit, cf)
    const sellingRatePerOuterUnit = computeSellingRatePerOuterUnit(sellingRatePerPiece, cf)

    const payload: Product = {
      ...p,
      is_loose: isLoose,
      base_unit: baseUnit,
      outer_unit: outerUnit,
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
    // ---- Loose Product normalization (mirror of create) ----
    // If is_loose is being flipped on (or the product is already loose),
    // force conversion_factor = 1 and outer_unit = base_unit.
    const existing = await db.products.get(id)
    const isLoose =
      p.is_loose !== undefined ? Boolean(p.is_loose) : Boolean(existing?.is_loose)
    if (isLoose) {
      const baseUnit = String(p.base_unit ?? existing?.base_unit ?? 'Kg')
      patch.is_loose = true
      patch.base_unit = baseUnit
      patch.outer_unit = baseUnit
      patch.conversion_factor = 1
    }
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
      const cf = isLoose ? 1 : Number(p.conversion_factor ?? existing?.conversion_factor ?? 1) || 1
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
    // Soft-delete: mark is_deleted=true instead of physically removing the
    // row, so it can be restored from the Recycle Bin later. isSynced=false
    // ensures the change propagates to PostgreSQL on the next sync push.
    await db.products.update(id, {
      is_deleted: true,
      isSynced: false,
      synced_at: null,
    })
    scheduleSync('products')
  },

  async restore(id: number): Promise<void> {
    await db.products.update(id, {
      is_deleted: false,
      isSynced: false,
      synced_at: null,
    })
    scheduleSync('products')
  },

  async listDeleted(): Promise<Product[]> {
    return (await db.products.toArray()).filter(r => r.is_deleted === true)
  },

  async hardDelete(id: number): Promise<void> {
    // Physically remove the row (no restore possible). Used by the Recycle
    // Bin's "Delete forever" action.
    await db.products.delete(id)
    scheduleSync('products')
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
    return db.customers
      .orderBy('created_at')
      .reverse()
      .toArray()
      .then(rows => rows.filter(r => !r.is_deleted))
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
    // Soft-delete: mark is_deleted=true; record preserved for Recycle Bin.
    await db.customers.update(id, {
      is_deleted: true,
      isSynced: false,
      synced_at: null,
    })
    scheduleSync('customers')
  },

  async restore(id: number): Promise<void> {
    await db.customers.update(id, {
      is_deleted: false,
      isSynced: false,
      synced_at: null,
    })
    scheduleSync('customers')
  },

  async listDeleted(): Promise<Customer[]> {
    return (await db.customers.toArray()).filter(r => r.is_deleted === true)
  },

  async hardDelete(id: number): Promise<void> {
    await db.customers.delete(id)
    scheduleSync('customers')
  },

  async nextCustomerId(): Promise<string> {
    // ---- Bug fix: previously used db.customers.count() which returns the
    // CURRENT row count, NOT the max ID ever assigned. If any customer was
    // ever deleted (test cleanup, sync conflicts), count() returns a number
    // LOWER than the highest CUST-XXXX suffix in the table — so the
    // generator kept producing the same ID over and over (stuck at 233).
    //
    // Fix: fetch ALL customer_id strings, parse the numeric suffix via
    // parseInt(), take Math.max(), then +1. Safe for deleted rows.
    // Falls back to count+1 if no existing IDs are parseable.
    const all = await db.customers.toArray()
    let maxNum = 0
    for (const c of all) {
      const raw = c.customer_id ?? ''
      // Strip any non-digit prefix (CUST-, CUST_, C- etc.) and parse the
      // trailing digits. Handles both "CUST-0233" and bare "233".
      const match = raw.match(/(\d+)\s*$/)
      if (match) {
        const n = parseInt(match[1], 10)
        if (!isNaN(n) && n > maxNum) {
          maxNum = n
        }
      }
    }
    // If no existing IDs were parseable (e.g. empty table), fall back to
    // count()+1 so the first customer gets CUST-0001.
    const next = maxNum > 0 ? maxNum + 1 : all.length + 1
    return `CUST-${String(next).padStart(4, '0')}`
  },
}

// ----------------------------------------------------------------------------
// Purchase services — writes purchase record + adjusts product stock
// ----------------------------------------------------------------------------
// Supports two creation paths:
//   1. create(p)        — single-item purchase (legacy, kept for backward compat)
//   2. createBatch(draft) — multi-item vendor invoice (Tally/SAP style):
//      creates N Purchase rows sharing the same invoice header (bill_no, date,
//      supplier_name, supplier_gstin) in one Dexie transaction. Each row has
//      its own product/qty/rate/GST/mfg/expiry. Updates each product's purchase
//      rate to the latest batch rate so POS profit calcs stay accurate.
// ----------------------------------------------------------------------------

// Multi-item purchase draft — the cart line for a single product within a
// vendor invoice. The UI builds an array of these and passes them to
// createBatch() along with the shared invoice header.
export interface PurchaseDraftItem {
  product_id: number
  product_sku: string
  product_name: string
  hsn_code: string
  bag_qty: number // 0 for loose products
  pcs_qty: number // loose: this IS the qty in Kg/Gm; packaged: extra pcs
  total_pcs: number // bag_qty * conversion_factor + pcs_qty
  purchase_rate: number // per outer unit (or per Kg for loose)
  gst_percent: number
  taxable_amount: number
  cgst: number
  sgst: number
  total_amount: number
  mfg_date?: string
  expiry_date?: string
}

// Shared invoice header + items — what createBatch receives.
export interface PurchaseDraft {
  bill_no: string
  date: string
  supplier_name: string
  supplier_gstin?: string
  items: PurchaseDraftItem[]
}

export const PurchaseService = {
  async all(): Promise<Purchase[]> {
    return db.purchases
      .orderBy('created_at')
      .reverse()
      .toArray()
      .then(rows => rows.filter(r => !r.is_deleted))
  },

  async create(p: Omit<Purchase, 'id' | 'created_at'>): Promise<number> {
    // Add purchase + bump opening stock on the product, all in one transaction.
    const id = await db.transaction('rw', db.purchases, db.products, async () => {
      const purchaseId = await db.purchases.add({
        ...p,
        // Normalize business dates to YYYY-MM-DD (Change 2)
        date: isoBusinessDate(p.date),
        mfg_date: isoNullableBusinessDate(p.mfg_date),
        expiry_date: isoNullableBusinessDate(p.expiry_date),
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

  /**
   * Multi-item vendor invoice — creates N Purchase rows sharing the same
   * invoice header (bill_no, date, supplier_name, supplier_gstin) in one
   * atomic Dexie transaction. Each row has its own product/qty/rate/GST/mfg/
   * expiry. For each item:
   *   1. Creates a Purchase row (shared header + per-item details).
   *   2. Bumps product.opening_stock_pcs += item.total_pcs.
   *   3. Updates product.purchase_rate_per_outer_unit = item.purchase_rate
   *      (latest batch rate wins — standard ERP behavior so POS profit
   *      calculations use the updated rate).
   *   4. Recomputes purchase_rate_per_piece = rate / conversion_factor.
   *   5. Marks product isSynced=false.
   *
   * All rows + affected products are created/updated atomically — if any
   * item fails, the entire batch rolls back (no partial invoice).
   *
   * Returns: array of created Purchase IDs (one per cart item).
   */
  async createBatch(draft: PurchaseDraft): Promise<number[]> {
    const createdIds: number[] = []
    const now = new Date().toISOString()
    const normalizedDate = isoBusinessDate(draft.date)

    await db.transaction(
      'rw',
      db.purchases,
      db.products,
      async () => {
        for (const item of draft.items) {
          // ---- 1. Create the Purchase row ----
          const purchaseId = await db.purchases.add({
            bill_no: draft.bill_no,
            date: normalizedDate,
            supplier_name: draft.supplier_name,
            supplier_gstin: draft.supplier_gstin ?? undefined,
            product_id: item.product_id,
            product_sku: item.product_sku,
            product_name: item.product_name,
            hsn_code: item.hsn_code,
            bag_qty: item.bag_qty,
            pcs_qty: item.pcs_qty,
            total_pcs: item.total_pcs,
            purchase_rate: item.purchase_rate,
            gst_percent: item.gst_percent,
            taxable_amount: item.taxable_amount,
            cgst: item.cgst,
            sgst: item.sgst,
            total_amount: item.total_amount,
            mfg_date: isoNullableBusinessDate(item.mfg_date),
            expiry_date: isoNullableBusinessDate(item.expiry_date),
            created_at: now,
            isSynced: false,
            synced_at: null,
          })
          createdIds.push(purchaseId as number)

          // ---- 2. Bump product stock + 3/4. Update purchase rate ----
          const prod = await db.products.get(item.product_id)
          if (prod) {
            const cf = Number(prod.conversion_factor) || 1
            const newPerPiece = cf > 0 ? item.purchase_rate / cf : item.purchase_rate
            await db.products.update(item.product_id, {
              opening_stock_pcs: prod.opening_stock_pcs + item.total_pcs,
              // Latest batch rate wins — update the product master so future
              // POS profit calculations use this batch's purchase rate.
              purchase_rate_per_outer_unit: item.purchase_rate,
              purchase_rate_per_piece: newPerPiece,
              // Legacy aliases kept in sync
              purchase_rate: item.purchase_rate,
              purchase_rate_per_pcs: newPerPiece,
              isSynced: false,
              synced_at: null,
            })
          }
        }
      }
    )
    // Schedule sync once for the whole batch (single network round-trip).
    scheduleSync('purchases')
    scheduleSync('products')
    return createdIds
  },

  async remove(id: number): Promise<void> {
    const purchase = await db.purchases.get(id)
    if (!purchase) return
    // Soft-delete: KEEP the stock-revert (the purchase is "leaving" the
    // active ledger, so its total_pcs must come off the product's stock),
    // but mark the row is_deleted=true instead of physically deleting it,
    // so it can be restored from the Recycle Bin later.
    await db.transaction('rw', db.purchases, db.products, async () => {
      const prod = await db.products.get(purchase.product_id)
      if (prod) {
        await db.products.update(purchase.product_id, {
          opening_stock_pcs: prod.opening_stock_pcs - purchase.total_pcs,
          isSynced: false,
          synced_at: null,
        })
      }
      await db.purchases.update(id, {
        is_deleted: true,
        isSynced: false,
        synced_at: null,
      })
    })
    scheduleSync('products')
    scheduleSync('purchases')
  },

  async restore(id: number): Promise<void> {
    const purchase = await db.purchases.get(id)
    if (!purchase) return
    // RE-APPLY stock: the purchase is returning to the active ledger, so
    // add its total_pcs back to the product's opening_stock_pcs.
    await db.transaction('rw', db.purchases, db.products, async () => {
      const prod = await db.products.get(purchase.product_id)
      if (prod) {
        await db.products.update(purchase.product_id, {
          opening_stock_pcs: prod.opening_stock_pcs + purchase.total_pcs,
          isSynced: false,
          synced_at: null,
        })
      }
      await db.purchases.update(id, {
        is_deleted: false,
        isSynced: false,
        synced_at: null,
      })
    })
    scheduleSync('products')
    scheduleSync('purchases')
  },

  async listDeleted(): Promise<Purchase[]> {
    return (await db.purchases.toArray()).filter(r => r.is_deleted === true)
  },

  async hardDelete(id: number): Promise<void> {
    await db.purchases.delete(id)
    scheduleSync('purchases')
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
    return db.sales
      .orderBy('created_at')
      .reverse()
      .toArray()
      .then(rows => rows.filter(r => !r.is_deleted))
  },

  async get(id: number): Promise<{ sale: Sale; items: SaleItem[] } | undefined> {
    const sale = await db.sales.get(id)
    if (!sale) return undefined
    // Dexie's .equals() does strict === against the indexed value (always a
    // JS number from ++id). Coerce the caller's id to Number so a string
    // id (from a Turso pull, which stringifies BigInts) doesn't silently
    // return zero rows.
    const items = await db.sale_items
      .where('sale_id')
      .equals(Number(id))
      .toArray()
      .then(rows => rows.filter(si => !si.is_deleted))
    return { sale, items }
  },

  async itemsBySale(saleId: number): Promise<SaleItem[]> {
    return db.sale_items
      .where('sale_id')
      .equals(Number(saleId))
      .toArray()
      .then(rows => rows.filter(si => !si.is_deleted))
  },

  async create(draft: SaleDraft): Promise<number> {
    const saleId = await db.transaction('rw', db.sales, db.sale_items, db.products, async () => {
      const saleId = await db.sales.add({
        invoice_no: draft.invoice_no,
        // Normalize business date to YYYY-MM-DD (Change 2)
        date: isoBusinessDate(draft.date),
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
            opening_stock_pcs: prod.opening_stock_pcs - it.quantity_pcs,
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

  // --------------------------------------------------------------------------
  // Upgrade 2 — SaleService.update()
  // --------------------------------------------------------------------------
  // Replaces a saved sale's header + line items atomically.
  //
  // Strategy:
  //   1. Load the existing sale + items.
  //   2. RESTORE old stock: re-add every old line item's quantity back to its
  //      product's opening_stock_pcs (so the new draft starts from a clean
  //      slate). Mark affected products isSynced=false.
  //   3. DELETE all old sale_items for this sale.
  //   4. WRITE the new sale header (in-place update of the existing sale row —
  //      preserves the original `id` and `created_at`).
  //   5. INSERT the new sale_items (each marked isSynced=false).
  //   6. APPLY new stock: decrement every new line item's quantity from the
  //      corresponding product.
  //   7. Mark the sale itself isSynced=false so the sync layer re-pushes it.
  //
  // Stock math stays consistent because steps 2 and 6 happen inside the same
  // Dexie transaction — if anything fails, the entire update rolls back.
  // --------------------------------------------------------------------------
  async update(id: number, draft: SaleDraft): Promise<number> {
    await db.transaction(
      'rw',
      db.sales,
      db.sale_items,
      db.products,
      async () => {
        const saleId = Number(id)
        const existing = await db.sales.get(saleId)
        if (!existing) {
          throw new Error(`Sale ${id} not found — cannot edit`)
        }
        // ---- Step 2: restore old stock + collect affected product ids ----
        const oldItems = await db.sale_items
          .where('sale_id')
          .equals(saleId)
          .toArray()
        const affectedProductIds = new Set<string>()
        for (const it of oldItems) {
          const pid = String(it.product_id)
          affectedProductIds.add(pid)
          const prod = await db.products.get(it.product_id)
          if (prod) {
            await db.products.update(it.product_id, {
              opening_stock_pcs: prod.opening_stock_pcs + it.quantity_pcs,
              isSynced: false,
              synced_at: null,
            })
          }
        }
        // ---- Step 3: delete old sale_items ----
        await db.sale_items.where('sale_id').equals(saleId).delete()
        // ---- Step 4: update sale header in place ----
        await db.sales.update(saleId, {
          invoice_no: draft.invoice_no,
          // Normalize business date to YYYY-MM-DD (Change 2)
          date: isoBusinessDate(draft.date),
          customer_id: draft.customer_id,
          customer_name: draft.customer_name,
          payment_mode: draft.payment_mode,
          subtotal: draft.subtotal,
          cgst: draft.cgst,
          sgst: draft.sgst,
          total_amount: draft.total_amount,
          total_profit: draft.total_profit,
          total_margin_percent: draft.total_margin_percent,
          paid_amount:
            draft.payment_mode === 'Cash' ? draft.total_amount : 0,
          // Mark as un-synced so SyncService re-pushes the updated sale.
          isSynced: false,
          synced_at: null,
        })
        // ---- Step 5 + 6: insert new items + apply new stock ----
        for (const it of draft.items) {
          affectedProductIds.add(String(it.product_id))
          await db.sale_items.add({
            ...it,
            sale_id: saleId,
            isSynced: false,
            synced_at: null,
          })
          const prod = await db.products.get(it.product_id)
          if (prod) {
            await db.products.update(it.product_id, {
              opening_stock_pcs: prod.opening_stock_pcs - it.quantity_pcs,
              isSynced: false,
              synced_at: null,
            })
          }
        }
        // Note: `affectedProductIds` was tracked so that, in a future
        // optimization, we could selectively mark only those products as
        // un-synced (instead of relying on the per-product writes above).
        // The per-product writes already flip isSynced=false on each touched
        // product, so this set is currently unused but retained for clarity.
        void affectedProductIds
      }
    )
    scheduleSync('sales')
    return id
  },

  async nextInvoiceNo(prefix = 'INV'): Promise<string> {
    // ---- Bug fix (same as nextCustomerId): use Math.max() over parsed
    // invoice_no suffixes, NOT db.sales.count(). Deleted sales would
    // otherwise cause the generator to reuse an already-assigned number.
    const year = new Date().getFullYear()
    const all = await db.sales.toArray()
    let maxNum = 0
    for (const s of all) {
      const raw = s.invoice_no ?? ''
      // Match the LAST run of digits (e.g. "INV-2024-0023" → 23).
      const match = raw.match(/(\d+)\s*$/)
      if (match) {
        const n = parseInt(match[1], 10)
        if (!isNaN(n) && n > maxNum) {
          maxNum = n
        }
      }
    }
    const next = maxNum > 0 ? maxNum + 1 : all.length + 1
    return `${prefix}-${year}-${String(next).padStart(4, '0')}`
  },

  async remove(id: number): Promise<void> {
    // Soft-delete: KEEP the existing child-deletion (now as a soft-delete via
    // .modify) and APPLY stock-restore for every sale_item (the sale is
    // "leaving" the active ledger, so its qty must go back to inventory).
    // The sale row itself is marked is_deleted=true instead of physically
    // deleted, so it can be restored from the Recycle Bin later.
    await db.transaction('rw', db.sales, db.sale_items, db.products, async () => {
      const items = await db.sale_items
        .where('sale_id')
        .equals(Number(id))
        .toArray()
      for (const it of items) {
        const prod = await db.products.get(it.product_id)
        if (prod) {
          await db.products.update(it.product_id, {
            opening_stock_pcs: prod.opening_stock_pcs + it.quantity_pcs,
            isSynced: false,
            synced_at: null,
          })
        }
      }
      await db.sale_items
        .where('sale_id')
        .equals(Number(id))
        .modify({ is_deleted: true, isSynced: false, synced_at: null })
      await db.sales.update(id, {
        is_deleted: true,
        isSynced: false,
        synced_at: null,
      })
    })
    scheduleSync('sales')
    scheduleSync('products')
  },

  async restore(id: number): Promise<void> {
    // RE-APPLY stock decrement for every sale_item (the sale is "returning"
    // to the active ledger, so its qty must come off inventory again).
    // Un-soft-delete the sale + its sale_items.
    await db.transaction('rw', db.sales, db.sale_items, db.products, async () => {
      const items = await db.sale_items
        .where('sale_id')
        .equals(Number(id))
        .toArray()
      for (const it of items) {
        const prod = await db.products.get(it.product_id)
        if (prod) {
          await db.products.update(it.product_id, {
            opening_stock_pcs: Math.max(0, prod.opening_stock_pcs - it.quantity_pcs),
            isSynced: false,
            synced_at: null,
          })
        }
      }
      await db.sale_items
        .where('sale_id')
        .equals(Number(id))
        .modify({ is_deleted: false, isSynced: false, synced_at: null })
      await db.sales.update(id, {
        is_deleted: false,
        isSynced: false,
        synced_at: null,
      })
    })
    scheduleSync('sales')
    scheduleSync('products')
  },

  async listDeleted(): Promise<Sale[]> {
    return (await db.sales.toArray()).filter(r => r.is_deleted === true)
  },

  async hardDelete(id: number): Promise<void> {
    // Physically delete the sale + its sale_items (no restore possible).
    await db.transaction('rw', db.sales, db.sale_items, async () => {
      await db.sale_items.where('sale_id').equals(Number(id)).delete()
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
    return db.collections
      .where('customer_id')
      .equals(Number(customerId))
      .toArray()
  },

  async create(c: Omit<Collection, 'id' | 'created_at'>): Promise<number> {
    const id = await db.collections.add({
      ...c,
      // Normalize business date to YYYY-MM-DD (Change 2)
      date: isoBusinessDate(c.date),
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
//
// Upgrade 4 — adds:
//   - latest_mfg_date      : most recent MFG date from purchases (active batch)
//   - earliest_expiry_date : FEFO nearest expiry from purchases
//   - days_until_expiry   : signed days from today to earliest_expiry_date
//   - godown_damaged_pcs  : sum of damages with damage_source = 'godown'
//                           (these were already deducted from sellable stock)
//   - store_damaged_pcs   : sum of damages with damage_source = 'store'
//                           (separate "Damaged Stock (Store)" bucket — never
//                            touched sellable stock; tracked for accounting)
// ----------------------------------------------------------------------------

export interface InventoryRow {
  product: Product
  opening_stock_pcs: number
  purchased_pcs: number
  sold_pcs: number
  damaged_pcs: number // legacy: total of all damages (godown + store)
  purchase_returned_pcs: number
  sales_returned_pcs: number // only restock=true entries
  closing_pcs: number
  closing_bags: number
  bag_value: number
  // Upgrade 4 fields:
  latest_mfg_date?: string // YYYY-MM-DD of the most recent purchase with mfg_date
  earliest_expiry_date?: string // YYYY-MM-DD of the nearest expiry across purchases
  days_until_expiry?: number // signed: negative = already expired
  godown_damaged_pcs: number // damages that DID deduct sellable stock
  store_damaged_pcs: number // damages tracked separately (Store / Market return)
}

// Helper — parse a YYYY-MM-DD string into a Date at local midnight for
// day-accurate diff math. Returns null on invalid input.
function parseDateSafe(val: string | undefined | null): Date | null {
  if (!val) return null
  const d = new Date(val)
  if (isNaN(d.getTime())) return null
  // Normalize to local-midnight to avoid TZ drift in day-counting.
  d.setHours(0, 0, 0, 0)
  return d
}

// Helper — signed days from `today` to `target` (negative = past, positive = future).
function daysUntil(target: Date): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffMs = target.getTime() - today.getTime()
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24))
}

export const InventoryService = {
  async all(): Promise<InventoryRow[]> {
    // Soft-delete aware: exclude deleted products/purchases/sale_items so
    // the derived stock ledger only reflects active records. Damages,
    // purchase_returns and sales_returns are not part of this soft-delete
    // task (their interfaces don't carry is_deleted) — left untouched.
    const products = (await db.products.toArray()).filter(p => !p.is_deleted)
    const purchases = (await db.purchases.toArray()).filter(pu => !pu.is_deleted)
    const saleItems = (await db.sale_items.toArray()).filter(si => !si.is_deleted)
    const damages = await db.damages.toArray()
    const purchaseReturns = await db.purchase_returns.toArray()
    const salesReturns = await db.sales_returns.toArray()

    return products.map((p) => {
      const pid = String(p.id)
      // ---- Per-product purchases (used for stock math + FEFO computation) ----
      const productPurchases = purchases.filter(
        (pu) => String(pu.product_id) === pid
      )
      const purchased = productPurchases.reduce(
        (s, pu) => s + pu.total_pcs,
        0
      )
      const sold = saleItems
        .filter((si) => String(si.product_id) === pid)
        .reduce((s, si) => s + si.quantity_pcs, 0)

      // ---- Upgrade 3-aware damage split ----
      const productDamages = damages.filter(
        (d) => String(d.product_id) === pid
      )
      // Legacy rows (damage_source === undefined) are treated as 'godown'.
      const godownDamages = productDamages.filter(
        (d) => d.damage_source !== 'store'
      )
      const storeDamages = productDamages.filter(
        (d) => d.damage_source === 'store'
      )
      const godownDamagedPcs = godownDamages.reduce(
        (s, d) => s + d.total_pcs,
        0
      )
      const storeDamagedPcs = storeDamages.reduce(
        (s, d) => s + d.total_pcs,
        0
      )
      // Legacy `damaged_pcs` = total (godown + store) — kept for the existing
      // CSV export column and any external code that reads it.
      const damaged = godownDamagedPcs + storeDamagedPcs

      const purchaseReturned = purchaseReturns
        .filter((pr) => String(pr.product_id) === pid)
        .reduce((s, pr) => s + pr.total_pcs, 0)
      const salesReturned = salesReturns
        .filter((sr) => String(sr.product_id) === pid && sr.restock)
        .reduce((s, sr) => s + sr.total_pcs, 0)

      // opening_stock_pcs is mutated as purchases/sales/damages/returns happen.
      // Reconstruct the original opening by reversing every mutation.
      // NOTE: store damages were never deducted from sellable stock, so they
      // are NOT reversed here. Only godown damages were.
      const originalOpening =
        p.opening_stock_pcs -
        purchased +
        sold +
        godownDamagedPcs + // only godown damages were deducted
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

      // ---- Upgrade 4 — FEFO / shelf-life computation ----
      // Walk every purchase entry that has a mfg_date / expiry_date and pick:
      //   - latest_mfg_date  = max(mfg_date)        → "active batch"
      //   - earliest_expiry  = min(expiry_date)     → FEFO nearest expiry
      let latestMfg: Date | null = null
      let earliestExpiry: Date | null = null
      for (const pu of productPurchases) {
        const mfg = parseDateSafe(pu.mfg_date)
        if (mfg && (latestMfg === null || mfg.getTime() > latestMfg.getTime())) {
          latestMfg = mfg
        }
        const exp = parseDateSafe(pu.expiry_date)
        if (
          exp &&
          (earliestExpiry === null || exp.getTime() < earliestExpiry.getTime())
        ) {
          earliestExpiry = exp
        }
      }
      const latestMfgStr = latestMfg
        ? latestMfg.toISOString().slice(0, 10)
        : undefined
      const earliestExpiryStr = earliestExpiry
        ? earliestExpiry.toISOString().slice(0, 10)
        : undefined
      const daysUntilExpiry = earliestExpiry
        ? daysUntil(earliestExpiry)
        : undefined

      return {
        product: p,
        opening_stock_pcs: originalOpening,
        purchased_pcs: purchased,
        sold_pcs: sold,
        damaged_pcs: damaged, // legacy: godown + store
        purchase_returned_pcs: purchaseReturned,
        sales_returned_pcs: salesReturned,
        closing_pcs: closing,
        closing_bags: closingBags,
        bag_value: bagValue,
        // Upgrade 4 fields:
        latest_mfg_date: latestMfgStr,
        earliest_expiry_date: earliestExpiryStr,
        days_until_expiry: daysUntilExpiry,
        godown_damaged_pcs: godownDamagedPcs,
        store_damaged_pcs: storeDamagedPcs,
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
    // Soft-delete aware: customers and sales are filtered to exclude
    // is_deleted=true rows. Collection doesn't yet have is_deleted (not
    // part of this soft-delete task) — filtered defensively with a cast so
    // future schema changes don't leak deleted collections into dues.
    const customers = (await db.customers.toArray()).filter(c => !c.is_deleted)
    const sales = (await db.sales.toArray()).filter(s => !s.is_deleted)
    const collections = (await db.collections.toArray()).filter(
      col => !(col as any).is_deleted
    )
    const salesReturns = await db.sales_returns.toArray()
    return customers.map((c) => {
      const cid = String(c.id)
      const creditSales = sales
        .filter(
          (s) => String(s.customer_id) === cid && s.payment_mode === 'Credit'
        )
        .reduce((sum, s) => sum + s.total_amount, 0)
      const coll = collections
        .filter((col) => String(col.customer_id) === cid)
        .reduce((sum, col) => sum + col.amount, 0)
      // Sales returns credit the customer's outstanding dues
      const returns = salesReturns
        .filter((sr) => String(sr.customer_id) === cid)
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
    return all.find(
      (d) => String(d.customer.id) === String(customerId)
    )
  },
}

// ----------------------------------------------------------------------------
// Bill Dues — invoice-wise breakdown of outstanding credit sales
// ----------------------------------------------------------------------------
// Powers the Tally-style "Against Reference" allocation UI in Collections.tsx.
// For each credit sale of the customer, computes:
//   - total_amount   = sale.total_amount (grand total incl. GST)
//   - paid_amount   = sum of bill_allocations[].amount across ALL collections
//                     for this customer where allocation.sale_id === sale.id
//   - remaining_due = total_amount - paid_amount
//
// Only credit sales are returned (cash sales are paid in full at POS).
// Sales with remaining_due <= 0 are filtered out so the UI only shows
// genuinely outstanding bills. The caller can choose to include fully-paid
// bills (e.g. for history) by passing includePaid = true.
//
// If a sale was edited and its invoice_no changed, the live sale's invoice_no
// is used (the snapshot on each BillAllocation is just a fallback for when
// the sale was deleted).
// ----------------------------------------------------------------------------

export interface BillDue {
  sale: Sale
  invoice_no: string // live from sale.invoice_no (or allocation snapshot if sale deleted)
  total_amount: number
  paid_amount: number // sum of allocations across all collections
  // Task 2 — Damage-aware bill-wise collection.
  // Sum of damage.expense_value across all Damage rows where sale_id matches
  // this sale (store-return damages attributed to this bill). Subtracted from
  // remaining_due to produce net_payable.
  damage_amount: number
  // Net Payable = total_amount - paid_amount - damage_amount.
  // This is what the user should allocate against in the Collection screen.
  net_payable: number
  // remaining_due = total_amount - paid_amount (does NOT subtract damage).
  // Kept for backward compat — the Collection UI now uses net_payable.
  remaining_due: number
}

export const BillDuesService = {
  /**
   * Returns the per-bill outstanding breakdown for a single customer.
   * Only credit sales are included. Fully-paid bills are excluded unless
   * `includePaid` is true.
   */
  async byCustomer(
    customerId: number,
    includePaid = false
  ): Promise<BillDue[]> {
    const cid = String(customerId)
    const sales = await db.sales.toArray()
    const collections = await db.collections.toArray()
    // Task 2 — also load damages so we can subtract store-return damage
    // amounts attributed to each bill via sale_id.
    const damages = await db.damages.toArray()

    // ---- Credit sales for this customer (exclude soft-deleted) ----
    const creditSales = sales.filter(
      (s) =>
        String(s.customer_id) === cid &&
        s.payment_mode === 'Credit' &&
        !s.is_deleted
    )

    // ---- All collections for this customer (we'll walk their allocations) ----
    // Collection doesn't yet have is_deleted (not part of this soft-delete
    // task) — filter defensively with a cast so future schema changes don't
    // leak deleted collections into bill-wise dues.
    const custCollections = collections.filter(
      (c) => String(c.customer_id) === cid && !(c as any).is_deleted
    )

    // ---- All damages for this customer (we'll sum expense_value by sale_id) ----
    // Only store-damages attributed to a specific sale are subtracted from
    // that bill's net payable. Godown damages (no sale_id) are not bill-linked.
    // Damage doesn't yet have is_deleted — filtered defensively with a cast.
    const custDamages = damages.filter(
      (d) =>
        String(d.customer_id) === cid &&
        d.sale_id != null &&
        !(d as any).is_deleted
    )

    // ---- Build sale-id → paid-amount map by walking allocations ----
    // Multiple collections may allocate to the same sale; we sum them all.
    const paidMap = new Map<string, number>()
    for (const col of custCollections) {
      const allocations = col.bill_allocations ?? []
      for (const alloc of allocations) {
        const sid = String(alloc.sale_id)
        paidMap.set(sid, (paidMap.get(sid) ?? 0) + (alloc.amount ?? 0))
      }
    }

    // ---- Build sale-id → damage-amount map by walking damages ----
    // Multiple damages may be attributed to the same sale; we sum them all.
    const damageMap = new Map<string, number>()
    for (const dmg of custDamages) {
      const sid = String(dmg.sale_id)
      damageMap.set(sid, (damageMap.get(sid) ?? 0) + (dmg.expense_value ?? 0))
    }

    // ---- Build the BillDue rows ----
    const rows: BillDue[] = creditSales.map((sale) => {
      const sid = String(sale.id)
      const paid = paidMap.get(sid) ?? 0
      const damage = damageMap.get(sid) ?? 0
      const remaining = sale.total_amount - paid
      // Net Payable = total - paid - damage (Tally-style "Against Reference"
      // adjustment). Floor at 0 so a bill can't go negative.
      const netPayable = Math.max(0, sale.total_amount - paid - damage)
      return {
        sale,
        invoice_no: sale.invoice_no,
        total_amount: sale.total_amount,
        paid_amount: paid,
        damage_amount: damage,
        net_payable: netPayable,
        remaining_due: remaining,
      }
    })

    // ---- Filter out fully-settled bills unless includePaid ----
    // A bill is "fully settled" when net_payable <= 0 (paid + damage >= total).
    return includePaid
      ? rows
      : rows.filter((r) => r.net_payable > 0.001) // tiny epsilon for float drift
  },

  /**
   * Returns ALL customers' bill dues (for reports / aging analysis).
   * Grouped by customer for easy iteration.
   */
  async all(): Promise<
    { customer: Customer; bills: BillDue[]; totalRemaining: number }[]
  > {
    const customers = await db.customers.toArray()
    const out: { customer: Customer; bills: BillDue[]; totalRemaining: number }[] =
      []
    for (const c of customers) {
      const bills = await this.byCustomer(c.id!, false)
      if (bills.length === 0) continue
      const totalRemaining = bills.reduce(
        (s, b) => s + b.remaining_due,
        0
      )
      out.push({ customer: c, bills, totalRemaining })
    }
    return out
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
//
// Upgrade 3 — Damage Source:
//   - damage_source = 'godown' (default) → deducts from sellable godown stock
//   - damage_source = 'store'  → does NOT touch sellable stock; tracked
//                                separately as "Damaged Stock (Store)".
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
      // Upgrade 3 — resolve the damage source. Defaults to 'godown' for
      // backward compatibility (undefined / missing field on legacy callers).
      const source: 'godown' | 'store' =
        d.damage_source === 'store' ? 'store' : 'godown'
      const damageId = await db.damages.add({
        ...d,
        // Normalize business date to YYYY-MM-DD (Change 2)
        date: isoBusinessDate(d.date),
        // Persist the resolved source (never undefined) so sync round-trips
        // are deterministic and Inventory can group by source.
        damage_source: source,
        // customer_id / customer_name only meaningful when source = 'store'
        customer_id: source === 'store' ? d.customer_id : undefined,
        customer_name: source === 'store' ? d.customer_name : undefined,
        // Task 2 — Bill-wise damage allocation. sale_id + against_invoice_no
        // only meaningful when source = 'store' AND the user attributed the
        // damage to a specific bill. Both nullable → undefined for godown
        // damages or unattributed store damages.
        sale_id: source === 'store' ? d.sale_id : undefined,
        against_invoice_no: source === 'store' ? d.against_invoice_no : undefined,
        expense_value: expenseValue,
        created_at: new Date().toISOString(),
        isSynced: false,
        synced_at: null,
      })
      // Upgrade 3 — only decrement sellable godown stock when source = 'godown'.
      // Store damages are tracked separately and do NOT reduce good inventory.
      if (prod && source === 'godown') {
        await db.products.update(d.product_id, {
          opening_stock_pcs: prod.opening_stock_pcs - d.total_pcs,
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
      // Upgrade 3 — only restore godown stock if the original damage had
      // actually deducted it (i.e. damage_source === 'godown'). Legacy rows
      // with `damage_source === undefined` are treated as 'godown' too.
      const wasGodown = damage.damage_source !== 'store'
      if (wasGodown) {
        const prod = await db.products.get(damage.product_id)
        if (prod) {
          await db.products.update(damage.product_id, {
            opening_stock_pcs: prod.opening_stock_pcs + damage.total_pcs,
            isSynced: false,
            synced_at: null,
          })
        }
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
    // ---- Bug fix (same as nextCustomerId): Math.max() over parsed suffixes.
    const year = new Date().getFullYear()
    const all = await db.purchase_returns.toArray()
    let maxNum = 0
    for (const r of all) {
      const raw = r.return_no ?? ''
      const match = raw.match(/(\d+)\s*$/)
      if (match) {
        const n = parseInt(match[1], 10)
        if (!isNaN(n) && n > maxNum) maxNum = n
      }
    }
    const next = maxNum > 0 ? maxNum + 1 : all.length + 1
    return `PR-${year}-${String(next).padStart(4, '0')}`
  },

  async create(r: Omit<PurchaseReturn, 'id' | 'created_at' | 'return_no'>): Promise<number> {
    const returnId = await db.transaction('rw', db.purchase_returns, db.products, async () => {
      const prod = await db.products.get(r.product_id)
      const returnNo = await this.nextReturnNo()
      const returnId = await db.purchase_returns.add({
        ...r,
        // Normalize business date to YYYY-MM-DD (Change 2)
        date: isoBusinessDate(r.date),
        return_no: returnNo,
        created_at: new Date().toISOString(),
        isSynced: false,
        synced_at: null,
      })
      // Decrement product stock + mark un-synced
      if (prod) {
        await db.products.update(r.product_id, {
          opening_stock_pcs: prod.opening_stock_pcs - r.total_pcs,
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
    // ---- Bug fix (same as nextCustomerId): Math.max() over parsed suffixes.
    const year = new Date().getFullYear()
    const all = await db.sales_returns.toArray()
    let maxNum = 0
    for (const r of all) {
      const raw = r.return_no ?? ''
      const match = raw.match(/(\d+)\s*$/)
      if (match) {
        const n = parseInt(match[1], 10)
        if (!isNaN(n) && n > maxNum) maxNum = n
      }
    }
    const next = maxNum > 0 ? maxNum + 1 : all.length + 1
    return `SR-${year}-${String(next).padStart(4, '0')}`
  },

  async create(r: Omit<SalesReturn, 'id' | 'created_at' | 'return_no'>): Promise<number> {
    const returnId = await db.transaction('rw', db.sales_returns, db.products, async () => {
      const prod = await db.products.get(r.product_id)
      const returnNo = await this.nextReturnNo()
      const returnId = await db.sales_returns.add({
        ...r,
        // Normalize business date to YYYY-MM-DD (Change 2)
        date: isoBusinessDate(r.date),
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
            opening_stock_pcs: prod.opening_stock_pcs - ret.total_pcs,
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
      _meta: {
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
      meta: await db.meta.toArray(),
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
        db.purchase_returns, db.sales_returns, db.meta,
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
        await db.meta.clear()
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
        // Restore meta table (or set seeded=true if backup predates the meta table)
        if (data.meta?.length) {
          await db.meta.bulkPut(data.meta)
        } else {
          await db.meta.put({ key: 'seeded', value: true })
        }
      }
    )
    // After import, push everything to the backend (if online).
    scheduleSync('products')
  },

  /**
   * Seed sample data ONLY on the very first launch of the app.
   *
   * Uses a `meta` table flag (`seeded = true`) to ensure seeding runs exactly
   * once per browser. After the first seed, subsequent page refreshes will
   * find `seeded = true` in the meta table and skip seeding entirely — even
   * if the user has deleted all products/customers.
   *
   * This is the critical fix for the "IndexedDB overwrite on page refresh"
   * bug: previously, seedIfEmpty() checked `productCount === 0`, which meant
   * deleting all products and refreshing the page would re-inject mock data.
   * Now the meta flag persists across refreshes and is never reset.
   */
  async seedIfEmpty(): Promise<void> {
    // Check the meta table first — if `seeded` flag exists, NEVER re-seed.
    const alreadySeeded = await db.meta.get('seeded')
    if (alreadySeeded?.value === true) {
      // The DB has been initialized before. Do NOT seed, do NOT overwrite.
      // IndexedDB is the single source of truth.
      return
    }

    // First-ever launch — seed sample data.
    // v5 — seeded records are marked un-synced so the SyncService will push
    // them to the PostgreSQL backend on first launch (if configured).
    const UNSYNCED = { isSynced: false, synced_at: null }
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

    // Mark the database as seeded so this NEVER runs again, even if the user
    // deletes all products/customers or refreshes the page while offline.
    // This is the critical guard that makes IndexedDB the single source of truth.
    await db.meta.put({ key: 'seeded', value: true })
  },
}

// ============================================================================
// FMCG Distribution ERP — Dexie.js (IndexedDB) Local Database Layer
// 100% offline-first. No Supabase. No backend.
// ============================================================================

import Dexie, { type Table } from 'dexie'

// ----------------------------------------------------------------------------
// Type definitions
// ----------------------------------------------------------------------------

export interface Product {
  id?: number
  sku: string
  company_name: string
  name: string
  category?: string
  hsn_code: string
  base_unit: string // e.g. "Pcs"
  outer_unit: string // e.g. "Bag"
  conversion_factor: number // 1 outer = N base (e.g. 1 Bag = 200 Pcs)
  pack_size?: string // e.g. "200g", "500ml"

  // --------------------------------------------------------------------------
  // v4 — Per-piece pricing model (flipped)
  // --------------------------------------------------------------------------
  // USER INPUTS (primary):
  //   purchase_rate_per_outer_unit — total buying price per Bag/Peti (e.g. ₹600)
  //   selling_rate_per_piece       — default selling rate per Pcs (e.g. ₹3.50)
  //
  // AUTO-COMPUTED & PERSISTED (so POS profit calc never re-derives):
  //   purchase_rate_per_piece      = purchase_rate_per_outer_unit / conversion_factor
  //   selling_rate_per_outer_unit = selling_rate_per_piece * conversion_factor
  // --------------------------------------------------------------------------
  purchase_rate_per_outer_unit: number
  purchase_rate_per_piece: number
  selling_rate_per_piece: number
  selling_rate_per_outer_unit: number

  // Legacy aliases (deprecated) — kept for backward compat with v1/v2/v3 rows.
  // New code reads these as fallbacks only. ProductService always writes both
  // old + new names when persisting, so legacy UI code keeps working.
  purchase_rate?: number // === purchase_rate_per_outer_unit
  sales_rate?: number // === selling_rate_per_outer_unit
  purchase_rate_per_pcs?: number // === purchase_rate_per_piece
  sales_rate_per_pcs?: number // === selling_rate_per_piece

  gst_percent: number
  opening_stock_pcs: number // opening stock in base (Pcs) units
  created_at: string

  // v5 — Hybrid sync. Defaults to false on local create; flipped to true once
  // the row has been successfully pushed to the PostgreSQL backend.
  isSynced?: boolean
  synced_at?: string | null
}

export interface Customer {
  id?: number
  customer_id: string // human-readable code, e.g. CUST-001
  name: string
  route_area: string
  phone: string
  gstin?: string
  opening_balance: number // opening dues (positive = customer owes us)
  bill_number?: string // optional customer bill/reference number
  created_at: string

  // v5 — Hybrid sync
  isSynced?: boolean
  synced_at?: string | null
}

export interface Purchase {
  id?: number
  bill_no: string
  date: string // YYYY-MM-DD
  supplier_name: string
  supplier_gstin?: string
  product_id: number
  product_sku: string
  product_name: string
  hsn_code: string
  bag_qty: number
  pcs_qty: number
  total_pcs: number // bag_qty * conversion_factor + pcs_qty
  purchase_rate: number
  gst_percent: number
  taxable_amount: number
  cgst: number
  sgst: number
  total_amount: number
  mfg_date?: string // manufacturing date (YYYY-MM-DD), optional
  expiry_date?: string // expiry date (YYYY-MM-DD), optional
  created_at: string

  // v5 — Hybrid sync
  isSynced?: boolean
  synced_at?: string | null
}

export interface SaleItem {
  id?: number
  sale_id: number
  product_id: number
  product_name: string
  product_sku: string
  hsn_code: string
  quantity_pcs: number // billed qty in Pcs
  rate: number // selling rate per Pcs (excluding GST)
  gst_percent: number
  taxable_amount: number
  cgst: number
  sgst: number
  total: number
  purchase_rate: number // purchase cost per Pcs (for profit calc)
  item_profit: number
  item_margin_percent: number

  // v5 — Hybrid sync
  isSynced?: boolean
  synced_at?: string | null
}

export interface Sale {
  id?: number
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
  paid_amount: number // for cash sales = total; for credit = 0 (until collection)
  created_at: string

  // v5 — Hybrid sync
  isSynced?: boolean
  synced_at?: string | null
}

export interface Collection {
  id?: number
  date: string
  customer_id: number
  customer_name: string
  amount: number
  payment_mode: 'Cash' | 'Cheque' | 'UPI' | 'Bank'
  notes?: string
  created_at: string

  // v5 — Hybrid sync
  isSynced?: boolean
  synced_at?: string | null
}

export interface DistributorSettings {
  id?: number
  store_name: string
  // v6 — Optional subtitle/tagline shown beneath the store name on the
  // printable invoice header (e.g. "Distributor Of: Too Yumm / Trsna Water").
  subtitle?: string
  gstin: string
  address: string
  phone: string
  email: string
  logo_url?: string
  invoice_prefix: string
  state: string
  // v6 — Bank details shown on the printed memo/invoice footer
  bank_details?: string

  // v5 — Hybrid sync (settings only syncs when edited)
  isSynced?: boolean
  synced_at?: string | null
}

// ----------------------------------------------------------------------------
// Damage / Expiry / Stock-write-off adjustment
// ----------------------------------------------------------------------------

export type DamageReason = 'Broken' | 'Expired' | 'Leaked' | 'Pilferage' | 'Quality'

export interface Damage {
  id?: number
  date: string
  product_id: number
  product_sku: string
  product_name: string
  hsn_code: string
  bag_qty: number
  pcs_qty: number
  total_pcs: number
  reason: DamageReason
  notes?: string
  // Cost valuation at the moment of damage (purchase_rate_per_pcs × total_pcs)
  expense_value: number
  created_at: string

  // v5 — Hybrid sync
  isSynced?: boolean
  synced_at?: string | null
}

// ----------------------------------------------------------------------------
// Purchase Return (return TO supplier) — deducts stock, credits supplier
// ----------------------------------------------------------------------------

export interface PurchaseReturn {
  id?: number
  date: string
  original_purchase_id?: number
  return_no: string
  supplier_name: string
  supplier_gstin?: string
  product_id: number
  product_sku: string
  product_name: string
  hsn_code: string
  bag_qty: number
  pcs_qty: number
  total_pcs: number
  purchase_rate: number // rate per OUTER unit
  purchase_rate_per_pcs: number
  gst_percent: number
  taxable_amount: number
  cgst: number
  sgst: number
  total_amount: number // credit value from supplier
  reason?: string
  created_at: string

  // v5 — Hybrid sync
  isSynced?: boolean
  synced_at?: string | null
}

// ----------------------------------------------------------------------------
// Sales Return (return FROM customer) — restocks usable goods, credits customer
// ----------------------------------------------------------------------------

export interface SalesReturn {
  id?: number
  date: string
  original_sale_id?: number
  return_no: string
  customer_id: number
  customer_name: string
  product_id: number
  product_sku: string
  product_name: string
  hsn_code: string
  bag_qty: number
  pcs_qty: number
  total_pcs: number
  sales_rate_per_pcs: number
  gst_percent: number
  taxable_amount: number
  cgst: number
  sgst: number
  total_amount: number // credit value to customer
  restock: boolean // true → goods re-enter inventory; false → goods discarded
  reason?: string
  created_at: string

  // v5 — Hybrid sync
  isSynced?: boolean
  synced_at?: string | null
}

// ----------------------------------------------------------------------------
// Meta table — stores initialization flags so we never re-seed after the
// first launch, even if the user deletes all products/customers.
// ----------------------------------------------------------------------------

export interface MetaRow {
  key: string
  value: any
}

// ----------------------------------------------------------------------------
// Dexie database class
// ----------------------------------------------------------------------------

export class FmcgDatabase extends Dexie {
  products!: Table<Product, number>
  customers!: Table<Customer, number>
  purchases!: Table<Purchase, number>
  sales!: Table<Sale, number>
  sale_items!: Table<SaleItem, number>
  collections!: Table<Collection, number>
  distributor_settings!: Table<DistributorSettings, number>
  damages!: Table<Damage, number>
  purchase_returns!: Table<PurchaseReturn, number>
  sales_returns!: Table<SalesReturn, number>
  meta!: Table<MetaRow, string>

  constructor() {
    super('FmcgErpDatabase')
    this.version(1).stores({
      products:
        '++id, sku, company_name, name, category, hsn_code, base_unit, outer_unit, created_at',
      customers: '++id, customer_id, name, route_area, phone, gstin, created_at',
      purchases:
        '++id, bill_no, date, supplier_name, supplier_gstin, product_id, product_sku, created_at',
      sales: '++id, invoice_no, date, customer_id, customer_name, payment_mode, created_at',
      sale_items: '++id, sale_id, product_id, product_sku',
      collections: '++id, date, customer_id, customer_name, payment_mode',
      distributor_settings: '++id, store_name',
    })
    // v2 — added created_at index to collections (auto-applied for new installs)
    this.version(2).stores({
      collections: '++id, date, customer_id, customer_name, payment_mode, created_at',
    })
    // v3 — Damage / Expiry adjustments + Purchase/Sales Returns.
    // Existing tables are NOT modified — only new tables added.
    this.version(3).stores({
      damages: '++id, date, product_id, product_sku, reason, created_at',
      purchase_returns:
        '++id, date, return_no, supplier_name, supplier_gstin, product_id, product_sku, created_at',
      sales_returns:
        '++id, date, return_no, customer_id, customer_name, product_id, product_sku, restock, created_at',
    })
    // v4 — Per-piece pricing model. No index changes (the new rate fields are
    // scalar values read by UI, not indexed for query). Existing product rows
    // keep their old `purchase_rate` / `sales_rate` fields; ProductService now
    // also writes the new `*_per_outer_unit` / `*_per_piece` fields on every
    // save and falls back to legacy values on read.
    this.version(4).stores({
      products:
        '++id, sku, company_name, name, category, hsn_code, base_unit, outer_unit, created_at',
    })
    // v5 — Hybrid sync. Adds `isSynced` index to every transactional table so
    // the SyncService can efficiently query "WHERE isSynced != true" to find
    // pending records. Existing rows have isSynced=undefined (treated as false
    // by the sync query). No data migration needed.
    this.version(5).stores({
      products:
        '++id, sku, company_name, name, category, hsn_code, base_unit, outer_unit, created_at, isSynced',
      customers: '++id, customer_id, name, route_area, phone, gstin, created_at, isSynced',
      purchases:
        '++id, bill_no, date, supplier_name, supplier_gstin, product_id, product_sku, created_at, isSynced',
      sales: '++id, invoice_no, date, customer_id, customer_name, payment_mode, created_at, isSynced',
      sale_items: '++id, sale_id, product_id, product_sku, isSynced',
      collections: '++id, date, customer_id, customer_name, payment_mode, created_at, isSynced',
      distributor_settings: '++id, store_name, isSynced',
      damages: '++id, date, product_id, product_sku, reason, created_at, isSynced',
      purchase_returns:
        '++id, date, return_no, supplier_name, supplier_gstin, product_id, product_sku, created_at, isSynced',
      sales_returns:
        '++id, date, return_no, customer_id, customer_name, product_id, product_sku, restock, created_at, isSynced',
    })
    // v6 — Meta table for tracking initialization state.
    // This prevents re-seeding mock data on page refresh even if the user has
    // deleted all products/customes. The `seeded` flag is set once on first
    // launch and never re-checked against table counts again.
    this.version(6).stores({
      meta: 'key',
    })
  }
}

export const db = new FmcgDatabase()

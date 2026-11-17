'use client'

import { useLiveQuery } from 'dexie-react-hooks'
import {
  ProductService,
  CustomerService,
  PurchaseService,
  SaleService,
  CollectionService,
  InventoryService,
  DuesService,
  SettingsService,
  DamageService,
  PurchaseReturnService,
  SalesReturnService,
  BillDuesService,
} from '@/lib/services/repository'

// Live query hooks — auto re-render when IndexedDB changes.
// UI plugins consume these; they never touch Dexie directly.

export function useProducts() {
  return useLiveQuery(() => ProductService.all(), [])
}

export function useCustomers() {
  return useLiveQuery(() => CustomerService.all(), [])
}

export function usePurchases() {
  return useLiveQuery(() => PurchaseService.all(), [])
}

export function useSales() {
  return useLiveQuery(() => SaleService.all(), [])
}

export function useSaleItems(saleId: number | undefined) {
  return useLiveQuery(
    async () => (saleId ? SaleService.itemsBySale(saleId) : []),
    [saleId]
  )
}

// Fetch ALL sale items — used by GST Reports for company-wise filtering.
export function useAllSaleItems() {
  return useLiveQuery(async () => {
    const { db } = await import('@/lib/db/dexie')
    return db.sale_items.toArray()
  }, [])
}

export function useCollections() {
  return useLiveQuery(() => CollectionService.all(), [])
}

export function useInventory() {
  return useLiveQuery(() => InventoryService.all(), [])
}

export function useDues() {
  return useLiveQuery(() => DuesService.all(), [])
}

export function useSettings() {
  return useLiveQuery(() => SettingsService.get(), [])
}

// v3 — Damage & Returns
export function useDamages() {
  return useLiveQuery(() => DamageService.all(), [])
}

export function usePurchaseReturns() {
  return useLiveQuery(() => PurchaseReturnService.all(), [])
}

export function useSalesReturns() {
  return useLiveQuery(() => SalesReturnService.all(), [])
}

export function useDamageTotals() {
  return useLiveQuery(() => DamageService.totals(), [])
}

// ----------------------------------------------------------------------------
// Bill-wise dues — Tally-style "Against Reference" allocation support.
// Returns undefined while the query is in flight (same convention as the other
// hooks above). When `customerId` is null/undefined, returns an empty array
// immediately so the UI can render an empty state without a flash.
//
// Reactive: re-runs whenever `sales` OR `collections` tables change in
// IndexedDB (because BillDuesService.all() reads both), so any new collection
// or sale edit automatically refreshes the outstanding-bills breakdown.
// ----------------------------------------------------------------------------
export function useBillDues(
  customerId: number | null | undefined
) {
  return useLiveQuery(
    async () => {
      if (customerId == null) return []
      return BillDuesService.byCustomer(customerId, false)
    },
    [customerId]
  )
}

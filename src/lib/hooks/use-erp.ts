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

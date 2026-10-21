# FMCG ERP — Architecture Documentation

This document describes the layered architecture, schema design, sync engine, and core algorithms of the FMCG Distribution House ERP & Billing application.

---

## 1. Hexagonal / Plugin Architecture

The codebase follows a **hexagonal** (ports-and-adapters) pattern with a strict separation between the storage engines, the service layer, and the UI plugins.

```
┌─────────────────────────────────────────────────────────────┐
│                    UI PLUGINS LAYER                          │
│  Dashboard · ProductMaster · CustomerMaster · PurchaseEntry │
│  SalesBill · SalesLedger · Collections · Inventory          │
│  Damages · StockReturns · GstReports · Settings             │
│  SyncStatusBadge · SyncProvider                             │
└────────────────────────────┬────────────────────────────────┘
                             │ consumes (via hooks)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                   LIVE-QUERY HOOKS LAYER                     │
│  useProducts · useCustomers · useSales · useInventory ·     │
│  useDamages · usePurchaseReturns · useSalesReturns · ...     │
└────────────────────────────┬────────────────────────────────┘
                             │ calls
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    SERVICE LAYER (CORE)                      │
│  ProductService · CustomerService · PurchaseService ·        │
│  SaleService · CollectionService · InventoryService ·       │
│  DuesService · DamageService · PurchaseReturnService ·      │
│  SalesReturnService · SettingsService · BackupService       │
│                                                              │
│  + Pure helpers:                                            │
│    getPurchaseRatePerPiece · getSellingRatePerPiece · ...   │
│                                                              │
│  + SyncService (v5):                                        │
│    syncAllPending · scheduleSync · initNetworkListeners     │
└────────────┬───────────────────────────────┬───────────────┘
             │                                │
             ▼                                ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│   Dexie.js / IndexedDB │         │   Next.js API Routes      │
│   (Primary, offline)   │         │   /api/sync/push           │
│                         │         │   /api/sync/status         │
│   10 object stores:     │         │                            │
│   products, customers,  │         │   Uses Prisma to upsert    │
│   purchases, sales,     │         │   into PostgreSQL          │
│   sale_items, ...       │         │                            │
└─────────────────────────┘         └──────────┬───────────────┘
                                               │
                                               ▼
                                    ┌──────────────────────────┐
                                    │   PostgreSQL Database     │
                                    │   10 tables + audit log   │
                                    └──────────────────────────┘
```

### Why this matters

- **Adding a new UI module** = create one file in `src/components/erp/modules/`, add a nav entry in `src/app/page.tsx`. No changes to services or DB.
- **Adding a new DB table** = add interface + table definition in `dexie.ts` (bump schema version), add model in `prisma/schema.prisma`, add service in `repository.ts`, add hook in `use-erp.ts`, add upsert handler in `/api/sync/push/route.ts`. UI plugins can then consume the new data.
- **Modifying business logic** (e.g. profit formula) lives in the service layer — UI plugins never duplicate calculations.
- **Sync is invisible to UI plugins** — services call `scheduleSync(entity)` fire-and-forget; the UI never blocks on network.

---

## 2. Dexie.js Schema (v5)

The full schema lives in `src/lib/db/dexie.ts`. The DB class:

```ts
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
}
```

### Schema versioning history

| Version | Changes |
|---------|---------|
| **v1** | Initial schema — 7 tables (products, customers, purchases, sales, sale_items, collections, distributor_settings). |
| **v2** | Added `created_at` index to `collections` (was missing in v1). |
| **v3** | Added 3 new tables: `damages`, `purchase_returns`, `sales_returns`. No changes to existing tables. |
| **v4** | Added new scalar rate fields to `Product` (per-piece pricing model). No index changes — only the persisted product shape changes. |
| **v5** | Added `isSynced` + `synced_at` to every table for hybrid sync. Added `isSynced` index for efficient "WHERE isSynced != true" queries. |

Dexie's `version(n).stores(...)` calls are **additive** — calling `version(5).stores({...})` only updates the indexes for the listed tables; existing rows are not touched. The new scalar fields (`isSynced`, `synced_at`) become `undefined` on legacy rows and are filled in lazily by helper functions or on next save.

### Index strategy

Indexes are declared **only for fields that are queried** — never for scalar display values. The v5 schema adds `isSynced` to every table index because the SyncService queries `WHERE isSynced != true` on every sync cycle.

Current indexes (v5):
- `products`: `++id, sku, company_name, name, category, hsn_code, base_unit, outer_unit, created_at, isSynced`
- `customers`: `++id, customer_id, name, route_area, phone, gstin, created_at, isSynced`
- `purchases`: `++id, bill_no, date, supplier_name, supplier_gstin, product_id, product_sku, created_at, isSynced`
- `sales`: `++id, invoice_no, date, customer_id, customer_name, payment_mode, created_at, isSynced`
- `sale_items`: `++id, sale_id, product_id, product_sku, isSynced`
- `collections`: `++id, date, customer_id, customer_name, payment_mode, created_at, isSynced`
- `damages`: `++id, date, product_id, product_sku, reason, created_at, isSynced`
- `purchase_returns`: `++id, date, return_no, supplier_name, supplier_gstin, product_id, product_sku, created_at, isSynced`
- `sales_returns`: `++id, date, return_no, customer_id, customer_name, product_id, product_sku, restock, created_at, isSynced`
- `distributor_settings`: `++id, store_name, isSynced`

---

## 3. v4 Per-Piece Pricing Model

The Product schema stores **four explicit rate fields**:

```ts
interface Product {
  // ... other fields ...

  // USER INPUTS (primary):
  purchase_rate_per_outer_unit: number  // total buying price per Bag/Peti
  selling_rate_per_piece: number        // primary default selling rate per Pcs

  // AUTO-COMPUTED & PERSISTED:
  purchase_rate_per_piece: number       // = purchase_rate_per_outer_unit / conversion_factor
  selling_rate_per_outer_unit: number   // = selling_rate_per_piece * conversion_factor

  // Legacy aliases (kept in sync so old code keeps working):
  purchase_rate?: number
  sales_rate?: number
  purchase_rate_per_pcs?: number
  sales_rate_per_pcs?: number

  // v5 sync flags:
  isSynced?: boolean
  synced_at?: string | null
}
```

### Why flip the input model?

Pre-v4, the user entered the **selling rate per Bag** and the system divided by `conversion_factor` to derive the per-Pcs rate. This caused rounding errors (e.g. ₹260/200 = ₹1.30, but ₹480/48 = ₹10.00 exactly, while ₹479/48 = ₹9.9792). Distributors typically think in per-piece selling terms at the counter, so the v4 model takes **selling rate per Pcs** as the primary input and derives the per-Bag selling rate by multiplication (always exact).

### Helper functions (in `repository.ts`)

```ts
// Pure compute functions
computePurchaseRatePerPiece(outerRate, conversionFactor)  // ÷
computeSellingRatePerOuterUnit(perPieceRate, conversionFactor)  // ×

// Read with fallback chain (v4 → legacy → on-the-fly)
getPurchaseRatePerPiece(product)
getSellingRatePerPiece(product)
getPurchaseRatePerOuterUnit(product)
getSellingRatePerOuterUnit(product)

// Composed helpers
getProfitPerPiece(product)         // = sell/Pcs − buy/Pcs
getMarginPercentPerPiece(product)  // = profit/Pcs ÷ sell/Pcs × 100
```

---

## 4. v5 Hybrid Sync Engine

The sync engine lives in `src/lib/services/sync.ts`. It is **single-flight, idempotent, and observable**.

### Public API

```ts
// Subscribe to sync state changes (for UI rendering)
onSyncStateChange(listener: (state: SyncState) => void): () => void

// Get current snapshot
getSyncState(): SyncState

// Initialize window online/offline listeners + 30s periodic timer
// Returns a cleanup function.
initNetworkListeners(): () => void

// Refresh pending counts from IndexedDB
refreshPendingCounts(): Promise<void>

// Manually trigger a sync (used by "Sync Now" buttons)
triggerSyncNow(): Promise<void>

// Fire-and-forget sync (called by every service after a write)
scheduleSync(entity: EntityName): void

// Full sync of all pending records (idempotent, single-flight)
syncAllPending(): Promise<{ syncedCounts, errors }>
```

### SyncState shape

```ts
interface SyncState {
  isOnline: boolean              // navigator.onLine
  isSyncing: boolean             // true while a sync is running
  pendingCounts: Record<EntityName, number>  // per-entity counts
  totalPending: number           // sum of all pendingCounts
  lastSyncAt: string | null      // ISO timestamp of last successful sync
  lastError: string | null       // last error message (null if no error)
}
```

### Single-flight design

If `syncAllPending()` is called while a sync is already running, it sets `pendingTrigger = true` and returns immediately. When the current sync completes, if `pendingTrigger` is true, it kicks off another sync. This prevents multiple parallel syncs from racing.

### Network listener lifecycle

`SyncProvider` (mounted in `src/app/layout.tsx`) calls `initNetworkListeners()` on mount. This registers:

- `window.addEventListener('online', updateOnlineStatus)` — triggers `scheduleSyncAll()` when internet returns
- `window.addEventListener('offline', updateOnlineStatus)` — updates the badge to show "Offline"
- `setInterval(checkAndSync, 30_000)` — every 30s, re-checks `navigator.onLine` and attempts a sync if there are pending records

The `SyncProvider` also listens for `document.visibilitychange` — when the user returns to the tab, pending counts are refreshed so the badge stays accurate.

### Sync API contract

#### POST /api/sync/push

**Request body:**

```json
{
  "batches": {
    "products": [{...}, {...}],
    "customers": [{...}],
    "sales": [{...}],
    "sale_items": [{...}],
    "collections": [],
    "damages": [],
    "purchase_returns": [],
    "sales_returns": [],
    "distributor_settings": []
  }
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "results": {
    "products": { "count": 5, "ids": [1, 2, 3, 4, 5] },
    "customers": { "count": 1, "ids": [10] }
  },
  "errors": []
}
```

**Response (partial failure):**

```json
{
  "success": false,
  "results": {
    "products": { "count": 4, "ids": [1, 2, 3, 4] }
  },
  "errors": [
    { "entity": "products", "id": 5, "message": "Column 'sku' cannot be null" }
  ]
}
```

The client uses the `ids` array to flip `isSynced=true` only for the records that were successfully pushed. Failed records remain `isSynced=false` and will be retried on the next sync cycle.

#### GET /api/sync/status

Returns server-side row counts per entity, useful for debugging:

```json
{
  "ok": true,
  "serverTime": "2026-10-19T15:30:00.000Z",
  "counts": {
    "products": 5,
    "customers": 4,
    "purchases": 12,
    "sales": 8,
    "sale_items": 23,
    "collections": 5,
    "distributor_settings": 1,
    "damages": 2,
    "purchase_returns": 1,
    "sales_returns": 0
  }
}
```

If PostgreSQL is unreachable, returns 503:

```json
{
  "ok": false,
  "serverTime": "2026-10-19T15:30:00.000Z",
  "error": "Database connection failed",
  "hint": "PostgreSQL backend is unreachable. The offline ERP continues to work — records will be queued locally (isSynced=false) and pushed once the backend is available."
}
```

### Idempotent upserts

The server uses Prisma's `upsert` (create-or-update) for every record. The primary key is the local Dexie `id` (an integer), which is sent in the payload. This means:

- Re-pushing the same record is safe — it just updates the existing row.
- If a sync partially succeeds (some records upserted, some failed), the next sync only needs to retry the failed ones.
- The server never auto-generates IDs — it always uses the client-supplied ID. This guarantees consistency between local and remote.

### Failure modes

| Scenario | Behavior |
|----------|----------|
| Offline (`navigator.onLine === false`) | `scheduleSync()` exits immediately; pending counts refresh only. |
| Online but `/api/sync/push` returns 5xx | Records remain `isSynced=false`. `lastError` is set. Next 30s tick retries. |
| Online but Prisma throws (DB unreachable) | API returns 200 with `success: false` + error in `errors[]`. Same retry behavior. |
| Partial success (some records fail) | Successfully-synced records flip to `isSynced=true`. Failed records stay `isSynced=false` and are retried. |
| `bulkUpdate` fails after server confirms | Re-sync will re-push the same records (idempotent). No data corruption. |

---

## 5. POS Billing Profit Engine

The Sales Bill module (`src/components/erp/modules/SalesBill.tsx`) computes line-item profit directly from the persisted per-piece rates:

```ts
const sellingRatePerPiece = getSellingRatePerPiece(product)
const purchaseRatePerPiece = getPurchaseRatePerPiece(product)
const profitPerPiece = sellingRatePerPiece - purchaseRatePerPiece

const taxable = sellingRatePerPiece * quantityPcs
const cgst = (taxable * (gstPercent / 2)) / 100
const sgst = (taxable * (gstPercent / 2)) / 100
const total = taxable + cgst + sgst

const itemProfit = profitPerPiece * quantityPcs
const margin = total > 0 ? (itemProfit / total) * 100 : 0
```

The POS table now displays 5 dedicated columns per line item:
- **Sell/Pcs** — the per-piece selling rate (baseline)
- **Buy/Pcs** — the per-piece purchase rate (baseline)
- **Profit/Pcs** — `Sell/Pcs − Buy/Pcs`, shown with `× N Pcs` multiplier
- **Line Profit** — `Profit/Pcs × Qty`
- **Margin %** — `Line Profit ÷ Total × 100`

### Atomic sale save (transaction)

`SaleService.create` runs a Dexie transaction that atomically:
1. Inserts the `Sale` header row with `isSynced: false`.
2. Inserts all `SaleItem` rows linked to the sale, each with `isSynced: false`.
3. Decrements `opening_stock_pcs` on each affected Product row, marking it `isSynced: false`.

After the transaction commits, `scheduleSync('sales')` is called fire-and-forget.

If any step fails, the entire transaction rolls back — stock never goes out of sync with sales records.

---

## 6. Stock Movement Formula

The Inventory module reconstructs the real-time stock ledger from all movement sources:

```
Closing Pcs =
    Opening Stock Pcs
  + Purchased Pcs            (from purchases table)
  − Sold Pcs                (from sale_items table)
  − Damaged Pcs              (from damages table)
  − Purchase Returned Pcs    (from purchase_returns table)
  + Sales Returned Pcs       (from sales_returns table, only where restock=true)
```

### Why reconstruct rather than just read `opening_stock_pcs`?

The `opening_stock_pcs` field on each Product row is mutated in real time whenever any stock movement occurs (purchase, sale, damage, return). This makes "current closing stock" an O(1) read.

But to display a **ledger** showing *how* the closing stock was derived, we need to reverse the mutations:

```
Original Opening = current_opening_stock_pcs
                  − purchased_pcs
                  + sold_pcs
                  + damaged_pcs
                  + purchase_returned_pcs
                  − sales_returned_pcs (restock only)
```

Then `Closing = Original Opening + all movements`. The `InventoryService.all()` method does this for every product in one pass.

---

## 7. Customer Dues Derivation

Customer outstanding dues are **derived**, never stored as a single mutable balance:

```
Closing Dues =
    Opening Balance (customer.opening_balance)
  + Credit Sales (sum of sales where payment_mode = 'Credit')
  − Collections (sum of collections)
  − Sales Returns (sum of sales_returns.total_amount)
```

Sales returns credit the customer's outstanding balance because the goods are being taken back.

---

## 8. Damage & Stock Adjustment Module

When a damage entry is recorded:

1. The cost value at the moment of damage is computed:
   ```
   expense_value = purchase_rate_per_piece × total_damaged_pcs
   ```
2. A `Damage` row is inserted with the reason, notes, expense value, and `isSynced: false`.
3. The product's `opening_stock_pcs` is decremented by `total_pcs` and flagged `isSynced: false`.
4. `scheduleSync('damages')` is called.

The damage expense is logged for P&L reporting (sum of all `expense_value` is shown in the Damages module's summary cards).

---

## 9. Stock Returns Module

### Purchase Return (return TO supplier)

Stock impact: **−** (goods leave inventory)
Supplier credit: **+** `total_amount` (GST-inclusive)

```ts
PurchaseReturnService.create():
  1. Insert purchase_return row with auto-generated PR-YYYY-NNNN number + isSynced: false
  2. Decrement product.opening_stock_pcs by total_pcs + flag product isSynced: false
  3. scheduleSync('purchase_returns')
```

### Sales Return (return FROM customer)

Stock impact: **+** if `restock=true`, **0** if `restock=false` (discarded)
Customer dues: **−** `total_amount` (credit applied)

```ts
SalesReturnService.create():
  1. Insert sales_return row with auto-generated SR-YYYY-NNNN number + isSynced: false
  2. If restock=true → increment product.opening_stock_pcs by total_pcs + flag isSynced: false
  3. scheduleSync('sales_returns')
  (Customer dues update is derived, no explicit write needed)
```

---

## 10. GST & Tax Reports for CA

The GST Reports module (`GstReports.tsx`) generates three report types:

### GSTR-1 (Outward Supplies — Sales)

- Filtered by month/year
- One row per sales invoice
- Auto-detects **inter-state** vs **intra-state** by comparing the first 2 digits of customer GSTIN vs distributor GSTIN
- Inter-state → IGST (full GST)
- Intra-state → CGST + SGST (split 50/50)
- CSV export includes distributor header + totals row

### GSTR-2 (Inward Supplies — Purchases / ITC)

- Filtered by month/year
- One row per purchase entry
- Shows input tax credit (CGST + SGST) available to claim
- CSV export

### Monthly GST Summary

- Output GST = sum of CGST + SGST from all sales in the period
- Input GST (ITC) = sum of CGST + SGST from all purchases in the period
- **Net GST = Output − Input** (positive = payable, negative = refundable)
- CSV + TXT (PDF-ready) export

---

## 11. Live Query Hooks

All UI modules use `dexie-react-hooks`'s `useLiveQuery` to subscribe to IndexedDB changes. When any table is mutated, every component depending on that table re-renders automatically — no manual refresh needed.

```ts
// Example: useProducts hook
export function useProducts() {
  return useLiveQuery(() => ProductService.all(), [])
}
```

This is what enables the **Dashboard** to update instantly when a sale is recorded in **Sales Bill POS**, without any event bus or state management library.

---

## 12. Print-Friendly Invoice Layout

The Sales Bill module renders an A4 invoice inside a modal. The print CSS (in `globals.css`) ensures:

```css
@media print {
  body * { visibility: hidden !important; }
  .print-area, .print-area * { visibility: visible !important; }
  .print-area {
    position: absolute !important;
    inset: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    box-shadow: none !important;
  }
  .no-print { display: none !important; }
  @page { margin: 12mm; size: A4; }
}
```

When the user clicks "Save & Print Invoice":
1. The sale is saved to IndexedDB (atomic transaction).
2. `scheduleSync('sales')` fires in the background.
3. A printable invoice modal opens with the saved sale details.
4. The user clicks the Print button → browser's native print dialog appears.
5. Only the invoice area prints — sidebar, header, and all other UI elements are hidden.

---

## 13. Backup & Restore (with sync awareness)

The `BackupService` in `repository.ts` provides:

```ts
// Export all 10 tables as a JSON string (includes isSynced flags)
BackupService.export(): Promise<string>

// Import a JSON string and replace all tables
// Restored records are marked isSynced=false so they re-push to PostgreSQL
BackupService.import(json: string): Promise<void>

// Seed sample data if DB is empty (idempotent)
// Seeded records are marked isSynced=false so they push to PostgreSQL on first launch
BackupService.seedIfEmpty(): Promise<void>
```

The export format includes a `meta` block with app name + version (5) + timestamp, then arrays for each table. Restore clears all tables first, then bulk-puts the imported data — all inside a single Dexie transaction. After import, `scheduleSync('products')` is called to push everything to PostgreSQL.

---

## 14. Module Quick Reference

| Module | File | Key Services Consumed |
|--------|------|-----------------------|
| Dashboard | `Dashboard.tsx` | `useSales`, `usePurchases`, `useCollections`, `useDues` |
| Product Master | `ProductMaster.tsx` | `ProductService`, `getPurchaseRatePerPiece`, `getSellingRatePerPiece`, `getProfitPerPiece` |
| Customer Master | `CustomerMaster.tsx` | `CustomerService` |
| Purchase Entry | `PurchaseEntry.tsx` | `PurchaseService`, `getPurchaseRatePerPiece` |
| Sales Bill (POS) | `SalesBill.tsx` | `SaleService`, `getPurchaseRatePerPiece`, `getSellingRatePerPiece`, `getProfitPerPiece` |
| Sales Ledger | `SalesLedger.tsx` | `SaleService` |
| Collections | `Collections.tsx` | `CollectionService`, `DuesService` |
| Inventory | `Inventory.tsx` | `InventoryService` |
| Damages | `Damages.tsx` | `DamageService`, `getPurchaseRatePerPiece` |
| Stock Returns | `StockReturns.tsx` | `PurchaseReturnService`, `SalesReturnService`, `getPurchaseRatePerPiece`, `getSellingRatePerPiece` |
| GST Reports | `GstReports.tsx` | `useSales`, `usePurchases`, `useCustomers`, `useSettings` |
| Settings | `Settings.tsx` | `SettingsService`, `BackupService`, `SyncService` |
| SyncStatusBadge | `SyncStatusBadge.tsx` | `SyncService` (onSyncStateChange, triggerSyncNow) |
| SyncProvider | `SyncProvider.tsx` | `SyncService` (initNetworkListeners, refreshPendingCounts) |

---

## 15. Adding a New Module (Step-by-step)

1. Create `src/components/erp/modules/MyNewModule.tsx`:
   ```tsx
   'use client'
   import { useLiveQuery } from 'dexie-react-hooks'
   import { ProductService } from '@/lib/services/repository'

   export function MyNewModule() {
     const products = useLiveQuery(() => ProductService.all(), [])
     return <div>{products?.length} products</div>
   }
   ```

2. Add a nav entry in `src/app/page.tsx`:
   ```tsx
   // 1. Add to NAV_ITEMS array
   { key: 'my-new-module', label: 'My New Module', icon: SomeIcon, group: 'Custom' }

   // 2. Add to ModuleKey union type
   export type ModuleKey = ... | 'my-new-module'

   // 3. Add to renderModule() switch
   case 'my-new-module': return <MyNewModule />
   ```

3. Import the new component at the top of `page.tsx`.

4. Done — no service layer changes needed if you're reusing existing services.

### Adding a new DB table (with sync)

1. In `src/lib/db/dexie.ts`:
   - Define the interface (`MyNewTable`) — include `isSynced?: boolean` and `synced_at?: string | null`.
   - Add `my_new_table!: Table<MyNewTable, number>` to the class.
   - Bump the schema version: `this.version(6).stores({ my_new_table: '++id, name, created_at, isSynced' })`.

2. In `prisma/schema.prisma`:
   - Add a `model MyNewTable { ... }` mirroring the Dexie interface.
   - Use `Int @id` (matching Dexie's auto-increment integer).

3. In `src/lib/services/repository.ts`:
   - Add `MyNewService` with `all`, `create` (sets `isSynced: false`), `update` (sets `isSynced: false`), `remove` methods.
   - Call `scheduleSync('my_new_table')` after each write.

4. In `src/lib/hooks/use-erp.ts`:
   - Add `useMyNewTable()` hook using `useLiveQuery`.

5. In `src/app/api/sync/push/route.ts`:
   - Add `upsertMyNewTable(rec)` function.
   - Add it to the `UPSERT_HANDLERS` map.
   - Add `my_new_table` to the `BatchPayload` interface.

6. In `src/lib/services/sync.ts`:
   - Add `'my_new_table'` to the `EntityName` union type.
   - Add it to `emptyCounts()`.
   - Add a `getPending(db.my_new_table)` call in `syncAllPending()`.

7. UI plugins can now consume the new data, and writes will auto-sync to PostgreSQL.

---

## 16. File Map

### Critical files (touch these only if you know what you're doing)

| File | Purpose |
|------|---------|
| `src/lib/db/dexie.ts` | DB schema + TypeScript types for all 10 tables (v5) |
| `src/lib/services/repository.ts` | All CRUD services + rate helpers (1100+ lines, central core) |
| `src/lib/services/sync.ts` | v5 Hybrid Sync engine — single-flight, observable |
| `src/lib/utils/format.ts` | INR formatting, amountToWords, CSV/JSON download |
| `src/lib/db.ts` | Prisma client singleton (PostgreSQL) |
| `src/app/page.tsx` | Main shell + nav + module router |
| `src/app/layout.tsx` | Root layout — mounts SyncProvider |
| `src/app/globals.css` | Theme tokens + print CSS |
| `src/app/api/sync/push/route.ts` | POST endpoint — batch upsert to PostgreSQL |
| `src/app/api/sync/status/route.ts` | GET endpoint — server-side row counts |
| `prisma/schema.prisma` | PostgreSQL schema (10 models + SyncAuditLog) |

### Module files (one per ERP feature)

| File | Lines (approx) |
|------|----------------|
| `Dashboard.tsx` | ~250 |
| `ProductMaster.tsx` | ~560 |
| `CustomerMaster.tsx` | ~250 |
| `PurchaseEntry.tsx` | ~370 |
| `SalesBill.tsx` | ~660 (incl. printable invoice) |
| `SalesLedger.tsx` | ~360 |
| `Collections.tsx` | ~370 |
| `Inventory.tsx` | ~230 |
| `Damages.tsx` | ~400 |
| `StockReturns.tsx` | ~690 (Purchase Return + Sales Return tabs) |
| `GstReports.tsx` | ~600 (GSTR-1 + GSTR-2 + Monthly Summary tabs) |
| `Settings.tsx` | ~470 (Distributor + Sync panel + Backup/Restore) |
| `SyncStatusBadge.tsx` | ~110 |
| `SyncProvider.tsx` | ~35 |

---

## 17. Why Hybrid Sync?

The original v1 used Supabase (always-online). v2-v4 removed the backend entirely in favor of pure Dexie.js (always-offline). v5 finds the middle ground:

1. **Offline-first UX** — all reads/writes hit IndexedDB first, so the UI is instant and works without internet.
2. **Backend backup** — PostgreSQL receives a copy of every record, so data survives even if the browser is wiped.
3. **Multi-device sync** — export a JSON backup from device A, restore on device B, and the new device will push its records to PostgreSQL (which can later be pulled by device A).
4. **No data privacy concerns** — data lives on the user's own PostgreSQL instance, not a third-party cloud.
5. **Battle-tested patterns** — single-flight sync, idempotent upserts, graceful failure, and observable state are all industry-standard practices.

Trade-off: the v5 sync is **push-only** (client → server). Pull sync (server → client, for true multi-device real-time collaboration) is a future enhancement. For now, multi-device workflows use the JSON backup/restore as the "pull" mechanism.

---

For setup and deployment instructions, see **[README.md](./README.md)** and **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

# Changelog

All notable changes to the FMCG Distribution House ERP project are documented here.
The project follows [Semantic Versioning](https://semver.org/) for the schema (DB version)
and a separate feature-based versioning for the UI.

---

## [Unreleased]

(no pending changes)

---

## [v5] — 2026-10-20 — Offline-First Hybrid Sync (Dexie.js + PostgreSQL)

### Added
- **Hybrid Sync engine** (`src/lib/services/sync.ts`) — single-flight, observable, idempotent
  - `syncAllPending()` — queries all un-synced records across all 10 tables, batches them by entity type, POSTs to `/api/sync/push`
  - `scheduleSync(entity)` — fire-and-forget; called after every local write
  - `initNetworkListeners()` — registers `window.addEventListener('online', ...)` + `offline` events + a 30s periodic timer
  - `getPendingCounts()` — efficient count of pending records per entity
  - `onSyncStateChange(listener)` — observable state for UI rendering
  - `triggerSyncNow()` — manual sync trigger for the "Sync Now" button
- **`isSynced: boolean` + `synced_at: string | null`** fields added to all 10 Dexie interfaces
- **Dexie schema v5** — added `isSynced` index to every transactional table for efficient "WHERE isSynced != true" queries
- **PostgreSQL backend** via Prisma:
  - `prisma/schema.prisma` refactored from SQLite → PostgreSQL with 10 models + `SyncAuditLog`
  - `src/lib/db.ts` updated with resilient singleton pattern
- **2 Next.js API routes**:
  - `POST /api/sync/push` — accepts `{ batches: { products: [...], sales: [...] } }` payload, upserts each record by primary key, returns successfully-synced IDs per entity
  - `GET /api/sync/status` — health check returning server-side row counts per entity (returns 503 with a clear hint if PostgreSQL is unreachable)
- **SyncStatusBadge** component in app header — real-time Online/Offline/Pending/Synced state with clickable retry
- **SyncProvider** component mounted in root layout — initializes network listeners + visibility-change listener
- **Hybrid Sync panel** in Settings module:
  - Online/Offline status card with last sync timestamp + last error display
  - Per-entity pending counts grid (Products, Customers, Purchases, Sales, Sale Items, Collections, Damages, Purchase Returns, Sales Returns) with total/total ratios
  - "Sync Now" button (disabled when offline or syncing)
  - "How Hybrid Sync Works" explanation card
- **`scheduleSync(entity)`** called after every write in `repository.ts` (ProductService, CustomerService, PurchaseService, SaleService, CollectionService, SettingsService, DamageService, PurchaseReturnService, SalesReturnService, BackupService)
- All seeded sample data marked `isSynced: false` so it pushes to PostgreSQL on first launch
- Backup/restore properly tags imported records as un-synced (so they re-push to PostgreSQL)
- Updated `.env.example` with PostgreSQL connection string example
- New `DEPLOYMENT.md` — PostgreSQL setup (Docker / native / managed) + Prisma migration commands + production build + reverse proxy example + backup cron job setup

### Changed
- `src/app/layout.tsx` now wraps children in `<SyncProvider>` so network listeners mount at app boot
- `src/app/page.tsx` header now renders `<SyncStatusBadge />` instead of the static "Offline · IndexedDB" pill
- `BackupService.import` now marks imported records as `isSynced: false` and calls `scheduleSync('products')` after import
- `BackupService.export` version bumped to 5; includes `isSynced` + `synced_at` fields in the JSON dump
- `Settings.tsx` restructured: Distributor Profile + Hybrid Sync panel side-by-side, Backup/Restore as full-width bottom card

### Backward Compatibility
- Pre-v5 product rows (lacking `isSynced`) are treated as un-synced by the SyncService query (uses a `.filter()` that catches `undefined` values).
- The first time a legacy row is updated, all v5 fields are backfilled automatically.
- The ERP continues to work fully offline if PostgreSQL is unreachable — pending records queue locally and sync automatically once connectivity returns.

---

## [v4] — 2026-10-19 — Per-Piece Pricing Model

### Added
- **New `Product` fields**: `purchase_rate_per_outer_unit`, `purchase_rate_per_piece`,
  `selling_rate_per_piece`, `selling_rate_per_outer_unit` (all auto-computed on save).
- **New repository helpers**: `computePurchaseRatePerPiece`, `computeSellingRatePerOuterUnit`,
  `getPurchaseRatePerPiece`, `getSellingRatePerPiece`, `getPurchaseRatePerOuterUnit`,
  `getSellingRatePerOuterUnit`, `getProfitPerPiece`, `getMarginPercentPerPiece`.
- **Product Master UI**: flipped form — Selling Rate per Pcs is now the primary input;
  live "Auto-Computed Rate Card" preview showing both formulas.
- **POS Billing**: new `Sell/Pcs`, `Buy/Pcs`, `Profit/Pcs` columns per line item +
  `Avg Profit / Pcs` + `Total Pcs` in bill summary.
- **Product dropdown in POS**: shows `Sell ₹X/Pcs · Margin ₹Y/Pcs` next to each item.
- Dexie schema bumped to v4 (additive — no existing rows touched).

### Changed
- `ProductService.create / update` now writes both v4 fields AND legacy aliases
  (4 + 4 = 8 rate fields) in sync, so older code paths continue to resolve.
- `PurchaseEntry`, `Damages`, `StockReturns` UIs updated to use new helper names.
- Seed data updated to populate both v4 and legacy fields.

### Deprecated
- `Product.purchase_rate` → use `purchase_rate_per_outer_unit`
- `Product.sales_rate` → use `selling_rate_per_outer_unit`
- `Product.purchase_rate_per_pcs` → use `purchase_rate_per_piece`
- `Product.sales_rate_per_pcs` → use `selling_rate_per_piece`
- `getPurchaseRatePerPcs` → use `getPurchaseRatePerPiece`
- `getSalesRatePerPcs` → use `getSellingRatePerPiece`
- `computePurchaseRatePerPcs` → use `computePurchaseRatePerPiece`
- `computeSalesRatePerPcs` → kept for legacy callers; prefer `getSellingRatePerPiece`

---

## [v3] — 2026-10-19 — Damage & Stock Returns

### Added
- **3 new Dexie tables**: `damages`, `purchase_returns`, `sales_returns`.
- **Damage & Adjustment module**: record damaged/expired/leaked goods with
  reason (Broken/Expired/Leaked/Pilferage/Quality). Auto-deducts stock and
  logs cost value as expense.
- **Stock Returns module** with two tabs:
  - **Purchase Return (to Supplier)**: deducts stock, credits supplier.
  - **Sales Return (from Customer)**: restocks usable goods (toggle),
    credits customer dues.
- **Auto-generated return numbers**: `PR-YYYY-NNNN` for purchase returns,
  `SR-YYYY-NNNN` for sales returns.
- **Inventory ledger** expanded with 4 new movement columns:
  Damaged, Purchase Returned, Sales Returned (in addition to Opening,
  Purchased, Sold, Closing).
- **Customer Dues** now derived as: Opening + Credit Sales − Collections − Sales Returns.
- **Backup/Restore** updated to include all 10 tables.
- New sidebar items under "Stock" group: Damage & Adjustment, Stock Returns.

---

## [v2] — 2026-10-19 — Offline-First Refactor

### Added
- **Removed Supabase** dependencies and environment variables.
- **Implemented Dexie.js (IndexedDB)** as the sole local DB layer.
- **Hexagonal core** architecture: DB layer → Service layer → Live-query hooks → UI plugins.
- **Unit Hierarchy Logic**: support conversion between `outer_unit` (Bag/Peti)
  and `base_unit` (Pcs) via `conversion_factor`.
- **Item-Level & Total Bill Profit Engine**:
  - `item_profit = (sales_rate − purchase_rate) × quantity_in_base_units`
  - `item_margin_percent = (item_profit / line_total) × 100`
- **Local Backup & Restore** in Settings module (JSON export/import).
- Dexie schema v1 → v2: added `created_at` index to `collections`.
- Updated `tsconfig.app.json` with `"ignoreDeprecations": "5.0"`.
- Fixed all Lucide icon imports: `FileSpreadsheet` → `FileText`.

### Removed
- `@supabase/supabase-js` dependency.
- `src/lib/supabase.ts` client file.
- Supabase environment variable checks from `.env`.

---

## [v1] — Initial Release

### Added
- 7 core modules: Dashboard, Product Master, Customer Master, Purchase Entry,
  Sales Bill (POS), Sales Ledger, Collection & Dues, Inventory, GST & Tax Reports.
- Distributor settings module.
- Print-friendly A4 TAX INVOICE layout.
- CSV export for Sales Ledger, Inventory, GSTR-1, GSTR-2, Monthly GST Summary.
- Number-to-words engine (Indian system).
- Seeded sample data (5 products, 4 customers, distributor settings).
- Responsive sidebar navigation.
- Emerald/slate enterprise color palette.
- Recharts integration for Dashboard charts.

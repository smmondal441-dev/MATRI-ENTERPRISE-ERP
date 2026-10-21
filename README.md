# FMCG Distribution House ERP & Billing

A complete, modern, **offline-first hybrid sync** ERP & billing web application for FMCG (Fast-Moving Consumer Goods) distributors. Built with Next.js 16, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Lucide icons, **Dexie.js (IndexedDB)** for local storage, and **PostgreSQL via Prisma** for backend sync.

All transactions work offline by default. A background SyncService pushes pending records to PostgreSQL whenever internet is available — billing never blocks on network.

---

## ✨ Features

### Core Modules (sidebar navigation)

1. **Dashboard / Daily Summary** — Today's sales, purchases, gross profit, collections, total market dues. 7-day Sales vs Purchases bar chart, profit trend line chart, top dues list, recent sales list.
2. **Product Master** — CRUD with SKU, Company, Product Name, HSN, Outer Unit (Bag/Peti/Carton), Base Unit (Pcs/Gm/Kg/Ml), Conversion Factor (1 Bag = N Pcs), Pack Size, GST%. **v4 per-piece pricing model**: input purchase rate per outer unit + selling rate per piece; system auto-computes `purchase_rate_per_piece` and `selling_rate_per_outer_unit` and persists both.
3. **Customer Master** — CRUD with auto Customer Code, Party Name, Route/Area, Phone, GSTIN, Opening Balance Dues.
4. **Purchase Entry** — Date, Invoice, Supplier + GSTIN, Product picker (auto-fetches SKU, HSN, GST, rate), Bag Qty × Pcs Qty → auto Total Pcs, Taxable, CGST, SGST, Total. Atomically bumps product stock.
5. **Sales Bill (POS / Billing)** — Auto invoice number, customer dropdown, Cash/Credit mode, product search & add to cart, live per-item profit calculation using per-piece rates, real-time "Profit/Pcs" column per line item, Subtotal/CGST/SGST/Grand Total, "Words in Rupees" (Indian system), Save & Print Invoice button. Print-friendly A4 TAX INVOICE layout.
6. **Sales Entry & Ledger** — Master transaction table with Date/Invoice/Customer/Mode/Subtotal/CGST/SGST/Total/Profit/Margin columns, filters (search + Cash/Credit + date range), summary cards, CSV export, view-detail modal showing line items.
7. **Collection & Dues** — Record payments (Cash/UPI/Cheque/Bank), derived customer-wise outstanding (Opening + Credit Sales − Sales Returns − Collections), View History modal per customer.
8. **Inventory (Real-time Stock Ledger)** — Opening Pcs, Purchased Pcs, Sold Pcs, **Damaged Pcs**, **Purchase Returned Pcs**, **Sales Returned Pcs**, Closing Pcs, Closing Bags, Stock Value. Low-stock amber highlight. CSV export.
9. **Damage & Stock Adjustment** — Record damaged/expired/leaked goods with reason (Broken/Expired/Leaked/Pilferage/Quality). Auto-deducts stock and logs cost value as expense.
10. **Stock Returns** — Two-tab module:
    - **Purchase Return (to Supplier)** — deducts stock, credits supplier.
    - **Sales Return (from Customer)** — restocks usable goods (toggle), credits customer dues.
11. **GST & Tax Reports for CA** — Three-tab module:
    - **GSTR-1 (Sales)** — Date/Month/Year filter, IGST auto-detection for inter-state, CSV export with distributor header + totals.
    - **GSTR-2 (Purchases/ITC)** — Month/Year filter, CSV export.
    - **Monthly GST Summary** — Output GST, Input GST (ITC), Net GST Payable/Refundable cards + detail table. CSV + TXT export.
12. **Settings & Backup** — Distributor profile (store name, GSTIN, state, address, phone, email, invoice prefix) + **Hybrid Sync status panel** (per-entity pending counts, Sync Now button) + Live DB snapshot + Backup (export all tables to `.json`) + Restore (upload `.json`).

### v5 Hybrid Sync Features

- 🔴 **SyncStatusBadge** in app header — real-time Online/Offline/Pending/Synced state
- 🔄 **Background SyncService** — pushes un-synced records to PostgreSQL via `/api/sync/push` when `navigator.onLine` is true
- 🌐 **Network listener** — `window.addEventListener('online', ...)` triggers immediate sync of all pending records
- ⏱ **Periodic retry** — every 30s, re-checks for pending records and syncs if online
- 📊 **Per-entity pending counts** — Settings panel shows exactly which tables have un-synced records
- 🔁 **Idempotent upserts** — server uses Prisma `upsert` by primary key, so re-pushing the same record is safe
- 💾 **`isSynced` + `synced_at`** persisted on every local row
- 🛡 **Graceful failure** — if PostgreSQL is unreachable, the ERP continues to work; pending records queue locally

### Additional Features

- 🎨 Emerald/slate enterprise color palette (no indigo/blue by default)
- 📱 Mobile-first responsive layout (tested 768×1024 tablet & 1280×800 desktop)
- 🖨️ Print CSS — only the invoice prints, hides nav/sidebar/buttons
- 🔢 Number-to-words engine using Indian numbering system (Crore/Lakh/Thousand)
- 📊 CSV export with BOM for Excel UTF-8 compatibility
- 💾 JSON backup & restore (full DB dump) — restored records are auto-tagged un-synced for re-push
- 🌱 Seeded sample data on first launch (5 products, 4 customers, distributor settings) — all marked un-synced so they push to PostgreSQL on first run

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| UI Library | React 19 |
| Styling | Tailwind CSS v4 |
| Component Library | shadcn/ui (New York style) + Lucide icons |
| Charts | Recharts |
| **Local Database** | **Dexie.js v4 (IndexedDB)** — primary storage |
| **Backend Database** | **PostgreSQL via Prisma** — sync target |
| Live Query Hooks | dexie-react-hooks |
| Form Library | react-hook-form |
| Animation | Framer Motion |
| Date Utility | date-fns |
| Package Manager | Bun (recommended) or npm / yarn / pnpm |

---

## 📦 Project Structure

```
fmcg-erp/
├── src/
│   ├── app/
│   │   ├── layout.tsx                      # Root layout (mounts SyncProvider)
│   │   ├── page.tsx                        # Main shell with sidebar + module switch
│   │   ├── globals.css                     # Tailwind + theme tokens + print CSS
│   │   └── api/
│   │       ├── route.ts                    # Health-check route
│   │       └── sync/                       # v5 Hybrid Sync API
│   │           ├── push/route.ts           # POST batch upsert to PostgreSQL
│   │           └── status/route.ts         # GET server-side row counts
│   │
│   ├── lib/
│   │   ├── db/
│   │   │   └── dexie.ts                    # Dexie.js DB schema (v5) + type defs
│   │   ├── services/
│   │   │   ├── repository.ts               # Hexagonal service layer (CRUD + rate helpers)
│   │   │   └── sync.ts                     # v5 SyncService — offline-first engine
│   │   ├── hooks/
│   │   │   └── use-erp.ts                  # Live query hooks (useProducts, useSales, ...)
│   │   ├── utils/
│   │   │   └── format.ts                   # INR formatting, amountToWords, CSV download
│   │   ├── db.ts                           # Prisma client singleton (PostgreSQL)
│   │   └── utils.ts                        # cn() Tailwind merge helper
│   │
│   ├── components/
│   │   ├── erp/
│   │   │   ├── modules/                    # 12 ERP modules
│   │   │   │   ├── Dashboard.tsx
│   │   │   │   ├── ProductMaster.tsx
│   │   │   │   ├── CustomerMaster.tsx
│   │   │   │   ├── PurchaseEntry.tsx
│   │   │   │   ├── SalesBill.tsx           # POS Billing + printable invoice
│   │   │   │   ├── SalesLedger.tsx
│   │   │   │   ├── Collections.tsx
│   │   │   │   ├── Inventory.tsx
│   │   │   │   ├── Damages.tsx
│   │   │   │   ├── StockReturns.tsx        # Purchase Return + Sales Return tabs
│   │   │   │   ├── GstReports.tsx          # GSTR-1, GSTR-2, Monthly Summary
│   │   │   │   └── Settings.tsx            # Distributor profile + Sync panel + Backup/Restore
│   │   │   ├── SyncStatusBadge.tsx         # v5 — Online/Offline/Pending badge
│   │   │   ├── SyncProvider.tsx            # v5 — Mounts network listeners
│   │   │   ├── StatCard.tsx
│   │   │   └── EmptyState.tsx
│   │   └── ui/                             # 50+ shadcn/ui components
│   │
│   └── hooks/
│       ├── use-toast.ts
│       └── use-mobile.ts
│
├── prisma/schema.prisma                    # PostgreSQL schema (10 models + SyncAuditLog)
├── public/                                 # Static assets (logo.svg, robots.txt)
├── package.json                            # Dependencies + scripts
├── tsconfig.json                           # TS config (ignoreDeprecations: "5.0")
├── tailwind.config.ts                      # Tailwind v4 config
├── postcss.config.mjs                      # PostCSS for Tailwind v4
├── next.config.ts                          # Next.js standalone build config
├── components.json                         # shadcn/ui config
├── eslint.config.mjs                       # ESLint config
├── .env.example                            # PostgreSQL connection template
├── Caddyfile                               # Gateway config (sandbox use)
├── bun.lock                               # Bun lockfile
├── README.md                               # This file
├── ARCHITECTURE.md                         # Deep dive into schema + sync design
├── CHANGELOG.md                            # Version history (v1 → v5)
└── DEPLOYMENT.md                           # PostgreSQL setup + production deployment
```

---

## 🚀 Quick Start (Local Development)

### Prerequisites

- **Node.js 18+** (recommended 20+)
- **Bun** (recommended) — install from <https://bun.sh>
  - Or any of: npm / yarn / pnpm
- **PostgreSQL 13+** (only needed for backend sync — ERP works without it)

### Install & Run

```bash
# 1. Unzip the archive
unzip fmcg-erp-v5.zip
cd fmcg-erp

# 2. Install dependencies (Bun recommended)
bun install
# — or —
npm install

# 3. (Optional) Configure PostgreSQL backend
cp .env.example .env
# Edit .env to point to your PostgreSQL instance:
#   DATABASE_URL=postgresql://user:pass@localhost:5432/fmcg_erp

# 4. (Optional) Create database tables
bun run db:push

# 5. Start the dev server
bun run dev
# — or —
npm run dev

# 6. Open in browser
# Dev server runs on http://localhost:3000
```

The app will auto-seed sample data on first launch (5 products, 4 customers, distributor settings).

### Running without PostgreSQL

The ERP is fully functional without PostgreSQL configured. The SyncService will detect the missing backend and simply queue records locally (`isSynced=false`). When you later configure `DATABASE_URL` and restart, all pending records will push automatically.

---

## 🔄 How Hybrid Sync Works

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    UI PLUGINS LAYER                          │
│  Dashboard · ProductMaster · ... · Settings + SyncBadge    │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│           SERVICE LAYER (repository.ts + sync.ts)            │
│                                                              │
│  ProductService.create(p) {                                  │
│    1. db.products.add({ ...p, isSynced: false })             │
│    2. scheduleSync('products')  ← fire-and-forget            │
│  }                                                           │
└──────────┬──────────────────────────────────┬───────────────┘
           │                                  │
           ▼                                  ▼
┌─────────────────────┐         ┌──────────────────────────┐
│   Dexie.js /        │         │   SyncService            │
│   IndexedDB         │         │   (sync.ts)               │
│                     │         │                            │
│  All reads/writes   │         │  1. Check navigator.onLine │
│  happen here first  │         │  2. Query WHERE            │
│  (instant, offline) │         │     isSynced != true       │
│                     │         │  3. POST /api/sync/push     │
└─────────────────────┘         │  4. Flip isSynced=true      │
                                │     on success              │
                                └──────────┬──────────────────┘
                                           │ HTTP POST
                                           ▼
                                ┌──────────────────────────┐
                                │  Next.js API Route         │
                                │  /api/sync/push            │
                                │                            │
                                │  Uses Prisma to upsert     │
                                │  each record into          │
                                │  PostgreSQL                │
                                └──────────┬──────────────────┘
                                           │
                                           ▼
                                ┌──────────────────────────┐
                                │  PostgreSQL Database      │
                                │  (10 tables + audit log)  │
                                └──────────────────────────┘
```

### When sync triggers

1. **After every local write** — `scheduleSync(entity)` is called fire-and-forget. If online, SyncService starts pushing immediately. If offline, it records pending counts and bails.
2. **On `online` event** — `window.addEventListener('online', ...)` triggers `syncAllPending()` to push all queued records.
3. **Every 30 seconds** — periodic timer re-checks for pending records. If online, attempts a sync.
4. **On manual click** — the "Sync Now" button in Settings or the SyncStatusBadge in the header calls `triggerSyncNow()`.

### Failure handling

- If the API returns `success: false` (e.g. PostgreSQL unreachable), records remain `isSynced=false`.
- The badge shows "N pending Retry" with a clickable retry button.
- The next 30s tick will retry automatically.

---

## 🏗 Production Build & Deployment

### Option A — Standalone Next.js server (recommended for LAN/intranet)

```bash
# Build the standalone production bundle
bun run build

# Start the production server
bun run start

# Server runs on port 3000 by default.
# Override with: PORT=8080 bun run start
```

### Option B — Static export (no server, file:// or any CDN)

Update `next.config.ts`:

```ts
const nextConfig: NextConfig = {
  output: "export",            // ← change from "standalone"
  images: { unoptimized: true },
}
```

Then run `bun run build` — output will be in `./out/`.

**Note**: Static export disables the `/api/sync/*` routes (no Node.js server). The ERP continues to work offline; sync is simply disabled until deployed to a Node.js-capable host.

### Option C — Deploy to Vercel / Netlify / Cloudflare Pages

Standard Next.js 16 app — push to GitHub and import. Set `DATABASE_URL` as an environment variable in the host's dashboard. No other env vars required.

For detailed PostgreSQL setup + production deployment, see **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

---

## 💾 Data Persistence & Backup

### Where data is stored

| Location | Purpose |
|----------|---------|
| Browser IndexedDB (`FmcgErpDatabase`) | Primary local storage — 10 tables, instant reads |
| PostgreSQL (when configured) | Backend sync target — receives pushed copies |
| JSON backup file | Manual full export / restore |

### Backup & Restore

1. Navigate to **Settings & Backup** in the sidebar.
2. Click **"Download Full Backup (.json)"** to export all 10 tables as a single JSON file.
3. To restore on a new browser/device: open the app, go to Settings, click **"Choose backup file & Restore"**, and upload the JSON.
4. Restored records are auto-tagged `isSynced=false` so they re-push to PostgreSQL on the next sync cycle.

### Clearing the local DB

If you ever need a fresh start:

1. Open browser DevTools → Application → IndexedDB → delete the `FmcgErpDatabase` database.
2. Reload the app — sample data will re-seed automatically.

---

## 🧪 Linting & Type Checks

```bash
bun run lint           # ESLint
# — or —
npm run lint
```

Next.js compiles TypeScript during `bun run dev` / `bun run build` and will report type errors inline.

---

## 📋 Available Scripts

| Command | Purpose |
|---------|---------|
| `bun run dev` | Start dev server (port 3000, hot reload) |
| `bun run build` | Build standalone production bundle |
| `bun run start` | Start production server (after build) |
| `bun run lint` | Run ESLint |
| `bun run db:push` | Push Prisma schema to PostgreSQL (create tables) |
| `bun run db:generate` | Generate Prisma client |
| `bun run db:migrate` | Create + apply a Prisma migration |
| `bun run db:reset` | Drop all tables + re-create (DESTRUCTIVE) |

---

## 🌐 Browser Compatibility

Tested and working on:
- Chrome / Edge 110+
- Firefox 110+
- Safari 16+
- All modern browsers that support IndexedDB v2+

Not supported: Internet Explorer.

---

## 🔧 Configuration

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | **For sync only** | PostgreSQL connection string. ERP works without it. |

Example `.env`:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fmcg_erp
```

### Customizing the Distributor Profile

Navigate to **Settings & Backup** → update Store Name, GSTIN, Address, Phone, Email, State, and Invoice Prefix. Saved automatically to IndexedDB and synced to PostgreSQL.

### Customizing Theme Colors

Edit `src/app/globals.css` — the `:root` block defines all CSS custom properties (emerald/slate palette). Switch to any color by editing `--primary`, `--accent`, etc.

---

## 📖 Architecture

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for a deep dive into:
- Hexagonal core vs. plugin architecture
- Dexie.js schema evolution (v1 → v5)
- v4 per-piece pricing model
- v5 Hybrid Sync engine design
- Stock movement formula
- Customer dues derivation
- Sync API request/response format

---

## 🚢 Deployment

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for:
- PostgreSQL installation (Docker / native / managed)
- Prisma migration commands
- Production build steps
- Reverse proxy (Nginx) example
- Backup cron job setup

---

## 🤝 Backup Discipline Recommendations

- Take a JSON backup at the end of every business day.
- Store backups in dated filenames (auto-stamped, e.g. `fmcg-erp-backup-2026-10-19-15-30-00.json`).
- Keep at least 7 days of rolling backups.
- Before any major change (schema update, module edit), take a snapshot first.
- Monitor the SyncStatusBadge — if it ever stays red for >1 hour, investigate.

---

## ❓ Troubleshooting

**"My data disappeared after clearing browser data!"**
IndexedDB is cleared when the user clears "site data" in browser settings. Always keep a JSON backup. If PostgreSQL is configured, your data is also stored there.

**"The app shows a blank white screen."**
Open browser DevTools console. Most common causes:
1. IndexedDB schema upgrade conflict — clear the `FmcgErpDatabase` in DevTools → Application → IndexedDB, then reload.
2. Browser is in private/incognito mode — IndexedDB may be limited; use a normal window.

**"SyncStatusBadge shows 'X pending Retry' forever."**
The PostgreSQL backend is unreachable. Check:
1. Is PostgreSQL running? `pg_isready -h localhost -p 5432`
2. Is `DATABASE_URL` correctly set in `.env`?
3. Did you run `bun run db:push` to create the tables?
4. Check the browser console for the actual error from `/api/sync/push`.

**"Lint fails with 'FileSpreadsheet' not found."**
This was fixed in the current version — Lucide's `FileSpreadsheet` icon was renamed. We use `FileText` throughout.

---

## 📝 License

This project is delivered as-is for the user's internal business use. No warranty expressed or implied.

---

## 🙏 Credits

Built with:
- [Next.js](https://nextjs.org)
- [React](https://react.dev)
- [Tailwind CSS](https://tailwindcss.com)
- [shadcn/ui](https://ui.shadcn.com)
- [Dexie.js](https://dexie.org)
- [Prisma](https://www.prisma.io)
- [PostgreSQL](https://www.postgresql.org)
- [Recharts](https://recharts.org)
- [Lucide](https://lucide.dev)

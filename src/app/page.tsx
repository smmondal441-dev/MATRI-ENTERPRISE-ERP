'use client'

import { useEffect, useState } from 'react'
import { BackupService } from '@/lib/services/repository'
import { pullFromServer, isDataStale } from '@/lib/services/sync'
import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard,
  Package,
  Users,
  Truck,
  Receipt,
  BookOpen,
  Wallet,
  Warehouse,
  FileText,
  Settings,
  Menu,
  X,
  AlertTriangle,
  Undo2,
  Recycle,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Dashboard } from '@/components/erp/modules/Dashboard'
import { ProductMaster } from '@/components/erp/modules/ProductMaster'
import { CustomerMaster } from '@/components/erp/modules/CustomerMaster'
import { PurchaseEntry } from '@/components/erp/modules/PurchaseEntry'
import { SalesBill } from '@/components/erp/modules/SalesBill'
import { SalesLedger } from '@/components/erp/modules/SalesLedger'
import { Collections } from '@/components/erp/modules/Collections'
import { Inventory } from '@/components/erp/modules/Inventory'
import { GstReports } from '@/components/erp/modules/GstReports'
import { Settings as SettingsModule } from '@/components/erp/modules/Settings'
import { Damages } from '@/components/erp/modules/Damages'
import { StockReturns } from '@/components/erp/modules/StockReturns'
import { SyncStatusBadge } from '@/components/erp/SyncStatusBadge'
import { RecycleBin } from '@/components/erp/modules/RecycleBin'

export type ModuleKey =
  | 'dashboard'
  | 'products'
  | 'customers'
  | 'purchases'
  | 'billing'
  | 'sales-ledger'
  | 'collections'
  | 'inventory'
  | 'damages'
  | 'returns'
  | 'gst-reports'
  | 'recycle-bin'
  | 'settings'

interface NavItem {
  key: ModuleKey
  label: string
  icon: LucideIcon
  group?: string
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview' },
  { key: 'products', label: 'Product Master', icon: Package, group: 'Masters' },
  { key: 'customers', label: 'Customer Master', icon: Users, group: 'Masters' },
  { key: 'purchases', label: 'Purchase Entry', icon: Truck, group: 'Transactions' },
  { key: 'billing', label: 'Sales Bill (POS)', icon: Receipt, group: 'Transactions' },
  { key: 'sales-ledger', label: 'Sales Ledger', icon: BookOpen, group: 'Transactions' },
  { key: 'collections', label: 'Collection & Dues', icon: Wallet, group: 'Transactions' },
  { key: 'inventory', label: 'Inventory Ledger', icon: Warehouse, group: 'Stock' },
  { key: 'damages', label: 'Damage & Adjustment', icon: AlertTriangle, group: 'Stock' },
  { key: 'returns', label: 'Stock Returns', icon: Undo2, group: 'Stock' },
  { key: 'gst-reports', label: 'GST & Tax Reports', icon: FileText, group: 'Reports' },
  { key: 'recycle-bin', label: 'Recycle Bin', icon: Recycle, group: 'System' },
  { key: 'settings', label: 'Settings & Backup', icon: Settings, group: 'System' },
]

export default function Home() {
  const [active, setActive] = useState<ModuleKey>('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [booted, setBooted] = useState(false)

  // ---- Desktop sidebar collapse (Upgrade 1) ----
  // Persisted in localStorage so the user's preference survives page refresh.
  // Default: expanded (false). When collapsed, the sidebar slides out on
  // desktop too (not just mobile), and the main content area expands to
  // 100% viewport width via the `main-content-fullwidth` class.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // Hydrate the collapsed state from localStorage on first mount.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('matri.sidebar.collapsed')
      if (saved === 'true') setSidebarCollapsed(true)
    } catch {
      // localStorage may be disabled (private mode, etc.) — silently ignore.
    }
  }, [])

  // Persist on change.
  useEffect(() => {
    try {
      localStorage.setItem(
        'matri.sidebar.collapsed',
        String(sidebarCollapsed)
      )
    } catch {
      // Silently ignore — UI still works without persistence.
    }
  }, [sidebarCollapsed])

  useEffect(() => {
    ;(async () => {
      // ---- Multi-device boot sequence (2-Way Sync) ----
      // 1. Check if local IndexedDB has been initialized before (meta `seeded` flag).
      // 2. If NOT seeded (truly first launch on this device):
      //    a. Try pulling real data from Turso first.
      //    b. If pull succeeds (server has data), use it — skip seeding.
      //    c. If pull fails (server unreachable or empty), fall back to local seed.
      // 3. If already seeded (returning visitor):
      //    a. Check if the last pull is stale (> 5 minutes ago, or never).
      //    b. If stale, trigger a background pull to get the latest cloud data
      //       (e.g. new sales pushed by Laptop 1 while Laptop 2 was closed).
      //       The pull has conflict protection — it won't overwrite local
      //       unsynced edits.

      try {
        // Check the meta flag — has this device been initialized before?
        const { db } = await import('@/lib/db/dexie')
        const alreadySeeded = await db.meta.get('seeded')

        if (!alreadySeeded?.value) {
          // First launch on this device — try pulling from server first.
          console.log('[boot] First launch — attempting pull from server...')
          const pullResult = await pullFromServer()

          if (pullResult.ok && pullResult.totalRecords > 0) {
            console.log('[boot] Pulled', pullResult.totalRecords, 'records from server. Skipping seed.')
            // Store lastPullAt so the staleness check works on next boot.
            await db.meta.put({ key: 'lastPullAt', value: new Date().toISOString() })
          } else {
            console.log('[boot] Pull failed or server empty. Falling back to local seed.')
            await BackupService.seedIfEmpty()
          }
        } else {
          // Already initialized — IndexedDB is the source of truth for this device.
          // But check if the data is STALE: if the last pull was > 5 minutes ago
          // (or never), trigger a background pull to get the latest cloud changes
          // from other devices. This is the core of 2-way multi-device sync.
          const stale = await isDataStale(5 * 60 * 1000) // 5 minutes
          if (stale) {
            console.log('[boot] Data is stale (last pull > 5 min ago). Triggering background pull...')
            // Fire-and-forget — don't block the boot. The user sees their local
            // data immediately, and the pull updates IndexedDB in the background.
            // The live-query hooks (useProducts, useSales, etc.) will re-render
            // automatically when IndexedDB updates.
            pullFromServer()
              .then((result) => {
                if (result.ok) {
                  console.log('[boot] Background pull complete:', result.totalRecords, 'records')
                  // Update lastPullAt in the meta table.
                  db.meta.put({ key: 'lastPullAt', value: new Date().toISOString() })
                } else {
                  console.warn('[boot] Background pull failed:', result.error)
                }
              })
              .catch((e) => {
                console.warn('[boot] Background pull error:', e?.message ?? e)
              })
          } else {
            console.log('[boot] Data is fresh (last pull < 5 min ago). Skipping background pull.')
          }
        }
      } catch (e) {
        // If anything goes wrong (DB not open, network error, etc.),
        // fall back to seeding so the app at least has some data to show.
        console.warn('[boot] Initialization error, falling back to seed:', e)
        try {
          await BackupService.seedIfEmpty()
        } catch (seedErr) {
          console.warn('[boot] Seed also failed:', seedErr)
        }
      }

      setBooted(true)
    })()
  }, [])

  // Group nav items
  const groups = NAV_ITEMS.reduce<Record<string, NavItem[]>>((acc, item) => {
    const g = item.group ?? 'Main'
    if (!acc[g]) acc[g] = []
    acc[g].push(item)
    return acc
  }, {})

  const renderModule = () => {
    switch (active) {
      case 'dashboard':
        return <Dashboard onNavigate={setActive} />
      case 'products':
        return <ProductMaster />
      case 'customers':
        return <CustomerMaster />
      case 'purchases':
        return <PurchaseEntry />
      case 'billing':
        return <SalesBill />
      case 'sales-ledger':
        return <SalesLedger />
      case 'collections':
        return <Collections />
      case 'inventory':
        return <Inventory />
      case 'damages':
        return <Damages />
      case 'returns':
        return <StockReturns />
      case 'gst-reports':
        return <GstReports />
      case 'recycle-bin':
        return <RecycleBin />
      case 'settings':
        return <SettingsModule />
      default:
        return <Dashboard onNavigate={setActive} />
    }
  }

  if (!booted) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm">Loading offline ERP database...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* ---------- Sidebar ---------- */}
      {/*
        Upgrade 1: Collapsible / Auto-Hide Sidebar.
        - Mobile (below lg): drawer pattern with overlay (unchanged).
        - Desktop (lg+): when `sidebarCollapsed` is true, the sidebar slides
          out via `-translate-x-full` and `lg:w-0` so it no longer occupies
          layout space, letting the main content expand to 100% width.
        - `transition-all` gives a smooth slide animation on both platforms.
      */}
      <aside
        className={cn(
          'no-print fixed inset-y-0 left-0 z-50 w-64 transform border-r border-border bg-sidebar transition-all lg:static lg:transition-all',
          // Mobile drawer: open / closed
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          // Desktop: hidden when collapsed; visible when expanded
          sidebarCollapsed ? 'lg:-translate-x-full lg:w-0 lg:border-0 lg:overflow-hidden' : 'lg:translate-x-0'
        )}
      >
        <div className="flex h-16 items-center gap-2 border-b border-sidebar-border px-5">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Warehouse className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-sidebar-foreground">
              MATRI ENTERPRISE
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="scrollbar-thin h-[calc(100vh-4rem)] overflow-y-auto px-3 py-4">
          {Object.entries(groups).map(([group, items]) => (
            <div key={group} className="mb-5">
              <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group}
              </div>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon
                  const isActive = active === item.key
                  return (
                    <li key={item.key}>
                      <button
                        onClick={() => {
                          setActive(item.key)
                          setSidebarOpen(false)
                        }}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                          isActive
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      {/* overlay when mobile sidebar open */}
      {sidebarOpen && (
        <div
          className="no-print fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ---------- Main content ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur lg:px-6">
          {/* Mobile: open drawer (existing) */}
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          {/* Desktop: collapse / expand sidebar toggle (Upgrade 1) */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden lg:inline-flex"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="h-5 w-5" />
            ) : (
              <PanelLeftClose className="h-5 w-5" />
            )}
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold capitalize text-foreground">
              {NAV_ITEMS.find((n) => n.key === active)?.label}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {NAV_ITEMS.find((n) => n.key === active)?.group}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <SyncStatusBadge />
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-6">
          {/*
            Upgrade 1: when sidebar is collapsed, drop the max-width constraint
            so modules (Sales, Ledger, Inventory, Reports) can use the full
            viewport width. The `main-content-fullwidth` class is defined in
            globals.css to override `max-w-7xl` with `max-width: 100%`.
          */}
          <div
            className={cn(
              'mx-auto',
              sidebarCollapsed ? 'main-content-fullwidth' : 'max-w-7xl'
            )}
          >
            {renderModule()}
          </div>
        </main>
      </div>
    </div>
  )
}

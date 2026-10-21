'use client'

import { useEffect, useState } from 'react'
import { BackupService } from '@/lib/services/repository'
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
  { key: 'settings', label: 'Settings & Backup', icon: Settings, group: 'System' },
]

export default function Home() {
  const [active, setActive] = useState<ModuleKey>('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [booted, setBooted] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        await BackupService.seedIfEmpty()
      } catch (e) {
        // ignore seed errors (e.g. already seeded)
        console.warn('Seed skipped:', e)
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
      <aside
        className={cn(
          'no-print fixed inset-y-0 left-0 z-50 w-64 transform border-r border-border bg-sidebar transition-transform lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
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
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
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
          <div className="mx-auto max-w-7xl">{renderModule()}</div>
        </main>
      </div>
    </div>
  )
}

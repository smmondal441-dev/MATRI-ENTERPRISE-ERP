'use client'

import { useState, useMemo } from 'react'
import { useInventory } from '@/lib/hooks/use-erp'
import {
  formatINR,
  formatNumber,
  downloadCSV,
  todayISO,
  formatDate,
} from '@/lib/utils/format'
import { PageHeader, EmptyState } from '@/components/erp/EmptyState'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import {
  Warehouse,
  Search,
  Download,
  AlertTriangle,
  Clock,
  Skull,
} from 'lucide-react'

// ----------------------------------------------------------------------------
// Upgrade 4 — Inventory with FEFO + Damaged Stock bucket
// ----------------------------------------------------------------------------
// Inventory rows now carry `latest_mfg_date`, `earliest_expiry_date`,
// `days_until_expiry`, `godown_damaged_pcs`, and `store_damaged_pcs` directly
// (computed once per refresh in InventoryService.all()). The Inventory UI just
// renders those fields — no more client-side `purchases` join needed.
//
// Tabs:
//   - All              : every SKU (default)
//   - Near Expiry ≤30d : rows with 0 ≤ days_until_expiry ≤ 30
//   - Expired          : rows with days_until_expiry < 0
//   - Damaged Stock    : rows where store_damaged_pcs > 0 (separate bucket —
//                        store-returned damaged goods that did NOT touch
//                        sellable godown stock)
// ----------------------------------------------------------------------------

type InvTab = 'all' | 'near-expiry' | 'expired' | 'damaged-stock'

export function Inventory() {
  const inventory = useInventory()
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<InvTab>('all')

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return inventory ?? []
    return (inventory ?? []).filter(
      (row) =>
        row.product.name.toLowerCase().includes(q) ||
        row.product.sku.toLowerCase().includes(q) ||
        row.product.company_name.toLowerCase().includes(q) ||
        row.product.hsn_code.toLowerCase().includes(q)
    )
  }, [inventory, search])

  const filtered = useMemo(() => {
    switch (tab) {
      case 'near-expiry':
        return searched.filter(
          (r) =>
            r.days_until_expiry != null &&
            r.days_until_expiry >= 0 &&
            r.days_until_expiry <= 30
        )
      case 'expired':
        return searched.filter(
          (r) => r.days_until_expiry != null && r.days_until_expiry < 0
        )
      case 'damaged-stock':
        // Rows with any Store-damage bucket stock tracked separately
        return searched.filter((r) => r.store_damaged_pcs > 0)
      case 'all':
      default:
        return searched
    }
  }, [searched, tab])

  const totals = useMemo(() => {
    return (inventory ?? []).reduce(
      (acc, row) => {
        acc.closingPcs += row.closing_pcs
        acc.closingBags += row.closing_bags
        acc.value += row.bag_value
        acc.lowStock += row.closing_pcs <= 10 ? 1 : 0
        acc.nearExpiry +=
          row.days_until_expiry != null &&
          row.days_until_expiry >= 0 &&
          row.days_until_expiry <= 30
            ? 1
            : 0
        acc.expired +=
          row.days_until_expiry != null && row.days_until_expiry < 0 ? 1 : 0
        acc.storeDamagedPcs += row.store_damaged_pcs
        return acc
      },
      {
        closingPcs: 0,
        closingBags: 0,
        value: 0,
        lowStock: 0,
        nearExpiry: 0,
        expired: 0,
        storeDamagedPcs: 0,
      }
    )
  }, [inventory])

  const exportCsv = () => {
    const rows: (string | number)[][] = [
      [
        'SKU',
        'Product Name',
        'Company',
        'HSN',
        'Pack Size',
        'Outer Unit',
        'Conversion',
        'Latest MFG',
        'Earliest Expiry',
        'Days Until Expiry',
        'Opening Stock (Pcs)',
        'Purchased (Pcs)',
        'Sold (Pcs)',
        'Damaged Godown (Pcs)',
        'Damaged Store (Pcs)',
        'Purchase Returned (Pcs)',
        'Sales Returned (Pcs)',
        'Closing (Qty)',
        'Closing (Outer)',
        'Stock Value (₹)',
      ],
      ...filtered.map((r) => [
        r.product.sku,
        r.product.name,
        r.product.company_name,
        r.product.hsn_code,
        r.product.pack_size || '',
        r.product.outer_unit,
        r.product.conversion_factor,
        r.latest_mfg_date || '',
        r.earliest_expiry_date || '',
        r.days_until_expiry != null ? r.days_until_expiry : '',
        r.opening_stock_pcs,
        r.purchased_pcs,
        r.sold_pcs,
        r.godown_damaged_pcs,
        r.store_damaged_pcs,
        r.purchase_returned_pcs,
        r.sales_returned_pcs,
        r.closing_pcs,
        r.closing_bags,
        r.bag_value.toFixed(2),
      ]),
    ]
    downloadCSV(`inventory-${todayISO()}`, rows)
    toast({ title: 'CSV downloaded', description: `${filtered.length} rows` })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inventory · Real-time Stock Ledger"
        description="Live stock position reconstructed from opening + purchases − sales − damages, with FEFO shelf-life tracking."
        actions={
          <Button variant="outline" onClick={exportCsv}>
            <Download className="mr-1 h-4 w-4" /> Export CSV
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
        <StatCard label="Total SKUs" value={String(inventory?.length ?? 0)} />
        <StatCard label="Closing Pcs" value={formatNumber(totals.closingPcs, 0)} variant="info" />
        <StatCard label="Closing Bags" value={formatNumber(totals.closingBags, 0)} variant="success" />
        <StatCard label="Stock Value" value={formatINR(totals.value)} />
        {/* Upgrade 4 — Near-Expiry + Expired stat cards */}
        <StatCard
          label="Near Expiry ≤30d"
          value={String(totals.nearExpiry)}
          variant={totals.nearExpiry > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label="Expired SKUs"
          value={String(totals.expired)}
          variant={totals.expired > 0 ? 'danger' : 'default'}
        />
      </div>

      {/* Upgrade 4 — separate Damaged Stock (Store) bucket summary */}
      {totals.storeDamagedPcs > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
          <Skull className="h-4 w-4" />
          <span>
            <strong>Damaged Stock (Store):</strong>{' '}
            {formatNumber(totals.storeDamagedPcs, 0)} Pcs across{' '}
            {(inventory ?? []).filter((r) => r.store_damaged_pcs > 0).length}{' '}
            SKU(s). These are store-returned damaged goods tracked separately —
            sellable godown stock is NOT affected.
          </span>
        </div>
      )}

      {totals.lowStock > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4" />
          {totals.lowStock} SKU{totals.lowStock > 1 ? 's are' : ' is'} running low (≤ 10 Pcs). Consider reordering.
        </div>
      )}

      <Card>
        <CardContent className="p-4">
          {/* ---- Filter tabs (Upgrade 4) ---- */}
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as InvTab)}
            className="mb-3"
          >
            <TabsList>
              <TabsTrigger value="all">All ({inventory?.length ?? 0})</TabsTrigger>
              <TabsTrigger value="near-expiry">
                Near Expiry ≤30d ({totals.nearExpiry})
              </TabsTrigger>
              <TabsTrigger value="expired">
                Expired ({totals.expired})
              </TabsTrigger>
              <TabsTrigger value="damaged-stock">
                Damaged Stock ({(inventory ?? []).filter((r) => r.store_damaged_pcs > 0).length})
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="relative mb-3 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by SKU, name, company..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title="No inventory matches"
              description={
                tab === 'all'
                  ? 'Add products and record purchases to see stock here.'
                  : `No SKUs match the "${tab}" filter.`
              }
              icon={<Warehouse className="h-6 w-6" />}
            />
          ) : (
            <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Pack Size</TableHead>
                    <TableHead>Conversion</TableHead>
                    <TableHead className="text-right">Opening (Pcs)</TableHead>
                    <TableHead className="text-right">Purchased (Pcs)</TableHead>
                    <TableHead className="text-right">Sold (Pcs)</TableHead>
                    {/* Upgrade 4 — split damages into Godown (deducted) and Store (separate bucket) */}
                    <TableHead className="text-right">Dmg Godown (Pcs)</TableHead>
                    <TableHead className="text-right">Dmg Store (Pcs)</TableHead>
                    <TableHead className="text-right">Pur. Ret. (Pcs)</TableHead>
                    <TableHead className="text-right">Sales Ret. (Pcs)</TableHead>
                    <TableHead className="text-right">Closing (Qty)</TableHead>
                    <TableHead className="text-right">Closing (Outer)</TableHead>
                    <TableHead className="text-right">Stock Value</TableHead>
                    {/* Upgrade 4 — MFG + Expiry columns */}
                    <TableHead>MFG Date</TableHead>
                    <TableHead>Expiry (FEFO)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => {
                    const low = r.closing_pcs <= 10
                    return (
                      <TableRow key={r.product.id} className={low ? 'bg-amber-50/50' : ''}>
                        <TableCell className="font-mono text-xs">{r.product.sku}</TableCell>
                        <TableCell>
                          <div className="text-sm font-medium">{r.product.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.product.company_name} · HSN {r.product.hsn_code}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{r.product.pack_size || '—'}</TableCell>
                        <TableCell className="text-xs">
                          1 {r.product.outer_unit} = {formatNumber(r.product.conversion_factor, 0)} {r.product.base_unit}
                        </TableCell>
                        <TableCell className="text-right text-xs">{formatNumber(r.opening_stock_pcs, 0)}</TableCell>
                        <TableCell className="text-right text-xs text-emerald-600">
                          +{formatNumber(r.purchased_pcs, 0)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-red-600">
                          -{formatNumber(r.sold_pcs, 0)}
                        </TableCell>
                        {/* Godown damages (deducted from sellable stock) */}
                        <TableCell className="text-right text-xs text-amber-600">
                          {r.godown_damaged_pcs > 0
                            ? `-${formatNumber(r.godown_damaged_pcs, 0)}`
                            : '—'}
                        </TableCell>
                        {/* Store damages (separate bucket — sellable stock unchanged) */}
                        <TableCell className="text-right text-xs text-blue-700">
                          {r.store_damaged_pcs > 0
                            ? `+${formatNumber(r.store_damaged_pcs, 0)}`
                            : '—'}
                        </TableCell>
                        <TableCell className="text-right text-xs text-rose-600">
                          -{formatNumber(r.purchase_returned_pcs, 0)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-emerald-600">
                          +{formatNumber(r.sales_returned_pcs, 0)}
                        </TableCell>
                        <TableCell className="text-right text-xs font-semibold">
                          {formatNumber(r.closing_pcs, 0)}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {formatNumber(r.closing_bags, 0)} {r.product.outer_unit}
                        </TableCell>
                        <TableCell className="text-right text-xs">{formatINR(r.bag_value)}</TableCell>
                        {/* Upgrade 4 — MFG Date column */}
                        <TableCell className="text-xs">
                          {r.latest_mfg_date ? (
                            <span className="text-muted-foreground">
                              {formatDate(r.latest_mfg_date)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {/* Upgrade 4 — Expiry / FEFO column with badge logic */}
                        <TableCell className="text-xs">
                          <ExpiryBadge
                            expiryDate={r.earliest_expiry_date}
                            daysUntil={r.days_until_expiry}
                          />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Expiry badge — color-coded by remaining days
//   < 0         → Expired (red, with AlertTriangle)
//   0 – 7       → Critical (red, with Clock)
//   8 – 30      → Near Expiry (amber, with Clock)
//   31 – 90     → Watch (sky)
//   > 90 / null → plain text or em-dash
// ----------------------------------------------------------------------------

function ExpiryBadge({
  expiryDate,
  daysUntil,
}: {
  expiryDate?: string
  daysUntil?: number
}) {
  if (!expiryDate || daysUntil == null) {
    return <span className="text-muted-foreground">—</span>
  }
  if (daysUntil < 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
        <AlertTriangle className="h-3 w-3" />
        Expired {formatDate(expiryDate)}
      </span>
    )
  }
  if (daysUntil <= 7) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
        <Clock className="h-3 w-3" />
        {daysUntil}d — {formatDate(expiryDate)}
      </span>
    )
  }
  if (daysUntil <= 30) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
        <Clock className="h-3 w-3" />
        {daysUntil}d — {formatDate(expiryDate)}
      </span>
    )
  }
  if (daysUntil <= 90) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
        {formatDate(expiryDate)}
      </span>
    )
  }
  return (
    <span className="text-muted-foreground">{formatDate(expiryDate)}</span>
  )
}

function StatCard({
  label,
  value,
  variant = 'default',
}: {
  label: string
  value: string
  variant?: 'default' | 'success' | 'info' | 'warning' | 'danger'
}) {
  const styles = {
    default: 'border-border bg-card',
    success: 'border-emerald-200 bg-emerald-50',
    info: 'border-sky-200 bg-sky-50',
    warning: 'border-amber-200 bg-amber-50',
    danger: 'border-red-200 bg-red-50',
  }[variant]
  return (
    <div className={`rounded-md border p-3 ${styles}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-base font-semibold lg:text-lg">{value}</div>
    </div>
  )
}

'use client'

import { useState, useMemo, useEffect } from 'react'
import { useInventory } from '@/lib/hooks/use-erp'
import {
  ProductService,
  getPurchaseRatePerOuterUnit,
  getSellingRatePerOuterUnit,
  type InventoryRow,
} from '@/lib/services/repository'
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
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import {
  Warehouse,
  Search,
  Download,
  AlertTriangle,
  Clock,
  Skull,
  Pencil,
  X,
} from 'lucide-react'
import type { Product } from '@/lib/db/dexie'

// ----------------------------------------------------------------------------
// Inventory · Real-time Stock Ledger
// ----------------------------------------------------------------------------
// Upgrades in this revision:
//   - Filter-Wise Toolbar: real-time search (Product Name / SKU / HSN) plus
//     dropdowns for Company / Brand, Category, Stock Status, and Type
//     (Packaged vs Loose). A one-click "Clear Filters" button resets every
//     dropdown + the search box. Top summary cards now reflect the FILTERED
//     list (whatever is currently visible in the table).
//   - Safe Quick Edit Modal: each row has an Edit button. The modal lets the
//     user set the actual physical stock (Outer + Pcs for packaged, or a
//     direct count for loose items) and refresh the per-Outer purchase &
//     selling rates. The stock delta is applied to `opening_stock_pcs` (the
//     live running balance) so historical purchases / sales / damages stay
//     100% intact while the closing stock immediately matches the physical
//     count. ProductService.update persists the patch, marks the row
//     `isSynced = false` (queued for Turso push), and triggers background
//     sync. The Dexie live query auto-refreshes the table.
// ----------------------------------------------------------------------------

type InvTab = 'all' | 'near-expiry' | 'expired' | 'damaged-stock'
type StockStatusFilter = 'all' | 'in' | 'low' | 'out'
type TypeFilter = 'all' | 'packaged' | 'loose'

const LOW_STOCK_THRESHOLD = 10

export function Inventory() {
  const inventory = useInventory()
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<InvTab>('all')
  // ---- New filter dropdowns ----
  const [companyFilter, setCompanyFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [stockStatusFilter, setStockStatusFilter] =
    useState<StockStatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  // ---- Quick Edit modal target ----
  const [editRow, setEditRow] = useState<InventoryRow | null>(null)

  // ---- Auto-populated dropdown options (derived from existing products) ----
  const companies = useMemo(() => {
    const set = new Set<string>()
    ;(inventory ?? []).forEach((r) => {
      if (r.product.company_name) set.add(r.product.company_name)
    })
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [inventory])

  const categories = useMemo(() => {
    const set = new Set<string>()
    ;(inventory ?? []).forEach((r) => {
      if (r.product.category) set.add(r.product.category)
    })
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [inventory])

  // ---- Real-time search: Product Name, SKU, or HSN Code (per spec) ----
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return inventory ?? []
    return (inventory ?? []).filter(
      (row) =>
        row.product.name.toLowerCase().includes(q) ||
        row.product.sku.toLowerCase().includes(q) ||
        row.product.hsn_code.toLowerCase().includes(q)
    )
  }, [inventory, search])

  // ---- Apply the new dropdown filters on top of the search result ----
  const dropdownFiltered = useMemo(() => {
    return searched.filter((row) => {
      if (companyFilter !== 'all' && row.product.company_name !== companyFilter)
        return false
      if (
        categoryFilter !== 'all' &&
        (row.product.category ?? '') !== categoryFilter
      )
        return false
      // Type filter: legacy rows (is_loose === undefined) read as Packaged.
      if (typeFilter === 'packaged' && Boolean(row.product.is_loose)) return false
      if (typeFilter === 'loose' && !Boolean(row.product.is_loose)) return false
      // Stock Status filter:
      //   in  → closing_pcs > 0   (broadest; includes low)
      //   low → 0 < closing_pcs ≤ 10
      //   out → closing_pcs ≤ 0
      if (stockStatusFilter === 'in' && !(row.closing_pcs > 0)) return false
      if (
        stockStatusFilter === 'low' &&
        !(row.closing_pcs > 0 && row.closing_pcs <= LOW_STOCK_THRESHOLD)
      )
        return false
      if (stockStatusFilter === 'out' && !(row.closing_pcs <= 0)) return false
      return true
    })
  }, [searched, companyFilter, categoryFilter, typeFilter, stockStatusFilter])

  // ---- Apply the existing FEFO/shelf-life tab on top of the dropdowns ----
  const filtered = useMemo(() => {
    switch (tab) {
      case 'near-expiry':
        return dropdownFiltered.filter(
          (r) =>
            r.days_until_expiry != null &&
            r.days_until_expiry >= 0 &&
            r.days_until_expiry <= 30
        )
      case 'expired':
        return dropdownFiltered.filter(
          (r) => r.days_until_expiry != null && r.days_until_expiry < 0
        )
      case 'damaged-stock':
        return dropdownFiltered.filter((r) => r.store_damaged_pcs > 0)
      case 'all':
      default:
        return dropdownFiltered
    }
  }, [dropdownFiltered, tab])

  // ---- Tab counts reflect the dropdown-filtered set (so each tab badge
  // shows what would be visible if the user switched to that tab, given the
  // current search + dropdown filters).
  const tabCounts = useMemo(
    () => ({
      all: dropdownFiltered.length,
      nearExpiry: dropdownFiltered.filter(
        (r) =>
          r.days_until_expiry != null &&
          r.days_until_expiry >= 0 &&
          r.days_until_expiry <= 30
      ).length,
      expired: dropdownFiltered.filter(
        (r) => r.days_until_expiry != null && r.days_until_expiry < 0
      ).length,
      damagedStock: dropdownFiltered.filter((r) => r.store_damaged_pcs > 0)
        .length,
    }),
    [dropdownFiltered]
  )

  // ---- Summary totals — now reflect the FILTERED list (per spec) ----
  // i.e., whatever is currently visible in the table after every filter
  // dimension (search + dropdowns + tab) has been applied.
  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, row) => {
        acc.closingPcs += row.closing_pcs
        acc.closingBags += row.closing_bags
        acc.value += row.bag_value
        acc.lowStock += row.closing_pcs <= LOW_STOCK_THRESHOLD ? 1 : 0
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
  }, [filtered])

  // ---- Clear Filters: reset search + all dropdowns (tab stays as-is) ----
  const hasActiveFilters =
    search.trim() !== '' ||
    companyFilter !== 'all' ||
    categoryFilter !== 'all' ||
    stockStatusFilter !== 'all' ||
    typeFilter !== 'all'

  const clearFilters = () => {
    setSearch('')
    setCompanyFilter('all')
    setCategoryFilter('all')
    setStockStatusFilter('all')
    setTypeFilter('all')
  }

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
        <StatCard label="Total SKUs" value={String(filtered.length)} />
        <StatCard
          label="Closing Pcs"
          value={formatNumber(totals.closingPcs, 0)}
          variant="info"
        />
        <StatCard
          label="Closing Bags"
          value={formatNumber(totals.closingBags, 0)}
          variant="success"
        />
        <StatCard label="Stock Value" value={formatINR(totals.value)} />
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

      {totals.storeDamagedPcs > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
          <Skull className="h-4 w-4" />
          <span>
            <strong>Damaged Stock (Store):</strong>{' '}
            {formatNumber(totals.storeDamagedPcs, 0)} Pcs across{' '}
            {filtered.filter((r) => r.store_damaged_pcs > 0).length} SKU(s).
            These are store-returned damaged goods tracked separately — sellable
            godown stock is NOT affected.
          </span>
        </div>
      )}

      {totals.lowStock > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4" />
          {totals.lowStock} SKU{totals.lowStock > 1 ? 's are' : ' is'} running
          low (≤ {LOW_STOCK_THRESHOLD} Pcs). Consider reordering.
        </div>
      )}

      <Card>
        <CardContent className="p-4">
          {/* ---- Filter-Wise Toolbar (search + dropdowns + Clear) ---- */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] max-w-md flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by Product Name, SKU, or HSN Code"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>

            <Select value={companyFilter} onValueChange={setCompanyFilter}>
              <SelectTrigger className="h-9 w-[160px]">
                <SelectValue placeholder="Company / Brand" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Companies</SelectItem>
                {companies.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="h-9 w-[150px]">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={stockStatusFilter}
              onValueChange={(v) => setStockStatusFilter(v as StockStatusFilter)}
            >
              <SelectTrigger className="h-9 w-[150px]">
                <SelectValue placeholder="Stock Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Stock</SelectItem>
                <SelectItem value="in">In Stock (&gt; 0)</SelectItem>
                <SelectItem value="low">Low Stock (≤ 10)</SelectItem>
                <SelectItem value="out">Out of Stock (≤ 0)</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={typeFilter}
              onValueChange={(v) => setTypeFilter(v as TypeFilter)}
            >
              <SelectTrigger className="h-9 w-[120px]">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="packaged">Packaged</SelectItem>
                <SelectItem value="loose">Loose</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={clearFilters}
              disabled={!hasActiveFilters}
            >
              <X className="mr-1 h-3.5 w-3.5" /> Clear Filters
            </Button>
          </div>

          {/* ---- Existing filter tabs (counts now reflect dropdown-filtered set) ---- */}
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as InvTab)}
            className="mb-3"
          >
            <TabsList>
              <TabsTrigger value="all">All ({tabCounts.all})</TabsTrigger>
              <TabsTrigger value="near-expiry">
                Near Expiry ≤30d ({tabCounts.nearExpiry})
              </TabsTrigger>
              <TabsTrigger value="expired">
                Expired ({tabCounts.expired})
              </TabsTrigger>
              <TabsTrigger value="damaged-stock">
                Damaged Stock ({tabCounts.damagedStock})
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {filtered.length === 0 ? (
            <EmptyState
              title="No inventory matches"
              description={
                hasActiveFilters
                  ? 'No SKUs match the current search + filters. Try clearing filters.'
                  : tab === 'all'
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
                    <TableHead className="text-right">Dmg Godown (Pcs)</TableHead>
                    <TableHead className="text-right">Dmg Store (Pcs)</TableHead>
                    <TableHead className="text-right">Pur. Ret. (Pcs)</TableHead>
                    <TableHead className="text-right">Sales Ret. (Pcs)</TableHead>
                    <TableHead className="text-right">Closing (Qty)</TableHead>
                    <TableHead className="text-right">Closing (Outer)</TableHead>
                    <TableHead className="text-right">Stock Value</TableHead>
                    <TableHead>MFG Date</TableHead>
                    <TableHead>Expiry (FEFO)</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => {
                    const low = r.closing_pcs <= LOW_STOCK_THRESHOLD
                    return (
                      <TableRow
                        key={r.product.id}
                        className={low ? 'bg-amber-50/50' : ''}
                      >
                        <TableCell className="font-mono text-xs">
                          {r.product.sku}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm font-medium">
                            {r.product.name}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {r.product.company_name} · HSN {r.product.hsn_code}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.product.pack_size || '—'}
                        </TableCell>
                        <TableCell className="text-xs">
                          1 {r.product.outer_unit} ={' '}
                          {formatNumber(r.product.conversion_factor, 0)}{' '}
                          {r.product.base_unit}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {formatNumber(r.opening_stock_pcs, 0)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-emerald-600">
                          +{formatNumber(r.purchased_pcs, 0)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-red-600">
                          -{formatNumber(r.sold_pcs, 0)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-amber-600">
                          {r.godown_damaged_pcs > 0
                            ? `-${formatNumber(r.godown_damaged_pcs, 0)}`
                            : '—'}
                        </TableCell>
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
                        <TableCell className="text-right text-xs">
                          {formatINR(r.bag_value)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.latest_mfg_date ? (
                            <span className="text-muted-foreground">
                              {formatDate(r.latest_mfg_date)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          <ExpiryBadge
                            expiryDate={r.earliest_expiry_date}
                            daysUntil={r.days_until_expiry}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => setEditRow(r)}
                          >
                            <Pencil className="mr-1 h-3 w-3" /> Edit
                          </Button>
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

      {/* ---- Safe Quick Edit Modal ---- */}
      <QuickEditModal
        row={editRow}
        open={editRow !== null}
        onOpenChange={(v) => {
          if (!v) setEditRow(null)
        }}
      />
    </div>
  )
}

// ----------------------------------------------------------------------------
// Quick Edit Modal — Safe Inventory Adjustment
// ----------------------------------------------------------------------------
// Lets the user update three things on a product:
//   1. Actual Physical Stock (entered as Outer + Pcs for packaged, or a direct
//      count in base_unit for loose items).
//   2. Purchase Rate (per Outer Unit — Bag/Peti for packaged, or per Kg/Gm
//      for loose items).
//   3. Selling Rate (per Outer Unit — Bag/Peti for packaged, or per Kg/Gm
//      for loose items).
//
// Stock adjustment semantics (the "safe" part):
//   The InventoryService treats `product.opening_stock_pcs` as the LIVE
//   running balance (closing_pcs === product.opening_stock_pcs). To make the
//   closing stock match a freshly counted physical value WITHOUT touching any
//   historical purchase / sale / damage record, we apply the delta to
//   opening_stock_pcs:
//
//     newStockPcs    = outerCount * cf + pcsCount     (packaged)
//                  |  = looseCount                     (loose)
//     delta          = newStockPcs - row.closing_pcs
//     updatedOpening = product.opening_stock_pcs + delta
//
//   After save, ProductService.update persists opening_stock_pcs. The
//   Inventory service recomputes on the next render: closing_pcs = new
//   opening = newStockPcs. All purchase / sale / damage history is 100%
//   intact — only the running balance shifts.
//
// Rate adjustment semantics:
//   The user enters the per-Outer purchase & selling rates. We convert the
//   selling rate to per-piece (`selling_rate_per_piece = sellingRateOuter /
//   cf`) before calling ProductService.update, because ProductService.update
//   treats `selling_rate_per_piece` as the primary input and derives the
//   per-outer value from it. ProductService.update then:
//     - recomputes purchase_rate_per_piece = purchase_rate_per_outer_unit / cf
//     - recomputes selling_rate_per_outer_unit = selling_rate_per_piece * cf
//     - syncs legacy aliases (purchase_rate, sales_rate, *_per_pcs)
//     - marks the row isSynced = false  → queued for Turso push
//     - calls scheduleSync('products') to trigger the background push
//
//   The Dexie live query (useInventory) auto-refreshes the table immediately
//   after the Dexie write commits — no manual refetch needed.
// ----------------------------------------------------------------------------

function QuickEditModal({
  row,
  open,
  onOpenChange,
}: {
  row: InventoryRow | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { toast } = useToast()
  const [outerCount, setOuterCount] = useState<number>(0)
  const [pcsCount, setPcsCount] = useState<number>(0)
  const [looseCount, setLooseCount] = useState<number>(0)
  const [purchaseRateOuter, setPurchaseRateOuter] = useState<number>(0)
  const [sellingRateOuter, setSellingRateOuter] = useState<number>(0)
  const [saving, setSaving] = useState<boolean>(false)

  // Reset the form whenever a new row is opened (or the modal closes).
  useEffect(() => {
    if (!row) return
    const isLoose = Boolean(row.product.is_loose)
    const cf = isLoose ? 1 : Number(row.product.conversion_factor) || 1
    const safeCf = cf > 0 ? cf : 1
    if (isLoose) {
      setLooseCount(Number(row.closing_pcs) || 0)
      setOuterCount(0)
      setPcsCount(0)
    } else {
      const total = Number(row.closing_pcs) || 0
      const outer = Math.floor(total / safeCf)
      setOuterCount(outer)
      setPcsCount(total - outer * safeCf)
      setLooseCount(0)
    }
    setPurchaseRateOuter(Number(getPurchaseRatePerOuterUnit(row.product)) || 0)
    setSellingRateOuter(Number(getSellingRatePerOuterUnit(row.product)) || 0)
  }, [row])

  if (!row) return null

  const product = row.product
  const isLoose = Boolean(product.is_loose)
  const cf = isLoose ? 1 : Number(product.conversion_factor) || 1
  const safeCf = cf > 0 ? cf : 1

  // New physical stock in base units (Pcs / Kg / Gm)
  const newStockPcs = isLoose
    ? Number(looseCount) || 0
    : (Number(outerCount) || 0) * safeCf + (Number(pcsCount) || 0)

  const currentStockPcs = Number(row.closing_pcs) || 0
  const delta = newStockPcs - currentStockPcs
  const updatedOpeningStock =
    Number(product.opening_stock_pcs) + delta

  // Live preview of derived per-piece rates
  const newPurchaseRatePerPiece =
    safeCf > 0 ? (Number(purchaseRateOuter) || 0) / safeCf : 0
  const newSellingRatePerPiece =
    safeCf > 0 ? (Number(sellingRateOuter) || 0) / safeCf : 0

  const save = async () => {
    if (!product.id) {
      toast({
        title: 'Cannot save',
        description: 'Product has no id.',
        variant: 'destructive',
      })
      return
    }
    setSaving(true)
    try {
      // Build a minimal patch. ProductService.update handles:
      //   - rate recompute (purchase_rate_per_outer_unit is in the trigger
      //     list; selling_rate_per_piece is in the trigger list)
      //   - legacy alias sync (purchase_rate, sales_rate, *_per_pcs)
      //   - isSynced = false  (queued for Turso push)
      //   - scheduleSync('products')
      const patch: Partial<Product> = {
        opening_stock_pcs: updatedOpeningStock,
        purchase_rate_per_outer_unit: Number(purchaseRateOuter) || 0,
        // Pass the per-piece selling rate so ProductService.update can
        // recompute the per-outer value + legacy aliases consistently.
        selling_rate_per_piece: newSellingRatePerPiece,
      }
      await ProductService.update(product.id, patch)
      toast({
        title: 'Inventory updated',
        description: `${product.name} — stock adjusted to ${formatNumber(newStockPcs, isLoose ? 3 : 0)} ${product.base_unit}; rates refreshed.`,
      })
      onOpenChange(false)
    } catch (e) {
      toast({
        title: 'Update failed',
        description: String(e),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const rateUnit = isLoose ? product.base_unit : product.outer_unit
  const stockDecimals = isLoose ? 3 : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Quick Edit · {product.name}</DialogTitle>
        </DialogHeader>

        {/* ---- Product context strip ---- */}
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              <strong>SKU:</strong>{' '}
              <span className="font-mono">{product.sku}</span>
            </span>
            <span>
              <strong>Company:</strong> {product.company_name}
            </span>
            {product.category && (
              <span>
                <strong>Category:</strong> {product.category}
              </span>
            )}
            <span>
              <strong>Type:</strong> {isLoose ? 'Loose' : 'Packaged'}
            </span>
            <span>
              <strong>HSN:</strong>{' '}
              <span className="font-mono">{product.hsn_code}</span>
            </span>
            <span>
              <strong>CF:</strong> 1 {product.outer_unit} ={' '}
              {formatNumber(cf, 0)} {product.base_unit}
            </span>
          </div>
        </div>

        {/* ---- Actual Physical Stock section ---- */}
        <div className="space-y-2">
          <div className="text-sm font-semibold">Actual Physical Stock</div>

          {isLoose ? (
            <Field label={`Physical Count (in ${product.base_unit})`}>
              <Input
                type="number"
                step="0.001"
                min={0}
                value={looseCount}
                onChange={(e) => setLooseCount(Number(e.target.value))}
              />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Outer Count (in ${product.outer_unit})`}>
                <Input
                  type="number"
                  min={0}
                  value={outerCount}
                  onChange={(e) => setOuterCount(Number(e.target.value))}
                />
              </Field>
              <Field label={`Loose Pcs (in ${product.base_unit})`}>
                <Input
                  type="number"
                  min={0}
                  value={pcsCount}
                  onChange={(e) => setPcsCount(Number(e.target.value))}
                />
              </Field>
            </div>
          )}

          {/* Delta info panel */}
          <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                Current calculated:{' '}
                <strong>
                  {formatNumber(currentStockPcs, stockDecimals)}{' '}
                  {product.base_unit}
                </strong>
              </span>
              <span>
                New physical:{' '}
                <strong>
                  {formatNumber(newStockPcs, stockDecimals)}{' '}
                  {product.base_unit}
                </strong>
              </span>
              <span>
                Delta:{' '}
                <strong
                  className={
                    delta === 0
                      ? 'text-muted-foreground'
                      : delta > 0
                        ? 'text-emerald-700'
                        : 'text-red-700'
                  }
                >
                  {delta > 0 ? '+' : ''}
                  {formatNumber(delta, stockDecimals)} {product.base_unit}
                </strong>
              </span>
            </div>
            <div className="mt-1 text-[10px] opacity-80">
              Applied as a delta to <code>opening_stock_pcs</code> ({formatNumber(Number(product.opening_stock_pcs) || 0, stockDecimals)} → {formatNumber(updatedOpeningStock, stockDecimals)}). Historical purchases, sales, and damages stay 100% intact.
            </div>
          </div>
        </div>

        {/* ---- Rates section ---- */}
        <div className="space-y-2">
          <div className="text-sm font-semibold">Rates</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Purchase Rate (per ${rateUnit})`}>
              <Input
                type="number"
                step="0.01"
                min={0}
                value={purchaseRateOuter}
                onChange={(e) => setPurchaseRateOuter(Number(e.target.value))}
              />
            </Field>
            <Field label={`Selling Rate (per ${rateUnit})`}>
              <Input
                type="number"
                step="0.01"
                min={0}
                value={sellingRateOuter}
                onChange={(e) => setSellingRateOuter(Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            <div className="opacity-80">
              Auto-derived per-{product.base_unit} rates (saved on submit):
            </div>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <div>
                Purchase / {product.base_unit} ={' '}
                <strong>₹{newPurchaseRatePerPiece.toFixed(4)}</strong>
              </div>
              <div>
                Selling / {product.base_unit} ={' '}
                <strong>₹{newSellingRatePerPiece.toFixed(4)}</strong>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-xs font-medium text-foreground">{label}</Label>
      {children}
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
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-base font-semibold lg:text-lg">{value}</div>
    </div>
  )
}

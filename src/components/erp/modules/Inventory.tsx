'use client'

import { useState, useMemo } from 'react'
import { useInventory } from '@/lib/hooks/use-erp'
import {
  formatINR,
  formatNumber,
  downloadCSV,
  todayISO,
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
import { useToast } from '@/hooks/use-toast'
import { Warehouse, Search, Download, AlertTriangle } from 'lucide-react'

export function Inventory() {
  const inventory = useInventory()
  const { toast } = useToast()
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
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

  const totals = useMemo(() => {
    return (inventory ?? []).reduce(
      (acc, row) => {
        acc.closingPcs += row.closing_pcs
        acc.closingBags += row.closing_bags
        acc.value += row.bag_value
        acc.lowStock += row.closing_pcs <= 10 ? 1 : 0
        return acc
      },
      { closingPcs: 0, closingBags: 0, value: 0, lowStock: 0 }
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
        'Opening Stock (Pcs)',
        'Purchased (Pcs)',
        'Sold (Pcs)',
        'Damaged (Pcs)',
        'Purchase Returned (Pcs)',
        'Sales Returned (Pcs)',
        'Closing (Pcs)',
        'Closing (Bags)',
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
        r.opening_stock_pcs,
        r.purchased_pcs,
        r.sold_pcs,
        r.damaged_pcs,
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
        description="Live stock position reconstructed from opening + purchases − sales."
        actions={
          <Button variant="outline" onClick={exportCsv}>
            <Download className="mr-1 h-4 w-4" /> Export CSV
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total SKUs" value={String(inventory?.length ?? 0)} />
        <StatCard label="Closing Pcs" value={formatNumber(totals.closingPcs, 0)} variant="info" />
        <StatCard label="Closing Bags" value={formatNumber(totals.closingBags, 0)} variant="success" />
        <StatCard label="Stock Value" value={formatINR(totals.value)} />
      </div>

      {totals.lowStock > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4" />
          {totals.lowStock} SKU{totals.lowStock > 1 ? 's are' : ' is'} running low (≤ 10 Pcs). Consider reordering.
        </div>
      )}

      <Card>
        <CardContent className="p-4">
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
              title="No inventory"
              description="Add products and record purchases to see stock here."
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
                    <TableHead className="text-right">Damaged (Pcs)</TableHead>
                    <TableHead className="text-right">Pur. Returned (Pcs)</TableHead>
                    <TableHead className="text-right">Sales Returned (Pcs)</TableHead>
                    <TableHead className="text-right">Closing (Pcs)</TableHead>
                    <TableHead className="text-right">Closing (Bags)</TableHead>
                    <TableHead className="text-right">Stock Value</TableHead>
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
                        <TableCell className="text-right text-xs text-amber-600">
                          -{formatNumber(r.damaged_pcs, 0)}
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

function StatCard({
  label,
  value,
  variant = 'default',
}: {
  label: string
  value: string
  variant?: 'default' | 'success' | 'info'
}) {
  const styles = {
    default: 'border-border bg-card',
    success: 'border-emerald-200 bg-emerald-50',
    info: 'border-sky-200 bg-sky-50',
  }[variant]
  return (
    <div className={`rounded-md border p-3 ${styles}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-base font-semibold lg:text-lg">{value}</div>
    </div>
  )
}

'use client'

import { useState, useMemo } from 'react'
import { useSales, useCustomers } from '@/lib/hooks/use-erp'
import { SaleService } from '@/lib/services/repository'
import {
  formatINR,
  formatNumber,
  formatDate,
  downloadCSV,
  todayISO,
  sortByDateDesc,
} from '@/lib/utils/format'
import { PageHeader, EmptyState } from '@/components/erp/EmptyState'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { PrintableDSR } from '@/components/erp/PrintableDSR'
import { SaleEditDialog } from '@/components/erp/modules/SaleEditDialog'
import {
  BookOpen,
  Search,
  Trash2,
  Eye,
  Download,
  TrendingUp,
  TrendingDown,
  Printer,
  Pencil,
} from 'lucide-react'
import type { Sale, SaleItem } from '@/lib/db/dexie'

export function SalesLedger() {
  const sales = useSales()
  const customers = useCustomers()
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<'All' | 'Cash' | 'Credit'>('All')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [viewSale, setViewSale] = useState<{ sale: Sale; items: SaleItem[] } | null>(null)

  // Upgrade 2 — Edit dialog state. When editSaleId is non-null, the
  // SaleEditDialog is mounted and loads that sale via SaleService.get().
  const [editSaleId, setEditSaleId] = useState<number | null>(null)
  const [editOpen, setEditOpen] = useState(false)

  // ---- DSR Print State ----
  const [dsrOpen, setDsrOpen] = useState(false)
  const [dsrDate, setDsrDate] = useState(todayISO())

  // ---- DSR: sales filtered for the selected date ----
  const dsrSales = useMemo(() => {
    return (sales ?? []).filter((s) => s.date === dsrDate)
  }, [sales, dsrDate])

  const filtered = useMemo(() => {
    let list = sales ?? []
    if (mode !== 'All') list = list.filter((s) => s.payment_mode === mode)
    if (fromDate) list = list.filter((s) => s.date >= fromDate)
    if (toDate) list = list.filter((s) => s.date <= toDate)
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (s) =>
          s.invoice_no.toLowerCase().includes(q) ||
          s.customer_name.toLowerCase().includes(q)
      )
    }
    // Strict date-wise sorting (newest business date first) — backdated
    // entries sit at their exact date position; `id` DESC is only a
    // tie-breaker for rows sharing the same date.
    return sortByDateDesc(list)
  }, [sales, mode, fromDate, toDate, search])

  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, s) => {
        acc.revenue += s.total_amount
        acc.profit += s.total_profit
        return acc
      },
      { revenue: 0, profit: 0 }
    )
  }, [filtered])

  const exportCsv = () => {
    const rows: (string | number)[][] = [
      [
        'Date',
        'Invoice No',
        'Customer',
        'Subtotal',
        'CGST',
        'SGST',
        'Total',
        'Payment Mode',
        'Profit',
        'Margin %',
      ],
      ...filtered.map((s) => [
        s.date,
        s.invoice_no,
        s.customer_name,
        s.subtotal.toFixed(2),
        s.cgst.toFixed(2),
        s.sgst.toFixed(2),
        s.total_amount.toFixed(2),
        s.payment_mode,
        s.total_profit.toFixed(2),
        s.total_margin_percent.toFixed(2),
      ]),
    ]
    downloadCSV(`sales-ledger-${todayISO()}`, rows)
    toast({ title: 'CSV downloaded', description: `${filtered.length} rows` })
  }

  const removeSale = async (s: Sale) => {
    if (!confirm(`Delete invoice ${s.invoice_no}? This will NOT auto-restore stock.`)) return
    await SaleService.remove(s.id!)
    toast({ title: 'Invoice deleted', description: s.invoice_no })
  }

  const view = async (s: Sale) => {
    const detail = await SaleService.get(s.id!)
    if (detail) setViewSale(detail)
  }

  // Upgrade 2 — open the Edit dialog for a sale
  const edit = (s: Sale) => {
    if (s.id == null) return
    setEditSaleId(s.id)
    setEditOpen(true)
  }

  // Upgrade 2 — after a successful edit, refresh the toast confirmation.
  // The live query (useSales) auto-refreshes when IndexedDB changes, so no
  // manual refetch is needed here.
  const onEditSaved = () => {
    toast({ title: 'Ledger refreshed', description: 'Edit saved.' })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sales Entry & Ledger"
        description="Master transaction table for all sales with profit & margin analysis."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                value={dsrDate}
                onChange={(e) => setDsrDate(e.target.value)}
                className="h-8 w-[140px] text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (dsrSales.length === 0) {
                    toast({
                      title: 'No sales for this date',
                      description: `No sales found for ${dsrDate}`,
                      variant: 'destructive',
                    })
                    return
                  }
                  setDsrOpen(true)
                }}
              >
                <Printer className="mr-1 h-3.5 w-3.5" /> Print DSR
              </Button>
            </div>
            <Button variant="outline" onClick={exportCsv}>
              <Download className="mr-1 h-4 w-4" /> Export CSV
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input

                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={mode} onValueChange={(v: 'All' | 'Cash' | 'Credit') => setMode(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Modes</SelectItem>
                <SelectItem value="Cash">Cash Only</SelectItem>
                <SelectItem value="Credit">Credit Only</SelectItem>
              </SelectContent>
            </Select>
            <div>
              <Label className="mb-1 block text-xs">From Date</Label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1 block text-xs">To Date</Label>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Invoices" value={String(filtered.length)} />
        <SummaryCard label="Revenue" value={formatINR(totals.revenue)} variant="info" />
        <SummaryCard
          label="Profit"
          value={formatINR(totals.profit)}
          variant={totals.profit >= 0 ? 'success' : 'danger'}
        />
        <SummaryCard
          label="Avg Margin"
          value={`${formatNumber(totals.revenue ? (totals.profit / totals.revenue) * 100 : 0, 2)}%`}
        />
      </div>

      <Card>
        <CardContent className="p-4">
          {filtered.length === 0 ? (
            <EmptyState
              title="No sales found"
              description="Try adjusting filters or record a sale from the POS module."
              icon={<BookOpen className="h-6 w-6" />}
            />
          ) : (
            <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="text-right">Subtotal</TableHead>
                    <TableHead className="text-right">CGST</TableHead>
                    <TableHead className="text-right">SGST</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Profit</TableHead>
                    <TableHead className="text-right">Margin</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.slice(0, 200).map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-xs">{formatDate(s.date)}</TableCell>
                      <TableCell className="font-mono text-xs">{s.invoice_no}</TableCell>
                      <TableCell className="text-sm">{s.customer_name}</TableCell>
                      <TableCell>
                        <span
                          className={
                            'inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ' +
                            (s.payment_mode === 'Cash'
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-amber-100 text-amber-700')
                          }
                        >
                          {s.payment_mode}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs">{s.id ? '—' : '-'}</TableCell>
                      <TableCell className="text-right text-xs">{formatINR(s.subtotal)}</TableCell>
                      <TableCell className="text-right text-xs">{formatINR(s.cgst)}</TableCell>
                      <TableCell className="text-right text-xs">{formatINR(s.sgst)}</TableCell>
                      <TableCell className="text-right text-xs font-semibold">{formatINR(s.total_amount)}</TableCell>
                      <TableCell className="text-right text-xs">
                        <span className={s.total_profit >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                          {s.total_profit >= 0 ? <TrendingUp className="mr-0.5 inline h-3 w-3" /> : <TrendingDown className="mr-0.5 inline h-3 w-3" />}
                          {formatINR(s.total_profit)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {formatNumber(s.total_margin_percent, 1)}%
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => view(s)} title="View">
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          {/* Upgrade 2 — Edit action: opens SaleEditDialog */}
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => edit(s)} title="Edit">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeSale(s)} title="Delete">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* View sale detail */}
      <Dialog open={!!viewSale} onOpenChange={(o) => !o && setViewSale(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>{viewSale?.sale.invoice_no}</span>
              <span className="rounded bg-muted px-2 py-0.5 text-xs">
                {viewSale?.sale.payment_mode}
              </span>
            </DialogTitle>
          </DialogHeader>
          {viewSale && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <Info label="Date" value={formatDate(viewSale.sale.date)} />
                <Info label="Customer" value={viewSale.sale.customer_name} />
                <Info label="Total" value={formatINR(viewSale.sale.total_amount)} />
                <Info label="Profit" value={formatINR(viewSale.sale.total_profit)} />
              </div>
              <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Qty (Pcs)</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">GST%</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Profit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {viewSale.items.map((it) => (
                      <TableRow key={it.id}>
                        <TableCell className="text-xs">
                          <div className="font-medium">{it.product_name}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {it.product_sku} · HSN {it.hsn_code}
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-xs">{formatNumber(it.quantity_pcs, 0)}</TableCell>
                        <TableCell className="text-right text-xs">{formatINR(it.rate)}</TableCell>
                        <TableCell className="text-right text-xs">{it.gst_percent}%</TableCell>
                        <TableCell className="text-right text-xs">{formatINR(it.taxable_amount)}</TableCell>
                        <TableCell className="text-right text-xs font-semibold">{formatINR(it.total)}</TableCell>
                        <TableCell className="text-right text-xs text-emerald-600">{formatINR(it.item_profit)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Daily Sales Report (DSR) Print Modal ---- */}
      {dsrOpen && (
        <PrintableDSR
          sales={dsrSales}
          customers={customers}
          date={dsrDate}
          onClose={() => setDsrOpen(false)}
        />
      )}

      {/* ---- Upgrade 2 — Sale Edit Dialog ---- */}
      <SaleEditDialog
        saleId={editSaleId}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={onEditSaved}
      />
    </div>
  )
}

function SummaryCard({
  label,
  value,
  variant = 'default',
}: {
  label: string
  value: string
  variant?: 'default' | 'success' | 'danger' | 'info'
}) {
  const styles = {
    default: 'border-border bg-card',
    success: 'border-emerald-200 bg-emerald-50',
    danger: 'border-red-200 bg-red-50',
    info: 'border-sky-200 bg-sky-50',
  }[variant]
  return (
    <div className={`rounded-md border px-3 py-2 ${styles}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  )
}

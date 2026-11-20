'use client'

// ============================================================================
// Monthly Sales Bill Summary — READ-ONLY view over Dexie `db.sales`
// ----------------------------------------------------------------------------
// Groups all non-deleted credit/cash sales by Month & Year (business `date`
// field), newest month first, and shows per month:
//   - Total Bill Count
//   - Total Sales Amount
//   - Invoice Number Range (first → last by date/invoice_no)
//   - Expandable list of every bill: Invoice No, Date, Customer, Amount
//
// Extras: Month filter dropdown, quick search (Invoice No / Customer Name),
// and CSV export (summary + detailed bill list) for GST / accounting.
//
// STRICTLY READ-ONLY: reads sales via useSales() (SaleService.all() already
// filters is_deleted). No Dexie schema change, no sync change, no writes.
// ============================================================================

import { useState, useMemo } from 'react'
import { useSales } from '@/lib/hooks/use-erp'
import {
  formatINR,
  formatDate,
  downloadCSV,
} from '@/lib/utils/format'
import type { Sale } from '@/lib/db/dexie'
import { PageHeader, EmptyState } from '@/components/erp/EmptyState'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Search,
  Download,
  FileSpreadsheet,
  Receipt,
} from 'lucide-react'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// ----------------------------------------------------------------------------
// Month bucket type
// ----------------------------------------------------------------------------

interface MonthBucket {
  key: string // "2026-11" — sort key (newest first)
  label: string // "November 2026"
  bills: Sale[] // sorted by date asc, then invoice_no asc
  totalAmount: number
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Normalize a sale's business date to a "YYYY-MM" bucket key.
 * Falls back to created_at when `date` is missing, and to "unknown" when
 * neither is parseable (bucketed last, labeled "Unknown Date").
 */
function monthKeyOf(sale: Sale): string {
  const raw = (sale.date || '').slice(0, 10)
  let m = raw.match(/^(\d{4})-(\d{1,2})/)
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}`
  }
  // Fallback: created_at ISO timestamp
  const created = (sale.created_at || '').slice(0, 10)
  m = created.match(/^(\d{4})-(\d{1,2})/)
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}`
  }
  return 'unknown'
}

/** "2026-11" → "November 2026"; "unknown" → "Unknown Date". */
function monthLabel(key: string): string {
  const m = key.match(/^(\d{4})-(\d{2})$/)
  if (!m) return 'Unknown Date'
  const monthName = MONTHS[parseInt(m[2], 10) - 1] ?? ''
  return `${monthName} ${m[1]}`
}

/**
 * Defensive date normalizer for sorting: pads YYYY-M-D → YYYY-MM-DD so plain
 * string comparison matches chronological order. Invalid → '' (sorts first,
 * but such rows are already routed to the "unknown" bucket by monthKeyOf).
 */
function normDate(d: string | undefined): string {
  if (!d) return ''
  const s = String(d).slice(0, 10)
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!m) return s
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

/** Bills sorted by business date ascending, then invoice_no ascending. */
function sortBills(bills: Sale[]): Sale[] {
  return [...bills].sort((a, b) => {
    const da = normDate(a.date)
    const dbb = normDate(b.date)
    if (da !== dbb) return da.localeCompare(dbb)
    const ia = (a.invoice_no ?? '').toLowerCase()
    const ib = (b.invoice_no ?? '').toLowerCase()
    // Natural-ish compare: numeric suffix aware fallback
    if (ia !== ib) return ia.localeCompare(ib, undefined, { numeric: true })
    // Final tie-break: Dexie id (creation order)
    return (a.id ?? 0) - (b.id ?? 0)
  })
}

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

export function MonthlyBillSummary() {
  const sales = useSales() // non-deleted only (SaleService.all() filters)

  // "all" or "YYYY-MM"
  const [monthFilter, setMonthFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  // Expanded month buckets (Set of bucket keys)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // ---- Group sales by month (newest first) ----
  const allBuckets = useMemo<MonthBucket[]>(() => {
    const map = new Map<string, Sale[]>()
    for (const s of sales ?? []) {
      const key = monthKeyOf(s)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(s)
    }
    const buckets: MonthBucket[] = []
    for (const [key, bills] of map.entries()) {
      const sorted = sortBills(bills)
      buckets.push({
        key,
        label: monthLabel(key),
        bills: sorted,
        totalAmount: sorted.reduce((sum, b) => sum + (b.total_amount || 0), 0),
      })
    }
    // Newest month first; "unknown" always last.
    buckets.sort((a, b) => {
      if (a.key === 'unknown') return 1
      if (b.key === 'unknown') return -1
      return b.key.localeCompare(a.key)
    })
    return buckets
  }, [sales])

  // ---- Apply month filter + search (invoice_no / customer_name) ----
  const visibleBuckets = useMemo<MonthBucket[]>(() => {
    const q = search.trim().toLowerCase()
    let buckets = allBuckets
    if (monthFilter !== 'all') {
      buckets = buckets.filter((b) => b.key === monthFilter)
    }
    if (!q) return buckets
    // Search filters bills; months with no matching bills are hidden.
    // Stats (count / total / range) recompute on the filtered bill set so
    // the numbers always reflect what's on screen.
    return buckets
      .map((b) => {
        const filtered = b.bills.filter(
          (s) =>
            (s.invoice_no ?? '').toLowerCase().includes(q) ||
            (s.customer_name ?? '').toLowerCase().includes(q)
        )
        return {
          ...b,
          bills: filtered,
          totalAmount: filtered.reduce(
            (sum, s) => sum + (s.total_amount || 0),
            0
          ),
        }
      })
      .filter((b) => b.bills.length > 0)
  }, [allBuckets, monthFilter, search])

  // Grand totals across the visible (filtered) scope
  const grandTotals = useMemo(() => {
    let count = 0
    let amount = 0
    for (const b of visibleBuckets) {
      count += b.bills.length
      amount += b.totalAmount
    }
    return { count, amount }
  }, [visibleBuckets])

  // ---- Expand / collapse toggle ----
  const toggleMonth = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  // ---- CSV exports (respect current month filter + search) ----
  const exportSummaryCSV = () => {
    const rows: (string | number)[][] = [
      ['Month', 'Bill Count', 'Total Sales Amount'],
      ...visibleBuckets.map((b) => [b.label, b.bills.length, b.totalAmount]),
      ['TOTAL', grandTotals.count, grandTotals.amount],
    ]
    downloadCSV('monthly-sales-summary', rows)
  }

  const exportBillsCSV = () => {
    const rows: (string | number)[][] = [
      ['Month', 'Invoice No', 'Date', 'Customer Name', 'Total Amount'],
    ]
    for (const b of visibleBuckets) {
      for (const s of b.bills) {
        rows.push([
          b.label,
          s.invoice_no ?? '',
          normDate(s.date),
          s.customer_name ?? '',
          s.total_amount ?? 0,
        ])
      }
    }
    downloadCSV('monthly-sales-bills', rows)
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Monthly Sales Bill Summary"
        description="Month-wise bill count, sales total & invoice range — read-only view for GST / accounting."
      />

      {/* ---- Toolbar: month filter + search + exports ---- */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-4">
          <div className="w-52">
            <Select value={monthFilter} onValueChange={setMonthFilter}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="All Months" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Months</SelectItem>
                {allBuckets.map((b) => (
                  <SelectItem key={b.key} value={b.key}>
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search invoice no / customer..."
              className="h-9 pl-9 text-xs"
            />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs sm:block">
              <span className="text-muted-foreground">Bills:</span>{' '}
              <strong>{grandTotals.count}</strong>
              <span className="ml-3 text-muted-foreground">Total:</span>{' '}
              <strong className="text-emerald-600">
                {formatINR(grandTotals.amount)}
              </strong>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-xs"
              onClick={exportSummaryCSV}
              disabled={visibleBuckets.length === 0}
              title="Download month-wise summary (count + amount)"
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              Summary CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-xs"
              onClick={exportBillsCSV}
              disabled={grandTotals.count === 0}
              title="Download detailed bill list (invoice / date / customer / amount)"
            >
              <FileSpreadsheet className="mr-1 h-3.5 w-3.5" />
              Bills CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ---- Month buckets ---- */}
      {visibleBuckets.length === 0 ? (
        <EmptyState
          title={(sales ?? []).length === 0 ? 'No sales yet' : 'No matches'}
          description={
            (sales ?? []).length === 0
              ? 'Create your first bill in Sales Bill (POS).'
              : 'No bills match the current month filter / search.'
          }
          icon={<CalendarRange className="h-6 w-6" />}
        />
      ) : (
        <div className="space-y-3">
          {visibleBuckets.map((bucket) => {
            const isOpen = expanded.has(bucket.key)
            const firstInv = bucket.bills[0]?.invoice_no ?? '—'
            const lastInv =
              bucket.bills[bucket.bills.length - 1]?.invoice_no ?? '—'
            const rangeLabel =
              bucket.bills.length === 1
                ? firstInv
                : `${firstInv} → ${lastInv}`
            return (
              <Card key={bucket.key}>
                {/* Month header — click to expand/collapse */}
                <button
                  type="button"
                  onClick={() => toggleMonth(bucket.key)}
                  className="flex w-full items-center gap-3 rounded-t-lg border-b border-border bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                  title={isOpen ? 'Collapse bill list' : 'Expand bill list'}
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{bucket.label}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>
                        Bills: <strong className="text-foreground">{bucket.bills.length}</strong>
                      </span>
                      <span>
                        Invoice Range:{' '}
                        <span className="font-mono text-foreground">
                          {rangeLabel}
                        </span>
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Total Sales
                    </div>
                    <div className="text-base font-semibold text-emerald-600">
                      {formatINR(bucket.totalAmount)}
                    </div>
                  </div>
                </button>

                {/* Expanded bill list */}
                {isOpen && (
                  <CardContent className="p-0">
                    <div className="scrollbar-thin max-h-96 overflow-y-auto">
                      <Table>
                        <TableHeader className="sticky top-0 bg-card">
                          <TableRow>
                            <TableHead className="text-xs">Invoice No</TableHead>
                            <TableHead className="text-xs">Date</TableHead>
                            <TableHead className="text-xs">Customer</TableHead>
                            <TableHead className="text-right text-xs">
                              Total Amount
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {bucket.bills.map((s) => (
                            <TableRow key={s.id}>
                              <TableCell className="font-mono text-xs font-semibold">
                                <Receipt className="mr-1 inline h-3 w-3 text-muted-foreground" />
                                {s.invoice_no}
                              </TableCell>
                              <TableCell className="text-xs">
                                {formatDate(s.date)}
                              </TableCell>
                              <TableCell className="text-xs">
                                {s.customer_name}
                              </TableCell>
                              <TableCell className="text-right text-xs font-semibold">
                                {formatINR(s.total_amount)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

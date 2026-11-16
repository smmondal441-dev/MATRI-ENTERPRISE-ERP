'use client'

// ============================================================================
// CompanyAnalytics — Company-wise Analytics Dashboard (Month + Company Filter)
// ----------------------------------------------------------------------------
// Fetches aggregated data from /api/analytics/company?month=YYYY-MM&company=X
// Uses Vanilla JS aggregation on the server (no Polars).
//
// Features:
//   - Month picker (defaults to current month)
//   - Company dropdown (defaults to "All Companies")
//   - 4 summary stat cards (recalculated for the selected company)
//   - Sortable data table with all metrics
//   - Export CSV button
// ============================================================================

import { useState, useMemo, useEffect } from 'react'
import { formatINR, formatNumber, downloadCSV, todayISO } from '@/lib/utils/format'
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
import { useToast } from '@/hooks/use-toast'
import { BarChart3, Download, RefreshCw, Building2, AlertTriangle, Wallet, TrendingUp } from 'lucide-react'

interface CompanyRow {
  company_name: string
  bought_pcs: string
  purchase_value: number
  sold_pcs: string
  sales_value: number
  gross_profit: number
  dead_stock_pcs: string
  dead_stock_value: number
  profit_percent: number
}

interface Summary {
  topCompany: { name: string; sales_value: number; profit_percent: number } | null
  totalDeadStockValue: number
  totalGrossProfit: number
  avgProfitPercent: number
  totalCompanies: number
}

interface ApiResponse {
  ok: boolean
  month: string
  company: string
  companies: CompanyRow[]
  allCompanies: string[]
  summary: Summary | null
  error?: string
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function CompanyAnalytics() {
  const { toast } = useToast()
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)

  // Month/Year selectors — default to current month
  const now = new Date()
  const [selectedMonth, setSelectedMonth] = useState(String(now.getMonth()))
  const [selectedYear, setSelectedYear] = useState(String(now.getFullYear()))
  const [selectedCompany, setSelectedCompany] = useState('All')

  const [sortBy, setSortBy] = useState<'sales_value' | 'gross_profit' | 'dead_stock_value' | 'profit_percent' | 'company_name' | 'purchase_value'>('sales_value')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Build the YYYY-MM query param
  const monthParam = useMemo(() => {
    const m = String(Number(selectedMonth) + 1).padStart(2, '0')
    return `${selectedYear}-${m}`
  }, [selectedMonth, selectedYear])

  const fetchData = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ month: monthParam })
      if (selectedCompany !== 'All') {
        params.set('company', selectedCompany)
      }
      const res = await fetch(`/api/analytics/company?${params.toString()}`, {
        cache: 'no-store',
      })
      const json = (await res.json()) as ApiResponse
      if (!json.ok) {
        toast({ title: 'Failed to load analytics', description: json.error, variant: 'destructive' })
      }
      setData(json)
    } catch (e: any) {
      toast({ title: 'Network error', description: e?.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthParam, selectedCompany])

  const sortedCompanies = useMemo(() => {
    if (!data?.companies) return []
    const rows = [...data.companies]
    rows.sort((a, b) => {
      let valA: any, valB: any
      if (sortBy === 'company_name') {
        valA = a.company_name.toLowerCase()
        valB = b.company_name.toLowerCase()
      } else {
        valA = a[sortBy]
        valB = b[sortBy]
      }
      if (typeof valA === 'string') {
        return sortDir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA)
      }
      return sortDir === 'asc' ? valA - valB : valB - valA
    })
    return rows
  }, [data, sortBy, sortDir])

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(col)
      setSortDir('desc')
    }
  }

  const exportCsv = () => {
    if (!data?.companies) return
    const rows: (string | number)[][] = [
      ['Company', 'Bought (Pcs)', 'Purchase Value (₹)', 'Sold (Pcs)', 'Sales Value (₹)', 'Gross Profit (₹)', 'Dead Stock (Pcs)', 'Dead Stock Value (₹)', 'Profit %'],
      ...sortedCompanies.map((c) => [
        c.company_name,
        c.bought_pcs,
        c.purchase_value.toFixed(2),
        c.sold_pcs,
        c.sales_value.toFixed(2),
        c.gross_profit.toFixed(2),
        c.dead_stock_pcs,
        c.dead_stock_value.toFixed(2),
        c.profit_percent.toFixed(2),
      ]),
    ]
    downloadCSV(`company-analytics-${monthParam}-${selectedCompany}`, rows)
    toast({ title: 'CSV downloaded' })
  }

  const summary = data?.summary
  const allCompanies = data?.allCompanies ?? []

  return (
    <div className="space-y-4">
      <PageHeader
        title="Company-wise Analytics"
        description="Track bought vs sold per company, dead stock, and profit margins — filtered by month and company."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={fetchData} disabled={loading}>
              <RefreshCw className={'mr-1 h-4 w-4 ' + (loading ? 'animate-spin' : '')} />
              Refresh
            </Button>
            <Button variant="outline" onClick={exportCsv} disabled={!data?.companies?.length}>
              <Download className="mr-1 h-4 w-4" /> Export CSV
            </Button>
          </div>
        }
      />

      {/* ---- Filter bar: Month + Company ---- */}
      <Card>
        <CardContent className="p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <Label className="mb-1 block text-xs font-medium">Month</Label>
              <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => (
                    <SelectItem key={m} value={String(i)}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1 block text-xs font-medium">Year</Label>
              <Select value={selectedYear} onValueChange={setSelectedYear}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 5 }).map((_, i) => {
                    const y = new Date().getFullYear() - i
                    return <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  })}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1 block text-xs font-medium">Company</Label>
              <Select
                value={selectedCompany}
                onValueChange={(v) => setSelectedCompany(v)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="All">All Companies</SelectItem>
                  {allCompanies.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="ml-3 text-sm text-muted-foreground">
            Aggregating for {MONTHS[Number(selectedMonth)]} {selectedYear}
            {selectedCompany !== 'All' ? ` · ${selectedCompany}` : ''}...
          </span>
        </div>
      ) : !data?.ok || !data.companies?.length ? (
        <EmptyState
          title="No analytics data"
          description={`No data found for ${MONTHS[Number(selectedMonth)]} ${selectedYear}.`}
          icon={<BarChart3 className="h-6 w-6" />}
        />
      ) : (
        <>
          {/* ---- Summary stat cards ---- */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              icon={<Building2 className="h-4 w-4" />}
              label={selectedCompany !== 'All' ? 'Selected Company' : 'Top Company'}
              value={summary?.topCompany?.name ?? '—'}
              subtext={summary?.topCompany ? `${formatINR(summary.topCompany.sales_value)} sales` : ''}
              variant="info"
            />
            <StatCard
              icon={<AlertTriangle className="h-4 w-4" />}
              label="Dead Stock Value"
              value={formatINR(summary?.totalDeadStockValue ?? 0)}
              subtext="Unsold inventory at cost"
              variant="danger"
            />
            <StatCard
              icon={<TrendingUp className="h-4 w-4" />}
              label="Total Gross Profit"
              value={formatINR(summary?.totalGrossProfit ?? 0)}
              subtext={selectedCompany !== 'All' ? selectedCompany : 'Across all companies'}
              variant="success"
            />
            <StatCard
              icon={<Wallet className="h-4 w-4" />}
              label="Avg Profit Margin"
              value={`${formatNumber(summary?.avgProfitPercent ?? 0, 1)}%`}
              subtext={`${summary?.totalCompanies ?? 0} ${summary?.totalCompanies === 1 ? 'company' : 'companies'} shown`}
              variant="default"
            />
          </div>

          {/* ---- Data table ---- */}
          <Card>
            <CardContent className="p-4">
              <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortHead label="Company" col="company_name" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                      <SortHead label="Bought (Pcs)" col="bought_pcs" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                      <SortHead label="Sold (Pcs)" col="sold_pcs" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                      <SortHead label="Dead Stock" col="dead_stock_pcs" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                      <SortHead label="Dead Stock Value" col="dead_stock_value" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                      <SortHead label="Purchase Value" col="purchase_value" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                      <SortHead label="Sales Value" col="sales_value" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                      <SortHead label="Gross Profit" col="gross_profit" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                      <SortHead label="Profit %" col="profit_percent" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedCompanies.map((c) => (
                      <TableRow key={c.company_name}>
                        <TableCell className="font-medium text-sm">{c.company_name}</TableCell>
                        <TableCell className="text-right text-xs">{formatNumber(Number(c.bought_pcs), 0)}</TableCell>
                        <TableCell className="text-right text-xs">{formatNumber(Number(c.sold_pcs), 0)}</TableCell>
                        <TableCell className="text-right text-xs">
                          <span className={Number(c.dead_stock_pcs) > 0 ? 'font-semibold text-amber-700' : 'text-muted-foreground'}>
                            {formatNumber(Number(c.dead_stock_pcs), 0)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          <span className={c.dead_stock_value > 0 ? 'text-red-600 font-medium' : 'text-muted-foreground'}>
                            {formatINR(c.dead_stock_value)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{formatINR(c.purchase_value)}</TableCell>
                        <TableCell className="text-right text-xs font-medium">{formatINR(c.sales_value)}</TableCell>
                        <TableCell className="text-right text-xs">
                          <span className={c.gross_profit >= 0 ? 'font-semibold text-emerald-700' : 'font-semibold text-red-700'}>
                            {formatINR(c.gross_profit)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          <span className={c.profit_percent >= 0 ? 'text-emerald-700' : 'text-red-700'}>
                            {formatNumber(c.profit_percent, 1)}%
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function SortHead({
  label,
  col,
  sortBy,
  sortDir,
  onClick,
  align = 'left',
}: {
  label: string
  col: string
  sortBy: string
  sortDir: 'asc' | 'desc'
  onClick: (col: any) => void
  align?: 'left' | 'right'
}) {
  const isActive = sortBy === col
  return (
    <TableHead
      className={`cursor-pointer select-none ${align === 'right' ? 'text-right' : ''} ${isActive ? 'text-primary' : ''}`}
      onClick={() => onClick(col)}
    >
      {label}
      {isActive && (sortDir === 'asc' ? ' ▲' : ' ▼')}
    </TableHead>
  )
}

function StatCard({
  icon,
  label,
  value,
  subtext,
  variant = 'default',
}: {
  icon: React.ReactNode
  label: string
  value: string
  subtext?: string
  variant?: 'default' | 'success' | 'danger' | 'info'
}) {
  const styles = {
    default: 'border-border bg-card',
    success: 'border-emerald-200 bg-emerald-50',
    danger: 'border-red-200 bg-red-50',
    info: 'border-sky-200 bg-sky-50',
  }[variant]
  return (
    <div className={`rounded-md border p-3 ${styles}`}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      </div>
      <div className="mt-1 text-base font-bold lg:text-lg">{value}</div>
      {subtext && <div className="text-[10px] text-muted-foreground">{subtext}</div>}
    </div>
  )
}

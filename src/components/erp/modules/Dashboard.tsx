'use client'

import { useMemo } from 'react'
import { useSales, usePurchases, useCollections, useDues } from '@/lib/hooks/use-erp'
import { formatINR, formatNumber, formatDate, todayISO } from '@/lib/utils/format'
import { StatCard } from '@/components/erp/StatCard'
import { PageHeader } from '@/components/erp/EmptyState'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Banknote,
  ShoppingCart,
  TrendingUp,
  Wallet,
  AlertTriangle,
  ArrowRight,
  Receipt,
  Truck,
} from 'lucide-react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  LineChart,
  Line,
} from 'recharts'
import type { ModuleKey } from '@/app/page'

interface Props {
  onNavigate: (k: ModuleKey) => void
}

export function Dashboard({ onNavigate }: Props) {
  const sales = useSales()
  const purchases = usePurchases()
  const collections = useCollections()
  const dues = useDues()

  const today = todayISO()

  const stats = useMemo(() => {
    const todaySales = (sales ?? []).filter((s) => s.date === today)
    const todayPurchases = (purchases ?? []).filter((p) => p.date === today)
    const todayCollections = (collections ?? []).filter((c) => c.date === today)

    const totalSalesToday = todaySales.reduce((s, x) => s + x.total_amount, 0)
    const totalPurchasesToday = todayPurchases.reduce((s, x) => s + x.total_amount, 0)
    const grossProfitToday = todaySales.reduce((s, x) => s + (x.total_profit || 0), 0)
    const totalCollectionsToday = todayCollections.reduce((s, c) => s + c.amount, 0)
    const totalDues = (dues ?? []).reduce((s, d) => s + Math.max(0, d.closing_dues), 0)

    return {
      totalSalesToday,
      totalPurchasesToday,
      grossProfitToday,
      totalCollectionsToday,
      totalDues,
      billCount: todaySales.length,
      purchaseCount: todayPurchases.length,
    }
  }, [sales, purchases, collections, dues, today])

  // Last 7-day chart
  const weekData = useMemo(() => {
    const days: { label: string; sales: number; purchases: number; profit: number }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const iso = d.toISOString().slice(0, 10)
      const daySales = (sales ?? []).filter((s) => s.date === iso)
      const dayPurchases = (purchases ?? []).filter((p) => p.date === iso)
      days.push({
        label: d.toLocaleDateString('en-IN', { weekday: 'short' }),
        sales: daySales.reduce((s, x) => s + x.total_amount, 0),
        purchases: dayPurchases.reduce((s, x) => s + x.total_amount, 0),
        profit: daySales.reduce((s, x) => s + (x.total_profit || 0), 0),
      })
    }
    return days
  }, [sales, purchases])

  // Top dues customers
  const topDues = useMemo(() => {
    return (dues ?? [])
      .filter((d) => d.closing_dues > 0)
      .sort((a, b) => b.closing_dues - a.closing_dues)
      .slice(0, 5)
  }, [dues])

  const recentSales = useMemo(() => {
    return (sales ?? []).slice(0, 6)
  }, [sales])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard · Daily Summary"
        description={`Snapshot for ${formatDate(today)} — all data stored locally via IndexedDB.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => onNavigate('billing')}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              <Receipt className="h-3.5 w-3.5" /> New Sale
            </button>
            <button
              onClick={() => onNavigate('purchases')}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
            >
              <Truck className="h-3.5 w-3.5" /> Add Purchase
            </button>
          </div>
        }
      />

      {/* Top stats */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Today's Sales"
          value={formatINR(stats.totalSalesToday)}
          hint={`${stats.billCount} bills · ${formatDate(today)}`}
          variant="info"
          icon={<ShoppingCart className="h-5 w-5" />}
        />
        <StatCard
          label="Today's Purchases"
          value={formatINR(stats.totalPurchasesToday)}
          hint={`${stats.purchaseCount} entries`}
          variant="default"
          icon={<Truck className="h-5 w-5" />}
        />
        <StatCard
          label="Gross Profit"
          value={formatINR(stats.grossProfitToday)}
          hint="From today's sales"
          variant="success"
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <StatCard
          label="Today's Collections"
          value={formatINR(stats.totalCollectionsToday)}
          hint="Cash & UPI receipts"
          variant="info"
          icon={<Banknote className="h-5 w-5" />}
        />
        <StatCard
          label="Total Market Dues"
          value={formatINR(stats.totalDues)}
          hint="Outstanding across customers"
          variant="danger"
          icon={<AlertTriangle className="h-5 w-5" />}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Sales vs Purchases — Last 7 days</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weekData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} />
                  <Tooltip
                    formatter={(v: number) => formatINR(v)}
                    contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="sales" name="Sales" fill="oklch(0.55 0.13 162)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="purchases" name="Purchases" fill="oklch(0.65 0.18 50)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Profit Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={weekData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} />
                  <Tooltip
                    formatter={(v: number) => formatINR(v)}
                    contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 12 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="profit"
                    name="Profit"
                    stroke="oklch(0.55 0.13 162)"
                    strokeWidth={2.5}
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bottom row: top dues + recent sales */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Top Outstanding Dues</CardTitle>
            <button
              onClick={() => onNavigate('collections')}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </CardHeader>
          <CardContent>
            {topDues.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">
                <Wallet className="h-4 w-4" /> No outstanding dues. Books are clean!
              </div>
            ) : (
              <div className="space-y-2">
                {topDues.map((d) => (
                  <div
                    key={d.customer.id}
                    className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {d.customer.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {d.customer.route_area} · {d.customer.customer_id}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-red-600">
                        {formatINR(d.closing_dues)}
                      </div>
                      <div className="text-xs text-muted-foreground">due</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Recent Sales</CardTitle>
            <button
              onClick={() => onNavigate('sales-ledger')}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              View ledger <ArrowRight className="h-3 w-3" />
            </button>
          </CardHeader>
          <CardContent>
            {recentSales.length === 0 ? (
              <div className="rounded-md bg-muted/40 p-4 text-center text-sm text-muted-foreground">
                No sales recorded yet.
              </div>
            ) : (
              <div className="space-y-2">
                {recentSales.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {s.invoice_no}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {s.customer_name} · {formatDate(s.date)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-foreground">
                        {formatINR(s.total_amount)}
                      </div>
                      <div
                        className={
                          'text-xs ' +
                          (s.payment_mode === 'Cash'
                            ? 'text-emerald-600'
                            : 'text-amber-600')
                        }
                      >
                        {s.payment_mode}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Quick stats:</span>{' '}
        {formatNumber((sales ?? []).length, 0)} total sales ·{' '}
        {formatNumber((purchases ?? []).length, 0)} purchases ·{' '}
        {formatNumber((collections ?? []).length, 0)} collections recorded.
      </div>
    </div>
  )
}

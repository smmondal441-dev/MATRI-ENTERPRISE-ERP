'use client'

import { useState, useMemo } from 'react'
import { useCollections, useDues, useCustomers } from '@/lib/hooks/use-erp'
import {
  CollectionService,
  DuesService,
  type CustomerDues,
} from '@/lib/services/repository'
import {
  formatINR,
  formatDate,
  todayISO,
} from '@/lib/utils/format'
import { PageHeader, EmptyState } from '@/components/erp/EmptyState'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Wallet, Plus, Trash2, Search, AlertTriangle } from 'lucide-react'

export function Collections() {
  const collections = useCollections()
  const dues = useDues()
  const customers = useCustomers()
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [openCustId, setOpenCustId] = useState<number | null>(null)

  // New collection form
  const [date, setDate] = useState(todayISO())
  const [customerId, setCustomerId] = useState('')
  const [amount, setAmount] = useState(0)
  const [paymentMode, setPaymentMode] = useState<'Cash' | 'Cheque' | 'UPI' | 'Bank'>('Cash')
  const [notes, setNotes] = useState('')

  const filteredDues = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = dues ?? []
    if (q) {
      list = list.filter(
        (d) =>
          d.customer.name.toLowerCase().includes(q) ||
          d.customer.customer_id.toLowerCase().includes(q) ||
          d.customer.route_area.toLowerCase().includes(q)
      )
    }
    return list.sort((a, b) => b.closing_dues - a.closing_dues)
  }, [dues, search])

  const totals = useMemo(() => {
    return (dues ?? []).reduce(
      (acc, d) => {
        acc.totalOpening += d.opening_balance
        acc.totalSales += d.credit_sales
        acc.totalCollections += d.collections
        acc.totalClosing += Math.max(0, d.closing_dues)
        return acc
      },
      { totalOpening: 0, totalSales: 0, totalCollections: 0, totalClosing: 0 }
    )
  }, [dues])

  const saveCollection = async () => {
    const cust = (customers ?? []).find((c) => String(c.id) === customerId)
    if (!cust) {
      toast({ title: 'Customer required', variant: 'destructive' })
      return
    }
    if (amount <= 0) {
      toast({ title: 'Invalid amount', variant: 'destructive' })
      return
    }
    await CollectionService.create({
      date,
      customer_id: cust.id!,
      customer_name: cust.name,
      amount,
      payment_mode: paymentMode,
      notes,
    })
    toast({
      title: 'Collection recorded',
      description: `${cust.name} · ${formatINR(amount)} (${paymentMode})`,
    })
    setAmount(0)
    setNotes('')
    setCustomerId('')
    setPaymentMode('Cash')
  }

  const removeCollection = async (id: number) => {
    if (!confirm('Delete this collection record?')) return
    await CollectionService.remove(id)
    toast({ title: 'Collection deleted' })
  }

  const customerCollections = (customerId: number) =>
    (collections ?? []).filter((c) => c.customer_id === customerId)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Collection & Dues"
        description="Record incoming payments, view customer-wise outstanding dues & history."
      />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Opening Dues" value={formatINR(totals.totalOpening)} variant="default" />
        <StatCard label="Credit Sales" value={formatINR(totals.totalSales)} variant="info" />
        <StatCard label="Collected" value={formatINR(totals.totalCollections)} variant="success" />
        <StatCard label="Closing Dues" value={formatINR(totals.totalClosing)} variant="danger" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* New collection form */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Plus className="h-4 w-4" /> Record Collection
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Customer *">
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select customer" />
                </SelectTrigger>
                <SelectContent>
                  {(customers ?? []).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.customer_id} · {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Amount (₹) *">
              <Input
                type="number"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </Field>
            <Field label="Payment Mode">
              <Select value={paymentMode} onValueChange={(v: 'Cash' | 'Cheque' | 'UPI' | 'Bank') => setPaymentMode(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Cash">Cash</SelectItem>
                  <SelectItem value="UPI">UPI</SelectItem>
                  <SelectItem value="Cheque">Cheque</SelectItem>
                  <SelectItem value="Bank">Bank Transfer</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Notes">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Cheque # / UTR" />
            </Field>
            <Button className="w-full" onClick={saveCollection}>
              Save Collection
            </Button>
          </CardContent>
        </Card>

        {/* Customer dues list */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Customer-wise Dues</CardTitle>
            <div className="relative w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search customer..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-9 text-xs"
              />
            </div>
          </CardHeader>
          <CardContent>
            {filteredDues.length === 0 ? (
              <EmptyState
                title="No customers"
                description="Add customers in Customer Master first."
                icon={<Wallet className="h-6 w-6" />}
              />
            ) : (
              <div className="scrollbar-thin max-h-96 overflow-y-auto rounded-md border border-border">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead>Customer</TableHead>
                      <TableHead className="text-right">Opening</TableHead>
                      <TableHead className="text-right">Credit Sales</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Closing</TableHead>
                      <TableHead className="text-right">History</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDues.map((d) => (
                      <TableRow key={d.customer.id}>
                        <TableCell>
                          <div className="text-sm font-medium">{d.customer.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {d.customer.customer_id} · {d.customer.route_area}
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-xs">{formatINR(d.opening_balance)}</TableCell>
                        <TableCell className="text-right text-xs">{formatINR(d.credit_sales)}</TableCell>
                        <TableCell className="text-right text-xs text-emerald-600">{formatINR(d.collections)}</TableCell>
                        <TableCell className="text-right text-xs">
                          <span
                            className={
                              d.closing_dues > 0
                                ? 'font-semibold text-red-600'
                                : 'text-emerald-600'
                            }
                          >
                            {formatINR(d.closing_dues)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setOpenCustId(d.customer.id!)}
                          >
                            View
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent collections */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">All Collections</CardTitle>
        </CardHeader>
        <CardContent>
          {(collections ?? []).length === 0 ? (
            <EmptyState
              title="No collections yet"
              description="Record your first payment receipt above."
              icon={<Wallet className="h-6 w-6" />}
            />
          ) : (
            <div className="scrollbar-thin max-h-96 overflow-y-auto rounded-md border border-border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(collections ?? []).slice(0, 200).map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="text-xs">{formatDate(c.date)}</TableCell>
                      <TableCell className="text-sm">{c.customer_name}</TableCell>
                      <TableCell>
                        <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px]">
                          {c.payment_mode}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{c.notes || '—'}</TableCell>
                      <TableCell className="text-right text-sm font-semibold text-emerald-600">
                        {formatINR(c.amount)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => removeCollection(c.id!)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* History modal */}
      {openCustId && (
        <CustomerHistory
          customerId={openCustId}
          collections={customerCollections(openCustId)}
          dues={dues?.find((d) => d.customer.id === openCustId)}
          onClose={() => setOpenCustId(null)}
        />
      )}
    </div>
  )
}

function CustomerHistory({
  customerId,
  collections,
  dues,
  onClose,
}: {
  customerId: number
  collections: ReturnType<typeof useCollections>
  dues: CustomerDues | undefined
  onClose: () => void
}) {
  return (
    <div className="no-print fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-lg bg-card p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">{dues?.customer.name}</h3>
            <p className="text-xs text-muted-foreground">
              {dues?.customer.customer_id} · {dues?.customer.route_area}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            ✕
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Mini label="Opening" value={formatINR(dues?.opening_balance ?? 0)} />
          <Mini label="Credit Sales" value={formatINR(dues?.credit_sales ?? 0)} />
          <Mini label="Collected" value={formatINR(dues?.collections ?? 0)} />
          <Mini
            label="Closing Dues"
            value={formatINR(dues?.closing_dues ?? 0)}
            highlight={dues && dues.closing_dues > 0 ? 'danger' : 'success'}
          />
        </div>
        <div className="mt-4 scrollbar-thin max-h-80 overflow-y-auto rounded-md border border-border">
          {collections && collections.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {collections.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-xs">{formatDate(c.date)}</TableCell>
                    <TableCell className="text-xs">{c.payment_mode}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.notes || '—'}</TableCell>
                    <TableCell className="text-right text-xs font-semibold text-emerald-600">
                      {formatINR(c.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <AlertTriangle className="mx-auto mb-2 h-6 w-6 opacity-40" />
              No collection history for this customer yet.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <Label className="mb-1 block text-xs font-medium text-foreground">{label}</Label>
      {children}
    </div>
  )
}

function StatCard({
  label,
  value,
  variant,
}: {
  label: string
  value: string
  variant: 'default' | 'success' | 'danger' | 'info'
}) {
  const styles = {
    default: 'border-border bg-card',
    success: 'border-emerald-200 bg-emerald-50',
    danger: 'border-red-200 bg-red-50',
    info: 'border-sky-200 bg-sky-50',
  }[variant]
  return (
    <div className={`rounded-md border p-3 ${styles}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-base font-semibold lg:text-lg">{value}</div>
    </div>
  )
}

function Mini({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: 'danger' | 'success'
}) {
  const c =
    highlight === 'danger'
      ? 'border-red-200 bg-red-50 text-red-700'
      : highlight === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : 'border-border bg-muted/40'
  return (
    <div className={`rounded-md border p-2 ${c}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  )
}

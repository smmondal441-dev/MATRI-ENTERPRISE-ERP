'use client'

import { useState, useMemo, useEffect } from 'react'
import {
  useCollections,
  useDues,
  useCustomers,
  useBillDues,
} from '@/lib/hooks/use-erp'
import {
  CollectionService,
  DuesService,
  type CustomerDues,
  type BillDue,
  type BillAllocation,
} from '@/lib/services/repository'
import {
  formatINR,
  formatDate,
  todayISO,
} from '@/lib/utils/format'
import type { Customer } from '@/lib/db/dexie'
import { PageHeader, EmptyState } from '@/components/erp/EmptyState'
import { Combobox } from '@/components/erp/Combobox'
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
import {
  Wallet,
  Plus,
  Trash2,
  Search,
  AlertTriangle,
  Wand2,
  FileText,
} from 'lucide-react'

export function Collections() {
  const collections = useCollections()
  const dues = useDues()
  const customers = useCustomers()
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  // Separate search input for the "All Collections" table — filters by
  // Customer Name, Payment Mode, Against Bills (invoice no), or Notes.
  // Independent from the customer-wise dues search above.
  const [collectionsSearch, setCollectionsSearch] = useState('')
  const [openCustId, setOpenCustId] = useState<number | null>(null)

  // New collection form
  const [date, setDate] = useState(todayISO())
  const [customerId, setCustomerId] = useState('')
  const [amount, setAmount] = useState(0)
  const [paymentMode, setPaymentMode] = useState<'Cash' | 'Cheque' | 'UPI' | 'Bank'>('Cash')
  const [notes, setNotes] = useState('')

  // Bill-by-bill allocation state (Tally-style "Against Reference").
  // Keyed by String(sale.id) for ID-safe lookups. Value = amount to allocate
  // against that invoice from this collection receipt.
  const [allocations, setAllocations] = useState<Record<string, number>>({})

  // Bill dues for the currently-selected customer (live query — re-runs
  // whenever sales or collections tables change in IndexedDB).
  const selectedCustIdNum = customerId
    ? (customers ?? []).find((c) => String(c.id) === customerId)?.id ?? null
    : null
  const billDues = useBillDues(selectedCustIdNum)

  // Reset allocations when the customer changes — old customer's bills
  // don't apply to the new one, and stale allocations would be misleading.
  useEffect(() => {
    setAllocations({})
  }, [customerId])

  // ---- Allocation math (live) ----
  // Sum of allocations the user has typed in. Used to show the remaining
  // "on-account" (unallocated) portion and to validate before save.
  const allocatedTotal = useMemo(() => {
    return Object.values(allocations).reduce(
      (s, v) => s + (Number(v) || 0),
      0
    )
  }, [allocations])

  const unallocated = Math.max(0, amount - allocatedTotal)
  const overAllocated = allocatedTotal > amount + 0.001 // float epsilon

  // ---- Auto-allocate FIFO helper ----
  // Fills allocations oldest-bill-first until `amount` is exhausted. Uses
  // net_payable (total - paid - damage_adjustment) so damage-adjusted bills
  // get the correct reduced allocation (Task 2 — damage-aware collection).
  const autoAllocateFifo = () => {
    if (!billDues || billDues.length === 0) {
      toast({
        title: 'No outstanding bills',
        description: 'This customer has no open credit bills to allocate.',
      })
      return
    }
    let remaining = amount
    const next: Record<string, number> = {}
    // billDues is sorted by sale.date ascending via the service (oldest first)
    for (const b of billDues) {
      if (remaining <= 0) break
      const sid = String(b.sale.id)
      // Task 2 — allocate against net_payable (after damage deduction),
      // NOT remaining_due (which doesn't subtract damage).
      const give = Math.min(remaining, b.net_payable)
      if (give > 0) {
        next[sid] = Number(give.toFixed(2))
        remaining -= give
      }
    }
    setAllocations(next)
    toast({
      title: 'Auto-allocated (FIFO)',
      description: `₹${formatINR(amount - remaining)} split across ${
        Object.keys(next).length
      } bill(s).`,
    })
  }

  // ---- Clear allocations ----
  const clearAllocations = () => setAllocations({})

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
    // Block save if allocations exceed the collection amount (over-allocation).
    if (overAllocated) {
      toast({
        title: 'Over-allocated',
        description: `Allocated ${formatINR(allocatedTotal)} exceeds collection amount ${formatINR(amount)}.`,
        variant: 'destructive',
      })
      return
    }
    // Build the bill_allocations array. Filter out zero entries so we don't
    // persist noise. Snapshots invoice_no from the live billDues lookup so
    // the allocation survives even if the sale is later deleted.
    const billAllocations: BillAllocation[] = billDues
      ? Object.entries(allocations)
          .filter(([, v]) => Number(v) > 0)
          .map(([sid, v]) => {
            const due = billDues.find(
              (b) => String(b.sale.id) === String(sid)
            )
            return {
              sale_id: Number(sid),
              invoice_no: due?.invoice_no ?? '',
              amount: Number(Number(v).toFixed(2)),
            }
          })
      : []
    await CollectionService.create({
      date,
      customer_id: cust.id!,
      customer_name: cust.name,
      amount,
      payment_mode: paymentMode,
      notes,
      // Empty array → stored as null on the server (lump-sum). Non-empty
      // → JSON-stringified by the push route and round-tripped on pull.
      bill_allocations:
        billAllocations.length > 0 ? billAllocations : undefined,
    })
    toast({
      title: 'Collection recorded',
      description:
        billAllocations.length > 0
          ? `${cust.name} · ${formatINR(amount)} (${paymentMode}) — ${billAllocations.length} bill(s) adjusted`
          : `${cust.name} · ${formatINR(amount)} (${paymentMode})`,
    })
    setAmount(0)
    setNotes('')
    setCustomerId('')
    setPaymentMode('Cash')
    setAllocations({})
  }

  const removeCollection = async (id: number) => {
    if (!confirm('Delete this collection record?')) return
    await CollectionService.remove(id)
    toast({ title: 'Collection deleted' })
  }

  const customerCollections = (customerId: number) =>
    (collections ?? []).filter(
      (c) => String(c.customer_id) === String(customerId)
    )

  // ---- All Collections: search filter + strict date-desc sorting ----
  // Filter: matches Customer Name, Payment Mode, Against Bills (invoice_no),
  //         or Notes (case-insensitive substring match).
  // Sort:   STRICT by `date` field descending (newest first).
  //         Backdated entries (e.g. a 5 Nov entry created on 19 Nov) must
  //         appear in the 5 Nov position, NOT at the top. The `id` (Dexie
  //         auto-increment, which is monotonic with creation order) is used
  //         ONLY as a tie-breaker when two entries share the exact same date.
  const sortedFilteredCollections = useMemo(() => {
    const q = collectionsSearch.trim().toLowerCase()
    let list = collections ?? []
    if (q) {
      list = list.filter((c) => {
        const name = (c.customer_name ?? '').toLowerCase()
        const mode = (c.payment_mode ?? '').toLowerCase()
        const notes = (c.notes ?? '').toLowerCase()
        // Against Bills — search across every allocation's invoice_no
        const bills = (c.bill_allocations ?? [])
          .map((a) => (a.invoice_no ?? '').toLowerCase())
          .join(' ')
        return (
          name.includes(q) ||
          mode.includes(q) ||
          notes.includes(q) ||
          bills.includes(q)
        )
      })
    }
    // Defensive date normalization: pad YYYY-M-D → YYYY-MM-DD so string
    // comparison matches chronological order. Falls back to '' on invalid input.
    const norm = (d: string | undefined): string => {
      if (!d) return ''
      const s = String(d).slice(0, 10)
      const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
      if (!m) return s
      return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
    }
    return [...list].sort((a, b) => {
      const da = norm(a.date)
      const db = norm(b.date)
      if (da !== db) return db.localeCompare(da) // date DESC (newest first)
      // Same date → tie-break by id DESC (most recently created first).
      // `id` is the Dexie auto-increment, monotonic with insertion order.
      return (b.id ?? 0) - (a.id ?? 0)
    })
  }, [collections, collectionsSearch])

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
              <Combobox<Customer>
                items={customers ?? []}
                value={customerId}
                onValueChange={setCustomerId}
                getItemValue={(c) => String(c.id)}
                getItemLabel={(c) => `${c.customer_id} · ${c.name}`}
                filterFn={(c, q) =>
                  c.name.toLowerCase().includes(q) ||
                  c.customer_id.toLowerCase().includes(q) ||
                  c.route_area.toLowerCase().includes(q) ||
                  (c.phone || '').toLowerCase().includes(q)
                }

                searchPlaceholder="Search customer..."
                emptyText="No customer matches your search."
                renderItem={(c) => {
                  const due = (dues ?? []).find(
                    (d) => String(d.customer.id) === String(c.id)
                  )
                  const closing = due?.closing_dues ?? 0
                  return (
                    <div className="flex w-full items-center justify-between gap-2 leading-tight">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{c.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {c.customer_id} · {c.route_area}
                          {c.phone ? ` · ${c.phone}` : ''}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-[11px]">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Closing Due
                        </div>
                        <div
                          className={
                            closing > 0
                              ? 'font-semibold text-red-600'
                              : 'font-semibold text-emerald-600'
                          }
                        >
                          {formatINR(closing)}
                        </div>
                      </div>
                    </div>
                  )
                }}
              />
            </Field>

            {/* ---- Bill-by-bill allocation (Tally-style "Against Reference") ---- */}
            {customerId && (
              <BillAllocationTable
                billDues={billDues}
                amount={amount}
                allocations={allocations}
                setAllocations={setAllocations}
                allocatedTotal={allocatedTotal}
                unallocated={unallocated}
                overAllocated={overAllocated}
                onAutoFifo={autoAllocateFifo}
                onClear={clearAllocations}
              />
            )}

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
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
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
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">All Collections</CardTitle>
          {/* Search filter — filters by Customer Name, Payment Mode,
              Against Bills (invoice no), or Notes. Sorted strictly by
              collection `date` descending (newest first); id breaks ties. */}
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={collectionsSearch}
              onChange={(e) => setCollectionsSearch(e.target.value)}
              placeholder="Search by customer, mode, bill, notes..."
              className="h-8 pl-9 text-xs"
            />
          </div>
        </CardHeader>
        <CardContent>
          {sortedFilteredCollections.length === 0 ? (
            <EmptyState
              title={collectionsSearch.trim() ? 'No matches' : 'No collections yet'}
              description={
                collectionsSearch.trim()
                  ? 'No collections match your search. Try a different keyword.'
                  : 'Record your first payment receipt above.'
              }
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
                    <TableHead>Against Bills</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedFilteredCollections.slice(0, 200).map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="text-xs">{formatDate(c.date)}</TableCell>
                      <TableCell className="text-sm">{c.customer_name}</TableCell>
                      <TableCell>
                        <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px]">
                          {c.payment_mode}
                        </span>
                      </TableCell>
                      {/* Against Bills — shows the invoice numbers this collection
                          was allocated to. Lump-sum collections show "—". */}
                      <TableCell className="text-xs">
                        {c.bill_allocations && c.bill_allocations.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {c.bill_allocations.map((a, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[10px] text-blue-700"
                                title={`${formatINR(a.amount)} against ${a.invoice_no}`}
                              >
                                <FileText className="h-2.5 w-2.5" />
                                {a.invoice_no}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
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
          dues={dues?.find(
            (d) => String(d.customer.id) === String(openCustId)
          )}
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

// ----------------------------------------------------------------------------
// BillAllocationTable — Tally-style "Against Reference" allocation editor
// ----------------------------------------------------------------------------
// Shown inside the Record Collection form when a customer is selected.
// Renders the customer's outstanding credit bills (oldest first) with a
// per-bill "Allocate ₹" input. Live-validates that the sum of allocations
// does not exceed the collection `amount`.
//
// Props:
//   billDues         : the customer's outstanding BillDue[] (from useBillDues)
//   amount           : the collection receipt total (top-level form state)
//   allocations      : Record<String(sale.id), allocatedAmount>
//   setAllocations   : setter for the allocations record
//   allocatedTotal   : sum of all allocations (live)
//   unallocated      : amount - allocatedTotal (≥ 0; the "on-account" portion)
//   overAllocated    : boolean — allocations exceed amount
//   onAutoFifo       : fills allocations oldest-first until amount is exhausted
//   onClear          : clears all allocations
// ----------------------------------------------------------------------------
function BillAllocationTable({
  billDues,
  amount,
  allocations,
  setAllocations,
  allocatedTotal,
  unallocated,
  overAllocated,
  onAutoFifo,
  onClear,
}: {
  billDues: BillDue[] | undefined
  amount: number
  allocations: Record<string, number>
  setAllocations: React.Dispatch<React.SetStateAction<Record<string, number>>>
  allocatedTotal: number
  unallocated: number
  overAllocated: boolean
  onAutoFifo: () => void
  onClear: () => void
}) {
  // Loading state — billDues is undefined while the live query is in flight.
  if (billDues === undefined) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
        <div className="mx-auto h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span className="mt-1 inline-block">Loading outstanding bills...</span>
      </div>
    )
  }

  // No outstanding bills — customer is fully settled or has only cash sales.
  if (billDues.length === 0) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
        <FileText className="mr-1 inline h-3.5 w-3.5" />
        No outstanding credit bills for this customer. The collection will be
        recorded as <strong>on-account</strong> (lump-sum credit).
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border">
      {/* Header row with title + actions */}
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-2">
        <div>
          <div className="text-xs font-semibold">Against Bills (Reference)</div>
          <div className="text-[10px] text-muted-foreground">
            Allocate this receipt across specific invoices — Tally-style.
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={onAutoFifo}
            disabled={amount <= 0}
            title="Auto-fill oldest bills first until amount is exhausted"
          >
            <Wand2 className="mr-1 h-3 w-3" />
            Auto FIFO
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={onClear}
            disabled={Object.keys(allocations).length === 0}
          >
            Clear
          </Button>
        </div>
      </div>

      {/* Bills table */}
      <div className="scrollbar-thin max-h-56 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead className="text-[10px]">Invoice</TableHead>
              <TableHead className="text-[10px]">Date</TableHead>
              <TableHead className="text-right text-[10px]">Total</TableHead>
              <TableHead className="text-right text-[10px]">Paid</TableHead>
              {/* Task 2 — Damage adjustment column */}
              <TableHead className="text-right text-[10px]">Damage Adj.</TableHead>
              {/* Task 2 — Net Payable = Total - Paid - Damage (the amount to allocate) */}
              <TableHead className="text-right text-[10px]">Net Payable</TableHead>
              <TableHead className="text-right text-[10px]">Paying Now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {billDues.map((b) => {
              const sid = String(b.sale.id)
              const alloc = allocations[sid] ?? 0
              // Task 2 — validation now uses net_payable (after damage deduction).
              const remainingAfter = b.net_payable - alloc
              const overBill = alloc > b.net_payable + 0.001
              return (
                <TableRow key={sid}>
                  <TableCell className="font-mono text-[10px] font-semibold">
                    {b.invoice_no}
                  </TableCell>
                  <TableCell className="text-[10px] text-muted-foreground">
                    {formatDate(b.sale.date)}
                  </TableCell>
                  <TableCell className="text-right text-[10px]">
                    {formatINR(b.total_amount)}
                  </TableCell>
                  <TableCell className="text-right text-[10px] text-emerald-700">
                    {b.paid_amount > 0 ? formatINR(b.paid_amount) : '—'}
                  </TableCell>
                  {/* Task 2 — Damage adjustment (red, shown only if > 0) */}
                  <TableCell className="text-right text-[10px]">
                    {b.damage_amount > 0 ? (
                      <span className="font-semibold text-red-600">
                        −{formatINR(b.damage_amount)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  {/* Task 2 — Net Payable (the headline number for allocation) */}
                  <TableCell className="text-right text-[10px]">
                    <span
                      className={
                        b.net_payable > 0
                          ? 'font-semibold text-blue-700'
                          : 'text-emerald-600'
                      }
                      title="Total − Paid − Damage Adjustment"
                    >
                      {formatINR(b.net_payable)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={alloc || ''}

                      onChange={(e) => {
                        const v = Number(e.target.value) || 0
                        setAllocations((prev) => {
                          const next = { ...prev }
                          if (v <= 0) {
                            delete next[sid]
                          } else {
                            next[sid] = v
                          }
                          return next
                        })
                      }}
                      className={`h-7 w-24 text-right text-[11px] ${
                        overBill ? 'border-red-500 text-red-700' : ''
                      }`}
                      title={
                        overBill
                          ? `Exceeds net payable of ${formatINR(b.net_payable)}`
                          : `Remaining after allocation: ${formatINR(Math.max(0, remainingAfter))}`
                      }
                    />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* Footer — allocation summary */}
      <div
        className={`flex items-center justify-between gap-2 border-t px-3 py-2 text-[11px] ${
          overAllocated
            ? 'border-red-300 bg-red-50'
            : unallocated > 0.001
            ? 'border-amber-300 bg-amber-50'
            : 'border-emerald-300 bg-emerald-50'
        }`}
      >
        <div className="flex flex-wrap gap-3">
          <span>
            <strong>Allocated:</strong> {formatINR(allocatedTotal)}
          </span>
          <span>
            <strong>Unallocated (on-account):</strong>{' '}
            <span className={overAllocated ? 'text-red-700' : 'text-amber-800'}>
              {formatINR(unallocated)}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {overAllocated ? (
            <span className="font-semibold text-red-700">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              Over by {formatINR(allocatedTotal - amount)}
            </span>
          ) : Math.abs(allocatedTotal - amount) < 0.001 && amount > 0 ? (
            <span className="font-semibold text-emerald-700">
              Fully allocated ✓
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

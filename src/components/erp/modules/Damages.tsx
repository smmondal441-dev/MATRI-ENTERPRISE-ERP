'use client'

import { useState, useMemo } from 'react'
import {
  useProducts,
  useDamages,
  useDamageTotals,
  useCustomers,
  useBillDues,
} from '@/lib/hooks/use-erp'
import { DamageService, getPurchaseRatePerPiece, type BillDue } from '@/lib/services/repository'
import {
  formatINR,
  formatNumber,
  formatDate,
  todayISO,
  downloadCSV,
} from '@/lib/utils/format'
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
  AlertTriangle,
  Trash2,
  Plus,
  RotateCcw,
  Download,
  Skull,
} from 'lucide-react'
import type { DamageReason, DamageSource, Product, Customer } from '@/lib/db/dexie'

const REASONS: DamageReason[] = ['Broken', 'Expired', 'Leaked', 'Pilferage', 'Quality']

const REASON_BADGE: Record<DamageReason, string> = {
  Broken: 'bg-amber-100 text-amber-700',
  Expired: 'bg-red-100 text-red-700',
  Leaked: 'bg-orange-100 text-orange-700',
  Pilferage: 'bg-purple-100 text-purple-700',
  Quality: 'bg-rose-100 text-rose-700',
}

export function Damages() {
  const products = useProducts()
  const damages = useDamages()
  const totals = useDamageTotals()
  const customers = useCustomers()
  const { toast } = useToast()

  const [date, setDate] = useState(todayISO())
  const [productId, setProductId] = useState('')
  const [bagQty, setBagQty] = useState(0)
  const [pcsQty, setPcsQty] = useState(0)
  const [reason, setReason] = useState<DamageReason>('Broken')
  const [notes, setNotes] = useState('')
  // Upgrade 3 — Damage Source: 'godown' (default) or 'store'
  const [damageSource, setDamageSource] = useState<DamageSource>('godown')
  // Optional customer reference for store-damages only
  const [customerId, setCustomerId] = useState('')
  // Task 2 — Bill-wise damage allocation. When source = 'store' AND the user
  // attributes the damage to a specific bill, saleId holds the sale_id.
  // Empty string = unattributed (no bill deduction).
  const [saleId, setSaleId] = useState('')

  const selectedProduct = useMemo(
    () => (products ?? []).find((p) => String(p.id) === productId),
    [products, productId]
  )
  // Lookup the customer when damageSource = 'store' so we can save its name
  // alongside the id for fast display in the log.
  const selectedCustomer = useMemo(
    () =>
      damageSource === 'store'
        ? (customers ?? []).find((c) => String(c.id) === customerId)
        : undefined,
    [customers, customerId, damageSource]
  )
  // Task 2 — Load the selected customer's outstanding credit bills so the
  // user can attribute the damage to a specific invoice (Tally-style).
  // Only fetched when source = 'store' AND a customer is picked.
  const selectedCustIdNum = damageSource === 'store' && customerId
    ? (customers ?? []).find((c) => String(c.id) === customerId)?.id ?? null
    : null
  const billDues = useBillDues(selectedCustIdNum)
  // Resolve the selected bill's invoice_no for snapshotting on save.
  const selectedBill = useMemo(
    () =>
      saleId && billDues
        ? billDues.find((b) => String(b.sale.id) === saleId)
        : undefined,
    [saleId, billDues]
  )

  const conversion = selectedProduct?.conversion_factor ?? 1
  const totalPcs = bagQty * conversion + pcsQty
  const perPiece = selectedProduct ? getPurchaseRatePerPiece(selectedProduct) : 0
  const expenseValue = perPiece * totalPcs

  const resetForm = () => {
    setDate(todayISO())
    setProductId('')
    setBagQty(0)
    setPcsQty(0)
    setReason('Broken')
    setNotes('')
    setDamageSource('godown')
    setCustomerId('')
    setSaleId('')
  }

  const save = async () => {
    if (!selectedProduct) {
      toast({
        title: 'Product required',
        description: 'Select a damaged product.',
        variant: 'destructive',
      })
      return
    }
    if (totalPcs <= 0) {
      toast({
        title: 'Invalid quantity',
        description: 'Enter bag or pcs qty > 0.',
        variant: 'destructive',
      })
      return
    }
    // Upgrade 3 — only enforce the stock-safety check for godown damages.
    // Store damages don't deduct sellable stock, so the check is meaningless.
    if (damageSource === 'godown' && totalPcs > selectedProduct.opening_stock_pcs) {
      if (
        !confirm(
          `Damaged qty (${totalPcs} Pcs) exceeds current sellable stock (${selectedProduct.opening_stock_pcs} Pcs). Continue anyway?`
        )
      ) {
        return
      }
    }
    // Upgrade 3 — if source = 'store', a customer must be selected.
    if (damageSource === 'store' && !selectedCustomer) {
      toast({
        title: 'Customer required',
        description: 'Select the store / customer who returned the damaged goods.',
        variant: 'destructive',
      })
      return
    }
    try {
      await DamageService.create({
        date,
        product_id: selectedProduct.id!,
        product_sku: selectedProduct.sku,
        product_name: selectedProduct.name,
        hsn_code: selectedProduct.hsn_code,
        bag_qty: bagQty,
        pcs_qty: pcsQty,
        total_pcs: totalPcs,
        reason,
        notes,
        expense_value: expenseValue,
        // Upgrade 3 fields:
        damage_source: damageSource,
        customer_id: damageSource === 'store' ? selectedCustomer!.id! : undefined,
        customer_name: damageSource === 'store' ? selectedCustomer!.name : undefined,
        // Task 2 — Bill-wise damage allocation fields. Only persisted when
        // source = 'store' AND the user picked a bill.
        sale_id:
          damageSource === 'store' && saleId
            ? Number(saleId)
            : undefined,
        against_invoice_no:
          damageSource === 'store' && saleId
            ? selectedBill?.invoice_no ?? ''
            : undefined,
      })
      toast({
        title: 'Damage recorded',
        description:
          damageSource === 'godown'
            ? `${selectedProduct.name} · ${formatNumber(totalPcs, 0)} Pcs · ${reason} · Sellable stock −${formatNumber(totalPcs, 0)} Pcs`
            : `${selectedProduct.name} · ${formatNumber(totalPcs, 0)} Pcs · ${reason} · Store-damage (no sellable stock change). Customer: ${selectedCustomer!.name}`,
      })
      resetForm()
    } catch (e) {
      toast({ title: 'Save failed', description: String(e), variant: 'destructive' })
    }
  }

  const remove = async (id: number, productName: string, source?: DamageSource) => {
    const isGodown = source !== 'store'
    const msg = isGodown
      ? `Delete damage entry for "${productName}"? Sellable stock will be restored.`
      : `Delete store-damage entry for "${productName}"? Sellable stock is NOT affected (was a store return damage).`
    if (!confirm(msg)) return
    await DamageService.remove(id)
    toast({
      title: 'Damage deleted',
      description: isGodown ? 'Sellable stock restored.' : 'Store-damage record removed.',
    })
  }

  const exportCsv = () => {
    const rows: (string | number)[][] = [
      ['Date', 'Product SKU', 'Product Name', 'HSN', 'Bag Qty', 'Pcs Qty', 'Total Pcs', 'Reason', 'Notes', 'Expense Value (₹)'],
      ...(damages ?? []).map((d) => [
        d.date,
        d.product_sku,
        d.product_name,
        d.hsn_code,
        d.bag_qty,
        d.pcs_qty,
        d.total_pcs,
        d.reason,
        d.notes || '',
        d.expense_value.toFixed(2),
      ]),
      [],
      ['TOTAL EXPENSE', '', '', '', '', '', totals?.totalPcs ?? 0, '', '', (totals?.totalExpense ?? 0).toFixed(2)],
    ]
    downloadCSV(`damages-${todayISO()}`, rows)
    toast({ title: 'CSV downloaded' })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Damage & Stock Adjustment"
        description="Record damaged/expired/leaked items. Stock is auto-deducted and the cost value is logged as an adjustment expense."
        actions={
          <Button variant="outline" onClick={exportCsv}>
            <Download className="mr-1 h-4 w-4" /> Export CSV
          </Button>
        }
      />

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total Entries" value={String(totals?.count ?? 0)} />
        <StatCard label="Pcs Damaged" value={formatNumber(totals?.totalPcs ?? 0, 0)} variant="warning" />
        <StatCard label="Total Expense" value={formatINR(totals?.totalExpense ?? 0)} variant="danger" />
        <StatCard label="Avg / Entry" value={formatINR((totals?.totalExpense ?? 0) / Math.max(1, totals?.count ?? 1))} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Entry form */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Plus className="h-4 w-4" /> Record Damage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Product *">
              <Combobox<Product>
                items={products ?? []}
                value={productId}
                onValueChange={setProductId}
                getItemValue={(p) => String(p.id)}
                getItemLabel={(p) =>
                  `${p.sku} · ${p.name} (Stock: ${formatNumber(p.opening_stock_pcs, 0)} Pcs)`
                }
                filterFn={(p, q) =>
                  p.name.toLowerCase().includes(q) ||
                  p.sku.toLowerCase().includes(q) ||
                  p.company_name.toLowerCase().includes(q) ||
                  p.hsn_code.toLowerCase().includes(q)
                }

                searchPlaceholder="Search product..."
                emptyText="No product matches your search."
                renderItem={(p) => (
                  <div className="flex w-full items-center justify-between gap-2 leading-tight">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{p.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {p.sku} · {p.company_name}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[11px]">
                      <span
                        className={
                          p.opening_stock_pcs > 0
                            ? 'font-semibold text-emerald-700'
                            : 'font-semibold text-red-600'
                        }
                      >
                        Stock: {formatNumber(p.opening_stock_pcs, 0)} {p.base_unit}
                      </span>
                    </div>
                  </div>
                )}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              {/* Loose products: hide Bag Qty, show single Qty input */}
              {selectedProduct?.is_loose ? (
                <Field label={`Qty (${selectedProduct.base_unit})`}>
                  <Input
                    type="number"
                    min={0}
                    step="0.001"
                    value={pcsQty}
                    onChange={(e) => {
                      setPcsQty(Number(e.target.value))
                      setBagQty(0)
                    }}
                  />
                </Field>
              ) : (
                <>
                  <Field label={`Bag Qty (1 Bag = ${conversion} Pcs)`}>
                    <Input
                      type="number"
                      min={0}
                      value={bagQty}
                      onChange={(e) => setBagQty(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Extra Pcs">
                    <Input
                      type="number"
                      min={0}
                      value={pcsQty}
                      onChange={(e) => setPcsQty(Number(e.target.value))}
                    />
                  </Field>
                </>
              )}
            </div>
            <Field label="Reason">
              <Select value={reason} onValueChange={(v: DamageReason) => setReason(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Notes (optional)">
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}

              />
            </Field>

            {/* Upgrade 3 — Damage Source toggle */}
            <Field label="Damage Source">
              <Select
                value={damageSource}
                onValueChange={(v: DamageSource) => {
                  setDamageSource(v)
                  // Clear customer when switching back to godown
                  if (v !== 'store') setCustomerId('')
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="godown">
                    Godown / Internal Damage
                  </SelectItem>
                  <SelectItem value="store">
                    Store / Market Return Damage
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                {damageSource === 'godown'
                  ? 'Deducts from sellable godown stock. Use for in-warehouse damage.'
                  : 'Does NOT touch sellable stock. Tracked separately as Damaged Stock (Store). Use for store-returned damaged goods.'}
              </p>
            </Field>

            {/* Upgrade 3 — customer picker visible only for store-damages */}
            {damageSource === 'store' && (
              <Field label="Customer / Store *">
                <Combobox<Customer>
                  items={customers ?? []}
                  value={customerId}
                  onValueChange={(v) => {
                    setCustomerId(v)
                    // Clear the bill selection when the customer changes —
                    // old customer's bills don't apply to the new one.
                    setSaleId('')
                  }}
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
                  renderItem={(c) => (
                    <div className="flex flex-col leading-tight">
                      <span className="font-medium">{c.name}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {c.customer_id} · {c.route_area}
                      </span>
                    </div>
                  )}
                />
              </Field>
            )}

            {/* Task 2 — Against Bill picker. Visible only for store-damages
                when a customer is selected AND that customer has outstanding
                credit bills. Lets the user attribute the damage to a specific
                invoice so it gets deducted from that bill's Net Payable in the
                Collection screen (Tally-style adjustment). */}
            {damageSource === 'store' && customerId && billDues && billDues.length > 0 && (
              <Field label="Against Bill (optional — deduct from invoice)">
                <Combobox<BillDue>
                  items={billDues}
                  value={saleId}
                  onValueChange={setSaleId}
                  getItemValue={(b) => String(b.sale.id)}
                  getItemLabel={(b) =>
                    `${b.invoice_no} · Net Payable ${formatINR(b.net_payable)}`
                  }
                  filterFn={(b, q) =>
                    b.invoice_no.toLowerCase().includes(q) ||
                    String(b.sale.date).includes(q)
                  }

                  searchPlaceholder="Search invoice no..."
                  emptyText="No outstanding bills match."
                  renderItem={(b) => (
                    <div className="flex w-full items-center justify-between gap-2 leading-tight">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-xs font-semibold">
                          {b.invoice_no}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {b.sale.date} · Total {formatINR(b.total_amount)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-[11px]">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Net Payable
                        </div>
                        <div className="font-semibold text-red-600">
                          {formatINR(b.net_payable)}
                        </div>
                      </div>
                    </div>
                  )}
                />
                <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                  Selecting a bill deducts this damage's expense value from that
                  invoice's Net Payable in the Collection screen. Leave blank to
                  record as an unattributed store-damage.
                </p>
              </Field>
            )}

            {selectedProduct && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5" /> Adjustment Preview
                </div>
                <div className="mt-1.5 space-y-1">
                  <Row label="Total Damaged Pcs" value={formatNumber(totalPcs, 0)} />
                  <Row label={`Purchase Rate / ${selectedProduct.base_unit}`} value={`₹${perPiece.toFixed(4)}`} />
                  <Row
                    label="Expense Value"
                    value={<strong className="text-red-700">{formatINR(expenseValue)}</strong>}
                  />
                  <div className="border-t border-amber-200 pt-1">
                    {damageSource === 'godown' ? (
                      <Row
                        label="Sellable Stock After Adjustment"
                        value={
                          <span className={selectedProduct.opening_stock_pcs - totalPcs < 0 ? 'text-red-700 font-semibold' : 'font-semibold'}>
                            {formatNumber(Math.max(0, selectedProduct.opening_stock_pcs - totalPcs), 0)} Pcs
                          </span>
                        }
                      />
                    ) : (
                      <Row
                        label="Sellable Stock"
                        value={
                          <span className="font-semibold text-emerald-700">
                            {formatNumber(selectedProduct.opening_stock_pcs, 0)} Pcs · UNCHANGED
                          </span>
                        }
                      />
                    )}
                  </div>
                  {damageSource === 'store' && selectedCustomer && (
                    <Row
                      label="Damaged Stock (Store)"
                      value={<span className="font-semibold text-blue-700">+{formatNumber(totalPcs, 0)} Pcs</span>}
                    />
                  )}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button onClick={save} className="flex-1">
                <Plus className="mr-1 h-4 w-4" /> Record Damage
              </Button>
              <Button variant="outline" onClick={resetForm}>
                <RotateCcw className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Damages log */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Damage & Adjustment Log</CardTitle>
          </CardHeader>
          <CardContent>
            {(damages ?? []).length === 0 ? (
              <EmptyState
                title="No damage entries yet"
                description="Record damaged, expired, or leaked stock using the form on the left."
                icon={<Skull className="h-6 w-6" />}
              />
            ) : (
              <div className="scrollbar-thin max-h-[600px] overflow-y-auto rounded-md border border-border">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Bag × Pcs</TableHead>
                      <TableHead className="text-right">Total Pcs</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead className="text-right">Expense</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(damages ?? []).slice(0, 200).map((d) => {
                      // Upgrade 3 — resolve source badge. Treat undefined
                      // (legacy rows) as 'godown'.
                      const src: DamageSource = d.damage_source === 'store' ? 'store' : 'godown'
                      return (
                      <TableRow key={d.id}>
                        <TableCell className="text-xs">{formatDate(d.date)}</TableCell>
                        <TableCell>
                          <div className="text-sm font-medium">{d.product_name}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{d.product_sku}</div>
                          {src === 'store' && d.customer_name && (
                            <div className="mt-0.5 text-[10px] text-blue-700">
                              👤 {d.customer_name}
                            </div>
                          )}
                          {src === 'store' && d.against_invoice_no && (
                            <div className="mt-0.5 inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[10px] text-blue-700">
                              🧾 {d.against_invoice_no}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {d.bag_qty} × {d.pcs_qty}
                        </TableCell>
                        <TableCell className="text-right text-xs font-semibold">
                          {formatNumber(d.total_pcs, 0)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${REASON_BADGE[d.reason]}`}>
                              {d.reason}
                            </span>
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                src === 'godown'
                                  ? 'bg-gray-100 text-gray-700'
                                  : 'bg-blue-100 text-blue-700'
                              }`}
                              title={src === 'godown' ? 'Deducted from sellable stock' : 'Tracked separately — sellable stock unchanged'}
                            >
                              {src === 'godown' ? 'Godown' : 'Store'}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground" title={d.notes}>
                          {d.notes || '—'}
                        </TableCell>
                        <TableCell className="text-right text-xs font-semibold text-red-600">
                          {formatINR(d.expense_value)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            onClick={() => remove(d.id!, d.product_name, src)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
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
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-xs font-medium text-foreground">{label}</Label>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="opacity-80">{label}</span>
      <span>{value}</span>
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
  variant?: 'default' | 'warning' | 'danger' | 'info'
}) {
  const styles = {
    default: 'border-border bg-card',
    warning: 'border-amber-200 bg-amber-50',
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

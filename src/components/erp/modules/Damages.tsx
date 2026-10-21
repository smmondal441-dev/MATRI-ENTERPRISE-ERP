'use client'

import { useState, useMemo } from 'react'
import { useProducts, useDamages, useDamageTotals } from '@/lib/hooks/use-erp'
import { DamageService, getPurchaseRatePerPiece } from '@/lib/services/repository'
import {
  formatINR,
  formatNumber,
  formatDate,
  todayISO,
  downloadCSV,
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
import {
  AlertTriangle,
  Trash2,
  Plus,
  RotateCcw,
  Download,
  Skull,
} from 'lucide-react'
import type { DamageReason } from '@/lib/db/dexie'

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
  const { toast } = useToast()

  const [date, setDate] = useState(todayISO())
  const [productId, setProductId] = useState('')
  const [bagQty, setBagQty] = useState(0)
  const [pcsQty, setPcsQty] = useState(0)
  const [reason, setReason] = useState<DamageReason>('Broken')
  const [notes, setNotes] = useState('')

  const selectedProduct = useMemo(
    () => (products ?? []).find((p) => String(p.id) === productId),
    [products, productId]
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
    // Safety check against current stock
    if (totalPcs > selectedProduct.opening_stock_pcs) {
      if (
        !confirm(
          `Damaged qty (${totalPcs} Pcs) exceeds current stock (${selectedProduct.opening_stock_pcs} Pcs). Continue anyway?`
        )
      ) {
        return
      }
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
      })
      toast({
        title: 'Damage recorded',
        description: `${selectedProduct.name} · ${formatNumber(totalPcs, 0)} Pcs · ${reason} · Stock adjusted −${formatNumber(totalPcs, 0)} Pcs`,
      })
      resetForm()
    } catch (e) {
      toast({ title: 'Save failed', description: String(e), variant: 'destructive' })
    }
  }

  const remove = async (id: number, productName: string) => {
    if (!confirm(`Delete damage entry for "${productName}"? Stock will be restored.`)) return
    await DamageService.remove(id)
    toast({ title: 'Damage deleted', description: 'Stock restored.' })
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
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select damaged product" />
                </SelectTrigger>
                <SelectContent>
                  {(products ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.sku} · {p.name} (Stock: {formatNumber(p.opening_stock_pcs, 0)} Pcs)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
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
                placeholder="e.g. Wet transit damage / batch expired"
              />
            </Field>

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
                    <Row
                      label="Stock After Adjustment"
                      value={
                        <span className={selectedProduct.opening_stock_pcs - totalPcs < 0 ? 'text-red-700 font-semibold' : 'font-semibold'}>
                          {formatNumber(Math.max(0, selectedProduct.opening_stock_pcs - totalPcs), 0)} Pcs
                        </span>
                      }
                    />
                  </div>
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
                    {(damages ?? []).slice(0, 200).map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="text-xs">{formatDate(d.date)}</TableCell>
                        <TableCell>
                          <div className="text-sm font-medium">{d.product_name}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{d.product_sku}</div>
                        </TableCell>
                        <TableCell className="text-xs">
                          {d.bag_qty} × {d.pcs_qty}
                        </TableCell>
                        <TableCell className="text-right text-xs font-semibold">
                          {formatNumber(d.total_pcs, 0)}
                        </TableCell>
                        <TableCell>
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${REASON_BADGE[d.reason]}`}>
                            {d.reason}
                          </span>
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
                            onClick={() => remove(d.id!, d.product_name)}
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

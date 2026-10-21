'use client'

import { useState, useMemo } from 'react'
import { useProducts } from '@/lib/hooks/use-erp'
import {
  ProductService,
  getPurchaseRatePerPiece,
  getSellingRatePerPiece,
  getPurchaseRatePerOuterUnit,
  getSellingRatePerOuterUnit,
  getProfitPerPiece,
  getMarginPercentPerPiece,
  computePurchaseRatePerPiece,
  computeSellingRatePerOuterUnit,
} from '@/lib/services/repository'
import { formatINR, formatNumber } from '@/lib/utils/format'
import { PageHeader, EmptyState } from '@/components/erp/EmptyState'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'
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
  Package,
  Plus,
  Search,
  Pencil,
  Trash2,
  AlertTriangle,
} from 'lucide-react'
import type { Product } from '@/lib/db/dexie'

const UNITS_OUTER = ['Bag', 'Peti', 'Carton', 'Box', 'Case', 'Tray']
const UNITS_BASE = ['Pcs', 'Gm', 'Kg', 'Ml', 'Ltr']

interface FormState {
  sku: string
  company_name: string
  name: string
  category: string
  hsn_code: string
  outer_unit: string
  base_unit: string
  conversion_factor: number
  pack_size: string
  // v4 — flipped pricing model
  // User inputs (primary):
  purchase_rate_per_outer_unit: number // total buying price per Bag/Peti
  selling_rate_per_piece: number // primary default selling rate per Pcs
  // Auto-computed (display only — ProductService persists these on save):
  // purchase_rate_per_piece = purchase_rate_per_outer_unit / conversion_factor
  // selling_rate_per_outer_unit = selling_rate_per_piece * conversion_factor
  gst_percent: number
  opening_stock_pcs: number
}

const EMPTY: FormState = {
  sku: '',
  company_name: '',
  name: '',
  category: '',
  hsn_code: '',
  outer_unit: 'Bag',
  base_unit: 'Pcs',
  conversion_factor: 1,
  pack_size: '',
  purchase_rate_per_outer_unit: 0,
  selling_rate_per_piece: 0,
  gst_percent: 0,
  opening_stock_pcs: 0,
}

export function ProductMaster() {
  const products = useProducts()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return products ?? []
    return (products ?? []).filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.company_name.toLowerCase().includes(q) ||
        p.hsn_code.toLowerCase().includes(q)
    )
  }, [products, search])

  const openAdd = () => {
    setForm(EMPTY)
    setEditingId(null)
    setOpen(true)
  }

  const openEdit = (p: Product) => {
    setForm({
      sku: p.sku,
      company_name: p.company_name,
      name: p.name,
      category: p.category ?? '',
      hsn_code: p.hsn_code,
      outer_unit: p.outer_unit,
      base_unit: p.base_unit,
      conversion_factor: p.conversion_factor,
      pack_size: p.pack_size ?? '',
      // v4 — load the two primary inputs (per-outer buy + per-piece sell)
      purchase_rate_per_outer_unit: getPurchaseRatePerOuterUnit(p),
      selling_rate_per_piece: getSellingRatePerPiece(p),
      gst_percent: p.gst_percent,
      opening_stock_pcs: p.opening_stock_pcs,
    })
    setEditingId(p.id ?? null)
    setOpen(true)
  }

  const save = async () => {
    if (!form.sku || !form.name || !form.company_name) {
      toast({
        title: 'Missing fields',
        description: 'SKU, Company Name and Product Name are required.',
        variant: 'destructive',
      })
      return
    }
    try {
      const conversionFactor = Number(form.conversion_factor) || 1
      const purchaseRatePerOuterUnit = Number(form.purchase_rate_per_outer_unit) || 0
      const sellingRatePerPiece = Number(form.selling_rate_per_piece) || 0
      // v4 — compute the auto-derived per-piece / per-outer rates so the
      // payload satisfies the Product interface (which requires all 4 fields).
      const purchaseRatePerPiece =
        conversionFactor > 0 ? purchaseRatePerOuterUnit / conversionFactor : 0
      const sellingRatePerOuterUnit = sellingRatePerPiece * conversionFactor

      const payload = {
        ...form,
        conversion_factor: conversionFactor,
        purchase_rate_per_outer_unit: purchaseRatePerOuterUnit,
        purchase_rate_per_piece: purchaseRatePerPiece,
        selling_rate_per_piece: sellingRatePerPiece,
        selling_rate_per_outer_unit: sellingRatePerOuterUnit,
        gst_percent: Number(form.gst_percent) || 0,
        opening_stock_pcs: Number(form.opening_stock_pcs) || 0,
      }
      if (editingId) {
        await ProductService.update(editingId, payload)
        toast({ title: 'Product updated', description: payload.name })
      } else {
        await ProductService.create(payload)
        toast({ title: 'Product added', description: payload.name })
      }
      setOpen(false)
    } catch (e) {
      toast({
        title: 'Save failed',
        description: String(e),
        variant: 'destructive',
      })
    }
  }

  const remove = async (p: Product) => {
    if (!confirm(`Delete product "${p.name}"? This cannot be undone.`)) return
    try {
      await ProductService.remove(p.id!)
      toast({ title: 'Product deleted', description: p.name })
    } catch (e) {
      toast({
        title: 'Delete failed',
        description: String(e),
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Product Master"
        description="Maintain SKUs, unit hierarchy (Outer → Base), GST, and pricing."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button onClick={openAdd}>
                <Plus className="mr-1 h-4 w-4" /> Add Product
              </Button>
            </DialogTrigger>
          </Dialog>
        }
      />

      <Card>
        <CardContent className="p-4">
          <div className="relative mb-3 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, SKU, company, HSN..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title="No products yet"
              description="Add your first product to start billing and tracking stock."
              icon={<Package className="h-6 w-6" />}
            />
          ) : (
            <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Product Name</TableHead>
                    <TableHead>HSN</TableHead>
                    <TableHead>Unit Hierarchy</TableHead>
                    <TableHead className="text-right">Buy Rate</TableHead>
                    <TableHead className="text-right">Sell Rate</TableHead>
                    <TableHead className="text-right">Margin/Pcs</TableHead>
                    <TableHead className="text-right">GST%</TableHead>
                    <TableHead className="text-right">Stock (Pcs)</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                      <TableCell className="text-xs">{p.company_name}</TableCell>
                      <TableCell className="font-medium">
                        <div className="text-sm">{p.name}</div>
                        {p.pack_size && (
                          <div className="text-xs text-muted-foreground">
                            {p.pack_size}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{p.hsn_code}</TableCell>
                      <TableCell className="text-xs">
                        <div>
                          <span className="font-medium">1 {p.outer_unit}</span>{' '}
                          = {formatNumber(p.conversion_factor, 0)} {p.base_unit}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Buy / {p.outer_unit}
                        </div>
                        <div className="font-medium">{formatINR(getPurchaseRatePerOuterUnit(p))}</div>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          = <span className="font-semibold text-emerald-700">{formatINR(getPurchaseRatePerPiece(p))}</span> /{p.base_unit}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Sell / {p.base_unit}
                        </div>
                        <div className="font-medium">{formatINR(getSellingRatePerPiece(p))}</div>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          = <span className="font-semibold">{formatINR(getSellingRatePerOuterUnit(p))}</span> /{p.outer_unit}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Margin/Pcs</div>
                        <div className={getProfitPerPiece(p) >= 0 ? 'font-semibold text-emerald-700' : 'font-semibold text-red-700'}>
                          {formatINR(getProfitPerPiece(p))}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {formatNumber(getMarginPercentPerPiece(p), 1)}%
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {p.gst_percent}%
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {formatNumber(p.opening_stock_pcs, 0)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => openEdit(p)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => remove(p)}
                          >
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId ? 'Edit Product' : 'Add Product'}
            </DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="SKU *">
              <Input
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                placeholder="e.g. PARLE-G-001"
              />
            </Field>
            <Field label="Company Name *">
              <Input
                value={form.company_name}
                onChange={(e) => setForm({ ...form, company_name: e.target.value })}
                placeholder="e.g. Parle Products"
              />
            </Field>
            <Field label="Product Name *" className="sm:col-span-2">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Parle-G Glucose Biscuit"
              />
            </Field>
            <Field label="Category">
              <Input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="e.g. Biscuits"
              />
            </Field>
            <Field label="HSN Code">
              <Input
                value={form.hsn_code}
                onChange={(e) => setForm({ ...form, hsn_code: e.target.value })}
                placeholder="e.g. 1905"
              />
            </Field>
            <Field label="Outer Unit">
              <Select
                value={form.outer_unit}
                onValueChange={(v) => setForm({ ...form, outer_unit: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNITS_OUTER.map((u) => (
                    <SelectItem key={u} value={u}>
                      {u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Base Unit">
              <Select
                value={form.base_unit}
                onValueChange={(v) => setForm({ ...form, base_unit: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNITS_BASE.map((u) => (
                    <SelectItem key={u} value={u}>
                      {u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={`Conversion Factor (1 ${form.outer_unit} = ? ${form.base_unit})`}>
              <Input
                type="number"
                min={1}
                value={form.conversion_factor}
                onChange={(e) =>
                  setForm({ ...form, conversion_factor: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Pack Size (grams/ml)">
              <Input
                value={form.pack_size}
                onChange={(e) => setForm({ ...form, pack_size: e.target.value })}
                placeholder="e.g. 200g / 500ml"
              />
            </Field>
            <Field label={`Purchase Rate (per ${form.outer_unit}) *`}>
              <Input
                type="number"
                step="0.01"
                value={form.purchase_rate_per_outer_unit}
                onChange={(e) =>
                  setForm({ ...form, purchase_rate_per_outer_unit: Number(e.target.value) })
                }
                placeholder="e.g. ₹600 per Bag"
              />
            </Field>
            <Field label={`Selling Rate (per ${form.base_unit}) *`}>
              <Input
                type="number"
                step="0.01"
                value={form.selling_rate_per_piece}
                onChange={(e) =>
                  setForm({ ...form, selling_rate_per_piece: Number(e.target.value) })
                }
                placeholder="e.g. ₹3.50 per Pcs"
              />
            </Field>
            <Field label="GST %">
              <Input
                type="number"
                value={form.gst_percent}
                onChange={(e) =>
                  setForm({ ...form, gst_percent: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Opening Stock (in base units / Pcs)">
              <Input
                type="number"
                value={form.opening_stock_pcs}
                onChange={(e) =>
                  setForm({ ...form, opening_stock_pcs: Number(e.target.value) })
                }
              />
            </Field>
          </div>

          <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" />
              Auto-Computed Rate Card (v4 per-piece pricing)
            </div>

            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {/* Purchase side */}
              <div className="rounded bg-white/60 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide opacity-70">
                  Purchase Rate (input)
                </div>
                <div>
                  <strong>{formatINR(form.purchase_rate_per_outer_unit)}</strong> /{form.outer_unit}
                  <span className="mx-1 opacity-60">÷ {form.conversion_factor}</span>
                  <span className="mx-1 opacity-60">→</span>
                  <strong className="text-emerald-700">
                    ₹{computePurchaseRatePerPiece(form.purchase_rate_per_outer_unit, form.conversion_factor).toFixed(4)}
                  </strong>{' '}
                  /{form.base_unit}
                </div>
                <div className="text-[10px] opacity-70">
                  purchase_rate_per_piece = {formatINR(form.purchase_rate_per_outer_unit)} ÷ {form.conversion_factor}{' '}
                  = ₹{computePurchaseRatePerPiece(form.purchase_rate_per_outer_unit, form.conversion_factor).toFixed(4)}
                </div>
              </div>

              {/* Selling side */}
              <div className="rounded bg-white/60 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide opacity-70">
                  Selling Rate (input · primary)
                </div>
                <div>
                  <strong>{formatINR(form.selling_rate_per_piece)}</strong> /{form.base_unit}
                  <span className="mx-1 opacity-60">×</span>
                  <span className="mx-1 opacity-60">{form.conversion_factor}</span>
                  <span className="mx-1 opacity-60">→</span>
                  <strong className="text-emerald-700">
                    {formatINR(computeSellingRatePerOuterUnit(form.selling_rate_per_piece, form.conversion_factor))}
                  </strong>{' '}
                  /{form.outer_unit}
                </div>
                <div className="text-[10px] opacity-70">
                  selling_rate_per_outer_unit = {formatINR(form.selling_rate_per_piece)} × {form.conversion_factor}{' '}
                  = {formatINR(computeSellingRatePerOuterUnit(form.selling_rate_per_piece, form.conversion_factor))}
                </div>
              </div>
            </div>

            <div className="mt-2 border-t border-emerald-200 pt-2">
              <div className="flex items-center justify-between">
                <span className="opacity-80">Profit per Piece (= Sell/Pcs − Buy/Pcs)</span>
                {(() => {
                  const profitPerPiece =
                    form.selling_rate_per_piece -
                    computePurchaseRatePerPiece(form.purchase_rate_per_outer_unit, form.conversion_factor)
                  const margin =
                    form.selling_rate_per_piece > 0
                      ? (profitPerPiece / form.selling_rate_per_piece) * 100
                      : 0
                  return (
                    <strong className={profitPerPiece >= 0 ? 'text-emerald-700' : 'text-red-700'}>
                      {formatINR(profitPerPiece)} ({formatNumber(margin, 1)}%)
                    </strong>
                  )
                })()}
              </div>
              <div className="mt-0.5 text-[10px] opacity-70">
                Baseline for POS billing — every line item&apos;s profit uses these per-piece rates directly.
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save}>{editingId ? 'Update' : 'Add Product'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <Label className="mb-1 block text-xs font-medium text-foreground">{label}</Label>
      {children}
    </div>
  )
}

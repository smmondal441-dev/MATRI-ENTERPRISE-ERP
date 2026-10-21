'use client'

import { useState, useMemo } from 'react'
import {
  useProducts,
  useCustomers,
  usePurchases,
  useSales,
  usePurchaseReturns,
  useSalesReturns,
} from '@/lib/hooks/use-erp'
import {
  PurchaseReturnService,
  SalesReturnService,
  getPurchaseRatePerPiece,
  getPurchaseRatePerOuterUnit,
  getSellingRatePerPiece,
} from '@/lib/services/repository'
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import {
  Trash2,
  Plus,
  RotateCcw,
  Download,
  Undo2,
  PackageX,
  PackageCheck,
} from 'lucide-react'

export function StockReturns() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Stock Returns"
        description="Manage returns — both to suppliers (purchase returns) and from customers (sales returns). Stock and ledgers update atomically."
      />
      <Tabs defaultValue="purchase-return">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="purchase-return">
            <PackageX className="mr-1 h-3.5 w-3.5" /> Purchase Return (to Supplier)
          </TabsTrigger>
          <TabsTrigger value="sales-return">
            <PackageCheck className="mr-1 h-3.5 w-3.5" /> Sales Return (from Customer)
          </TabsTrigger>
        </TabsList>
        <TabsContent value="purchase-return" className="mt-4">
          <PurchaseReturnTab />
        </TabsContent>
        <TabsContent value="sales-return" className="mt-4">
          <SalesReturnTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ============================================================================
// Purchase Return — Return TO Supplier (deduct stock, credit supplier)
// ============================================================================

function PurchaseReturnTab() {
  const products = useProducts()
  const purchases = usePurchases()
  const returns = usePurchaseReturns()
  const { toast } = useToast()

  const [date, setDate] = useState(todayISO())
  const [supplierName, setSupplierName] = useState('')
  const [supplierGstin, setSupplierGstin] = useState('')
  const [productId, setProductId] = useState('')
  const [bagQty, setBagQty] = useState(0)
  const [pcsQty, setPcsQty] = useState(0)
  const [reason, setReason] = useState('Defective stock')

  const selectedProduct = useMemo(
    () => (products ?? []).find((p) => String(p.id) === productId),
    [products, productId]
  )
  const conversion = selectedProduct?.conversion_factor ?? 1
  // v4 — purchase rate per outer (per Bag) and per piece (per Pcs)
  const purchaseRatePerOuter = selectedProduct
    ? getPurchaseRatePerOuterUnit(selectedProduct)
    : 0
  const gstPercent = selectedProduct?.gst_percent ?? 0
  const totalPcs = bagQty * conversion + pcsQty
  const perPiece = selectedProduct ? getPurchaseRatePerPiece(selectedProduct) : 0
  // taxable = total_pcs * purchase_rate_per_piece
  const taxableAmount = totalPcs * perPiece
  const cgst = (taxableAmount * (gstPercent / 2)) / 100
  const sgst = (taxableAmount * (gstPercent / 2)) / 100
  const totalAmount = taxableAmount + cgst + sgst

  const resetForm = () => {
    setDate(todayISO())
    setSupplierName('')
    setSupplierGstin('')
    setProductId('')
    setBagQty(0)
    setPcsQty(0)
    setReason('Defective stock')
  }

  const save = async () => {
    if (!selectedProduct || !supplierName) {
      toast({
        title: 'Missing fields',
        description: 'Supplier name and product are required.',
        variant: 'destructive',
      })
      return
    }
    if (totalPcs <= 0) {
      toast({ title: 'Invalid quantity', variant: 'destructive' })
      return
    }
    if (totalPcs > selectedProduct.opening_stock_pcs) {
      if (!confirm(`Return qty (${totalPcs} Pcs) exceeds current stock (${selectedProduct.opening_stock_pcs} Pcs). Continue?`)) return
    }
    try {
      await PurchaseReturnService.create({
        date,
        supplier_name: supplierName,
        supplier_gstin: supplierGstin,
        product_id: selectedProduct.id!,
        product_sku: selectedProduct.sku,
        product_name: selectedProduct.name,
        hsn_code: selectedProduct.hsn_code,
        bag_qty: bagQty,
        pcs_qty: pcsQty,
        total_pcs: totalPcs,
        // v4 — store both per-outer and per-piece purchase rates
        purchase_rate: purchaseRatePerOuter,
        purchase_rate_per_pcs: perPiece,
        gst_percent: gstPercent,
        taxable_amount: taxableAmount,
        cgst,
        sgst,
        total_amount: totalAmount,
        reason,
      })
      toast({
        title: 'Purchase return recorded',
        description: `Return to ${supplierName} · ${formatNumber(totalPcs, 0)} Pcs · Stock −${formatNumber(totalPcs, 0)} Pcs · Supplier credit ${formatINR(totalAmount)}`,
      })
      resetForm()
    } catch (e) {
      toast({ title: 'Save failed', description: String(e), variant: 'destructive' })
    }
  }

  const remove = async (id: number, returnNo: string) => {
    if (!confirm(`Delete purchase return ${returnNo}? Stock will be restored.`)) return
    await PurchaseReturnService.remove(id)
    toast({ title: 'Purchase return deleted', description: returnNo })
  }

  const exportCsv = () => {
    const totalRefund = (returns ?? []).reduce((s, r) => s + r.total_amount, 0)
    downloadCSV(`purchase-returns-${todayISO()}`, [
      ['Date', 'Return No', 'Supplier', 'GSTIN', 'Product', 'Bag Qty', 'Pcs Qty', 'Total Pcs', 'GST%', 'Taxable', 'CGST', 'SGST', 'Total Credit'],
      ...(returns ?? []).map((r) => [
        r.date, r.return_no, r.supplier_name, r.supplier_gstin || '',
        r.product_name, r.bag_qty, r.pcs_qty, r.total_pcs,
        r.gst_percent, r.taxable_amount.toFixed(2), r.cgst.toFixed(2),
        r.sgst.toFixed(2), r.total_amount.toFixed(2),
      ]),
      [],
      ['TOTAL', '', '', '', '', '', '', '', '', '', '', '', totalRefund.toFixed(2)],
    ])
    toast({ title: 'CSV downloaded' })
  }

  const totalRefund = (returns ?? []).reduce((s, r) => s + r.total_amount, 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Returns" value={String(returns?.length ?? 0)} />
        <StatCard label="Pcs Returned" value={formatNumber((returns ?? []).reduce((s, r) => s + r.total_pcs, 0), 0)} variant="warning" />
        <StatCard label="Supplier Credit" value={formatINR(totalRefund)} variant="info" />
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Supplier Name *">
              <Input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} placeholder="e.g. Parle Agro" />
            </Field>
            <Field label="Supplier GSTIN">
              <Input value={supplierGstin} onChange={(e) => setSupplierGstin(e.target.value)} className="font-mono text-xs" />
            </Field>
            <Field label="Product *">
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                <SelectContent>
                  {(products ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.sku} · {p.name} (Stock: {formatNumber(p.opening_stock_pcs, 0)} Pcs)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={`Bag Qty (1 Bag = ${conversion} Pcs)`}>
              <Input type="number" min={0} value={bagQty} onChange={(e) => setBagQty(Number(e.target.value))} />
            </Field>
            <Field label="Extra Pcs">
              <Input type="number" min={0} value={pcsQty} onChange={(e) => setPcsQty(Number(e.target.value))} />
            </Field>
            <Field label="Reason">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Defective / Near-expiry" />
            </Field>
          </div>

          {selectedProduct && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                <Mini label="SKU" value={selectedProduct.sku} />
                <Mini label="HSN" value={selectedProduct.hsn_code} />
                <Mini label="Total Pcs" value={formatNumber(totalPcs, 0)} />
                <Mini label={`Pur. Rate / ${selectedProduct.outer_unit}`} value={formatINR(purchaseRatePerOuter)} />
                <Mini label={`Pur. Rate / ${selectedProduct.base_unit}`} value={`₹${perPiece.toFixed(4)}`} highlight />
                <Mini label="Taxable Amt" value={formatINR(taxableAmount)} />
                <Mini label="CGST" value={formatINR(cgst)} />
                <Mini label="SGST" value={formatINR(sgst)} />
                <Mini label="Supplier Credit" value={formatINR(totalAmount)} bold />
              </div>
              <div className="mt-2 rounded bg-white/60 px-2 py-1 text-[11px]">
                <strong>Stock impact:</strong> −{formatNumber(totalPcs, 0)} Pcs ·{' '}
                <strong>Supplier credit:</strong> {formatINR(totalAmount)} (accounted against future purchases)
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={save}>
              <Plus className="mr-1 h-4 w-4" /> Record Purchase Return
            </Button>
            <Button variant="outline" onClick={resetForm}>
              <RotateCcw className="mr-1 h-4 w-4" /> Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Purchase Returns Log</CardTitle>
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="mr-1 h-4 w-4" /> Export
          </Button>
        </CardHeader>
        <CardContent>
          {(returns ?? []).length === 0 ? (
            <EmptyState
              title="No purchase returns yet"
              description="Record your first return to a supplier above."
              icon={<Undo2 className="h-6 w-6" />}
            />
          ) : (
            <div className="scrollbar-thin max-h-96 overflow-y-auto rounded-md border border-border">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Return No</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Bag × Pcs</TableHead>
                    <TableHead className="text-right">Total Pcs</TableHead>
                    <TableHead className="text-right">Taxable</TableHead>
                    <TableHead className="text-right">GST</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(returns ?? []).slice(0, 200).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs">{formatDate(r.date)}</TableCell>
                      <TableCell className="font-mono text-xs">{r.return_no}</TableCell>
                      <TableCell className="text-xs">
                        <div>{r.supplier_name}</div>
                        {r.supplier_gstin && <div className="font-mono text-[10px] text-muted-foreground">{r.supplier_gstin}</div>}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="font-medium">{r.product_name}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">{r.product_sku}</div>
                      </TableCell>
                      <TableCell className="text-right text-xs">{r.bag_qty} × {r.pcs_qty}</TableCell>
                      <TableCell className="text-right text-xs font-semibold">{formatNumber(r.total_pcs, 0)}</TableCell>
                      <TableCell className="text-right text-xs">{formatINR(r.taxable_amount)}</TableCell>
                      <TableCell className="text-right text-xs">{formatINR(r.cgst + r.sgst)}</TableCell>
                      <TableCell className="text-right text-xs font-semibold text-rose-700">{formatINR(r.total_amount)}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(r.id!, r.return_no)}>
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
  )
}

// ============================================================================
// Sales Return — Return FROM Customer (restock + credit customer dues)
// ============================================================================

function SalesReturnTab() {
  const products = useProducts()
  const customers = useCustomers()
  const sales = useSales()
  const returns = useSalesReturns()
  const { toast } = useToast()

  const [date, setDate] = useState(todayISO())
  const [customerId, setCustomerId] = useState('')
  const [productId, setProductId] = useState('')
  const [bagQty, setBagQty] = useState(0)
  const [pcsQty, setPcsQty] = useState(0)
  const [restock, setRestock] = useState(true)
  const [reason, setReason] = useState('Customer return / quality issue')

  const selectedProduct = useMemo(
    () => (products ?? []).find((p) => String(p.id) === productId),
    [products, productId]
  )
  const customer = (customers ?? []).find((c) => String(c.id) === customerId)
  const conversion = selectedProduct?.conversion_factor ?? 1
  const gstPercent = selectedProduct?.gst_percent ?? 0
  const totalPcs = bagQty * conversion + pcsQty
  // v4 — primary selling rate per piece (per Pcs)
  const salesRatePerPiece = selectedProduct ? getSellingRatePerPiece(selectedProduct) : 0
  const taxableAmount = salesRatePerPiece * totalPcs
  const cgst = (taxableAmount * (gstPercent / 2)) / 100
  const sgst = (taxableAmount * (gstPercent / 2)) / 100
  const totalAmount = taxableAmount + cgst + sgst

  const resetForm = () => {
    setDate(todayISO())
    setCustomerId('')
    setProductId('')
    setBagQty(0)
    setPcsQty(0)
    setRestock(true)
    setReason('Customer return / quality issue')
  }

  const save = async () => {
    if (!customer || !selectedProduct) {
      toast({
        title: 'Missing fields',
        description: 'Customer and product are required.',
        variant: 'destructive',
      })
      return
    }
    if (totalPcs <= 0) {
      toast({ title: 'Invalid quantity', variant: 'destructive' })
      return
    }
    try {
      await SalesReturnService.create({
        date,
        customer_id: customer.id!,
        customer_name: customer.name,
        product_id: selectedProduct.id!,
        product_sku: selectedProduct.sku,
        product_name: selectedProduct.name,
        hsn_code: selectedProduct.hsn_code,
        bag_qty: bagQty,
        pcs_qty: pcsQty,
        total_pcs: totalPcs,
        // v4 — store the per-piece selling rate (primary in v4)
        sales_rate_per_pcs: salesRatePerPiece,
        gst_percent: gstPercent,
        taxable_amount: taxableAmount,
        cgst,
        sgst,
        total_amount: totalAmount,
        restock,
        reason,
      })
      toast({
        title: 'Sales return recorded',
        description: `${customer.name} · ${formatNumber(totalPcs, 0)} Pcs · Customer credit ${formatINR(totalAmount)}${restock ? ' · Stock +Pcs' : ' · Goods discarded'}`,
      })
      resetForm()
    } catch (e) {
      toast({ title: 'Save failed', description: String(e), variant: 'destructive' })
    }
  }

  const remove = async (id: number, returnNo: string) => {
    if (!confirm(`Delete sales return ${returnNo}? Stock & customer ledger will be reversed.`)) return
    await SalesReturnService.remove(id)
    toast({ title: 'Sales return deleted', description: returnNo })
  }

  const exportCsv = () => {
    const totalCredit = (returns ?? []).reduce((s, r) => s + r.total_amount, 0)
    downloadCSV(`sales-returns-${todayISO()}`, [
      ['Date', 'Return No', 'Customer', 'Product', 'Bag Qty', 'Pcs Qty', 'Total Pcs', 'GST%', 'Taxable', 'CGST', 'SGST', 'Customer Credit', 'Restock', 'Reason'],
      ...(returns ?? []).map((r) => [
        r.date, r.return_no, r.customer_name, r.product_name,
        r.bag_qty, r.pcs_qty, r.total_pcs, r.gst_percent,
        r.taxable_amount.toFixed(2), r.cgst.toFixed(2), r.sgst.toFixed(2),
        r.total_amount.toFixed(2), r.restock ? 'Yes' : 'No', r.reason || '',
      ]),
      [],
      ['TOTAL', '', '', '', '', '', '', '', '', '', '', totalCredit.toFixed(2), '', ''],
    ])
    toast({ title: 'CSV downloaded' })
  }

  const totalCredit = (returns ?? []).reduce((s, r) => s + r.total_amount, 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Returns" value={String(returns?.length ?? 0)} />
        <StatCard label="Pcs Returned" value={formatNumber((returns ?? []).reduce((s, r) => s + r.total_pcs, 0), 0)} variant="info" />
        <StatCard label="Customer Credit" value={formatINR(totalCredit)} variant="success" />
        <StatCard label="Restocked" value={formatNumber((returns ?? []).filter(r => r.restock).reduce((s, r) => s + r.total_pcs, 0), 0)} variant="success" />
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Customer *">
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                <SelectContent>
                  {(customers ?? []).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.customer_id} · {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Product *" className="sm:col-span-2">
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger><SelectValue placeholder="Select returned product" /></SelectTrigger>
                <SelectContent>
                  {(products ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.sku} · {p.name} — Sell {formatINR(getSellingRatePerPiece(p))}/Pcs
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={`Bag Qty (1 Bag = ${conversion} Pcs)`}>
              <Input type="number" min={0} value={bagQty} onChange={(e) => setBagQty(Number(e.target.value))} />
            </Field>
            <Field label="Extra Pcs">
              <Input type="number" min={0} value={pcsQty} onChange={(e) => setPcsQty(Number(e.target.value))} />
            </Field>
            <Field label="Reason">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex items-end gap-2 rounded-md border border-border bg-muted/30 p-3">
              <Switch id="restock-toggle" checked={restock} onCheckedChange={setRestock} />
              <Label htmlFor="restock-toggle" className="cursor-pointer text-xs">
                Restock goods
                <div className="text-[10px] text-muted-foreground">
                  {restock ? 'Usable → back to inventory' : 'Discarded / not restocked'}
                </div>
              </Label>
            </div>
          </div>

          {selectedProduct && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                <Mini label="SKU" value={selectedProduct.sku} />
                <Mini label="HSN" value={selectedProduct.hsn_code} />
                <Mini label="Total Pcs" value={formatNumber(totalPcs, 0)} />
                <Mini label={`Sale Rate / ${selectedProduct.base_unit}`} value={`₹${salesRatePerPiece.toFixed(4)}`} highlight />
                <Mini label="Taxable Amt" value={formatINR(taxableAmount)} />
                <Mini label="CGST" value={formatINR(cgst)} />
                <Mini label="SGST" value={formatINR(sgst)} />
                <Mini label="Customer Credit" value={formatINR(totalAmount)} bold />
              </div>
              <div className="mt-2 rounded bg-white/60 px-2 py-1 text-[11px]">
                <strong>Stock impact:</strong>{' '}
                {restock ? (
                  <span className="text-emerald-700">+{formatNumber(totalPcs, 0)} Pcs restocked</span>
                ) : (
                  <span className="text-amber-700">No stock change (goods discarded)</span>
                )}
                {' · '}
                <strong>Customer dues:</strong> {formatINR(totalAmount)} credit applied
                {customer ? ` to ${customer.name}` : ''}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={save}>
              <Plus className="mr-1 h-4 w-4" /> Record Sales Return
            </Button>
            <Button variant="outline" onClick={resetForm}>
              <RotateCcw className="mr-1 h-4 w-4" /> Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Sales Returns Log</CardTitle>
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="mr-1 h-4 w-4" /> Export
          </Button>
        </CardHeader>
        <CardContent>
          {(returns ?? []).length === 0 ? (
            <EmptyState
              title="No sales returns yet"
              description="Record your first customer return above."
              icon={<PackageCheck className="h-6 w-6" />}
            />
          ) : (
            <div className="scrollbar-thin max-h-96 overflow-y-auto rounded-md border border-border">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Return No</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Bag × Pcs</TableHead>
                    <TableHead className="text-right">Total Pcs</TableHead>
                    <TableHead>Restock</TableHead>
                    <TableHead className="text-right">Taxable</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(returns ?? []).slice(0, 200).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs">{formatDate(r.date)}</TableCell>
                      <TableCell className="font-mono text-xs">{r.return_no}</TableCell>
                      <TableCell className="text-xs font-medium">{r.customer_name}</TableCell>
                      <TableCell className="text-xs">
                        <div>{r.product_name}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">{r.product_sku}</div>
                      </TableCell>
                      <TableCell className="text-right text-xs">{r.bag_qty} × {r.pcs_qty}</TableCell>
                      <TableCell className="text-right text-xs font-semibold">{formatNumber(r.total_pcs, 0)}</TableCell>
                      <TableCell>
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${r.restock ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                          {r.restock ? 'Restocked' : 'Discarded'}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs">{formatINR(r.taxable_amount)}</TableCell>
                      <TableCell className="text-right text-xs font-semibold text-emerald-700">{formatINR(r.total_amount)}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(r.id!, r.return_no)}>
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
  )
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label className="mb-1 block text-xs font-medium text-foreground">{label}</Label>
      {children}
    </div>
  )
}

function Mini({
  label,
  value,
  bold,
  highlight,
}: {
  label: string
  value: string
  bold?: boolean
  highlight?: boolean
}) {
  return (
    <div className={highlight ? 'rounded bg-white/70 px-1.5 py-1' : ''}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div
        className={
          'text-sm ' +
          (bold ? 'font-bold' : highlight ? 'font-semibold' : 'font-medium')
        }
      >
        {value}
      </div>
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
  variant?: 'default' | 'success' | 'warning' | 'info'
}) {
  const styles = {
    default: 'border-border bg-card',
    success: 'border-emerald-200 bg-emerald-50',
    warning: 'border-amber-200 bg-amber-50',
    info: 'border-sky-200 bg-sky-50',
  }[variant]
  return (
    <div className={`rounded-md border p-3 ${styles}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-base font-semibold lg:text-lg">{value}</div>
    </div>
  )
}

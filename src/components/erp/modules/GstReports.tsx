'use client'

import { useState, useMemo } from 'react'
import { useSales, usePurchases, useSettings, useCustomers } from '@/lib/hooks/use-erp'
import {
  formatINR,
  formatDate,
  downloadCSV,
} from '@/lib/utils/format'
import { PageHeader } from '@/components/erp/EmptyState'
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
import { useToast } from '@/hooks/use-toast'
import {
  FileText,
  Download,
  Calculator,
  ArrowDown,
  ArrowUp,
} from 'lucide-react'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function GstReports() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="GST & Tax Reports for CA"
        description="Generate GSTR-1, GSTR-2, and monthly summary for your chartered accountant."
      />
      <Tabs defaultValue="gstr1">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="gstr1">
            <FileText className="mr-1 h-3.5 w-3.5" /> GSTR-1 (Sales)
          </TabsTrigger>
          <TabsTrigger value="gstr2">
            <FileText className="mr-1 h-3.5 w-3.5" /> GSTR-2 (Purchases)
          </TabsTrigger>
          <TabsTrigger value="summary">
            <Calculator className="mr-1 h-3.5 w-3.5" /> Monthly Summary
          </TabsTrigger>
        </TabsList>
        <TabsContent value="gstr1" className="mt-4">
          <Gstr1Report />
        </TabsContent>
        <TabsContent value="gstr2" className="mt-4">
          <Gstr2Report />
        </TabsContent>
        <TabsContent value="summary" className="mt-4">
          <MonthlySummary />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ============================================================================
// GSTR-1 — outward supplies (sales)
// ============================================================================

interface Gstr1Row {
  date: string
  invoice_no: string
  customer_name: string
  customer_gstin: string
  hsn_code: string
  taxable_amount: number
  cgst: number
  sgst: number
  igst: number
  total_amount: number
}

function Gstr1Report() {
  const sales = useSales()
  const customers = useCustomers()
  const settings = useSettings()
  const { toast } = useToast()

  const [fromMonth, setFromMonth] = useState(String(new Date().getMonth()))
  const [year, setYear] = useState(String(new Date().getFullYear()))

  const rows: Gstr1Row[] = useMemo(() => {
    const monthIdx = Number(fromMonth)
    return (sales ?? []).filter((s) => {
      const d = new Date(s.date)
      return d.getMonth() === monthIdx && d.getFullYear() === Number(year)
    }).flatMap((s) => {
      const cust = (customers ?? []).find((c) => c.id === s.customer_id)
      // We need sale_items but Sales Ledger only stores aggregated; we recompute
      // from sale subtotals & CGST/SGST split.
      // For HSN we would need item-level lookup; since the sale has it on items,
      // we summarize at sale-level (one row per invoice) but show HSN as "—"
      // because GSTR-1 typically requires item-level HSN, so we also offer
      // an item-level export below.
      const interState = cust?.gstin && settings?.gstin &&
        cust.gstin.slice(0, 2) !== settings.gstin.slice(0, 2)
      const igst = interState ? s.cgst + s.sgst : 0
      const cgst = interState ? 0 : s.cgst
      const sgst = interState ? 0 : s.sgst
      return [{
        date: s.date,
        invoice_no: s.invoice_no,
        customer_name: s.customer_name,
        customer_gstin: cust?.gstin || '',
        hsn_code: '—',
        taxable_amount: s.subtotal,
        cgst,
        sgst,
        igst,
        total_amount: s.total_amount,
      }]
    })
  }, [sales, customers, fromMonth, year, settings])

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.taxable += r.taxable_amount
        acc.cgst += r.cgst
        acc.sgst += r.sgst
        acc.igst += r.igst
        acc.total += r.total_amount
        return acc
      },
      { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 }
    )
  }, [rows])

  const exportCsv = () => {
    const out: (string | number)[][] = [
      ['GSTR-1 — Outward Supplies (Sales)', '', '', '', '', '', '', '', ''],
      ['Period:', `${MONTHS[Number(fromMonth)]} ${year}`],
      ['Distributor:', settings?.store_name ?? '', 'GSTIN:', settings?.gstin ?? ''],
      [],
      [
        'Date',
        'Invoice No',
        'Customer Name',
        'Customer GSTIN',
        'HSN',
        'Taxable Amount',
        'CGST',
        'SGST',
        'IGST',
        'Total Amount',
      ],
      ...rows.map((r) => [
        r.date,
        r.invoice_no,
        r.customer_name,
        r.customer_gstin,
        r.hsn_code,
        r.taxable_amount.toFixed(2),
        r.cgst.toFixed(2),
        r.sgst.toFixed(2),
        r.igst.toFixed(2),
        r.total_amount.toFixed(2),
      ]),
      [],
      ['TOTALS', '', '', '', '',
        totals.taxable.toFixed(2),
        totals.cgst.toFixed(2),
        totals.sgst.toFixed(2),
        totals.igst.toFixed(2),
        totals.total.toFixed(2),
      ],
    ]
    downloadCSV(`GSTR1-${MONTHS[Number(fromMonth)]}-${year}`, out)
    toast({ title: 'GSTR-1 CSV downloaded' })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-end justify-between">
        <div>
          <CardTitle className="text-sm">GSTR-1 — Outward Supplies (Sales)</CardTitle>
          <p className="text-xs text-muted-foreground">
            {settings?.store_name} · GSTIN {settings?.gstin ?? '—'}
          </p>
        </div>
        <Button onClick={exportCsv}>
          <Download className="mr-1 h-4 w-4" /> Download GSTR-1 CSV / Excel
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Month">
            <Select value={fromMonth} onValueChange={setFromMonth}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={m} value={String(i)}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Year">
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 5 }).map((_, i) => {
                  const y = new Date().getFullYear() - i
                  return <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                })}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Mini label="Invoices" value={String(rows.length)} />
          <Mini label="Taxable" value={formatINR(totals.taxable)} />
          <Mini label="CGST + SGST + IGST" value={formatINR(totals.cgst + totals.sgst + totals.igst)} variant="info" />
          <Mini label="Total" value={formatINR(totals.total)} variant="success" />
        </div>

        {rows.length === 0 ? (
          <div className="rounded-md bg-muted/40 p-6 text-center text-sm text-muted-foreground">
            No sales in {MONTHS[Number(fromMonth)]} {year}.
          </div>
        ) : (
          <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>GSTIN</TableHead>
                  <TableHead>HSN</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">CGST</TableHead>
                  <TableHead className="text-right">SGST</TableHead>
                  <TableHead className="text-right">IGST</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs">{formatDate(r.date)}</TableCell>
                    <TableCell className="font-mono text-xs">{r.invoice_no}</TableCell>
                    <TableCell className="text-xs">{r.customer_name}</TableCell>
                    <TableCell className="font-mono text-xs">{r.customer_gstin || '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{r.hsn_code}</TableCell>
                    <TableCell className="text-right text-xs">{formatINR(r.taxable_amount)}</TableCell>
                    <TableCell className="text-right text-xs">{formatINR(r.cgst)}</TableCell>
                    <TableCell className="text-right text-xs">{formatINR(r.sgst)}</TableCell>
                    <TableCell className="text-right text-xs">{formatINR(r.igst)}</TableCell>
                    <TableCell className="text-right text-xs font-semibold">{formatINR(r.total_amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2 bg-muted/30 font-semibold">
                  <TableCell colSpan={5}>TOTAL</TableCell>
                  <TableCell className="text-right text-xs">{formatINR(totals.taxable)}</TableCell>
                  <TableCell className="text-right text-xs">{formatINR(totals.cgst)}</TableCell>
                  <TableCell className="text-right text-xs">{formatINR(totals.sgst)}</TableCell>
                  <TableCell className="text-right text-xs">{formatINR(totals.igst)}</TableCell>
                  <TableCell className="text-right text-xs">{formatINR(totals.total)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// GSTR-2 — inward supplies (purchases / ITC)
// ============================================================================

function Gstr2Report() {
  const purchases = usePurchases()
  const settings = useSettings()
  const { toast } = useToast()
  const [month, setMonth] = useState(String(new Date().getMonth()))
  const [year, setYear] = useState(String(new Date().getFullYear()))

  const rows = useMemo(() => {
    return (purchases ?? []).filter((p) => {
      const d = new Date(p.date)
      return d.getMonth() === Number(month) && d.getFullYear() === Number(year)
    })
  }, [purchases, month, year])

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.taxable += r.taxable_amount
        acc.cgst += r.cgst
        acc.sgst += r.sgst
        acc.total += r.total_amount
        return acc
      },
      { taxable: 0, cgst: 0, sgst: 0, total: 0 }
    )
  }, [rows])

  const exportCsv = () => {
    const out: (string | number)[][] = [
      ['GSTR-2 — Inward Supplies (Purchases) / ITC', '', '', '', '', '', '', ''],
      ['Period:', `${MONTHS[Number(month)]} ${year}`],
      ['Distributor:', settings?.store_name ?? '', 'GSTIN:', settings?.gstin ?? ''],
      [],
      [
        'Date',
        'Supplier Invoice No',
        'Supplier Name',
        'Supplier GSTIN',
        'HSN',
        'Taxable Amount',
        'CGST',
        'SGST',
        'Total Tax',
        'Total Amount',
      ],
      ...rows.map((r) => [
        r.date,
        r.bill_no,
        r.supplier_name,
        r.supplier_gstin || '',
        r.hsn_code,
        r.taxable_amount.toFixed(2),
        r.cgst.toFixed(2),
        r.sgst.toFixed(2),
        (r.cgst + r.sgst).toFixed(2),
        r.total_amount.toFixed(2),
      ]),
      [],
      ['TOTALS', '', '', '', '',
        totals.taxable.toFixed(2),
        totals.cgst.toFixed(2),
        totals.sgst.toFixed(2),
        (totals.cgst + totals.sgst).toFixed(2),
        totals.total.toFixed(2),
      ],
    ]
    downloadCSV(`GSTR2-${MONTHS[Number(month)]}-${year}`, out)
    toast({ title: 'GSTR-2 CSV downloaded' })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-end justify-between">
        <div>
          <CardTitle className="text-sm">GSTR-2 — Inward Supplies (Purchases) / ITC</CardTitle>
          <p className="text-xs text-muted-foreground">
            Input Tax Credit eligibility report for {settings?.store_name}
          </p>
        </div>
        <Button onClick={exportCsv}>
          <Download className="mr-1 h-4 w-4" /> Download GSTR-2 CSV / Excel
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Month">
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={m} value={String(i)}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Year">
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 5 }).map((_, i) => {
                  const y = new Date().getFullYear() - i
                  return <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                })}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Mini label="Bills" value={String(rows.length)} />
          <Mini label="Taxable" value={formatINR(totals.taxable)} />
          <Mini label="Input GST" value={formatINR(totals.cgst + totals.sgst)} variant="info" />
          <Mini label="Total" value={formatINR(totals.total)} variant="success" />
        </div>

        {rows.length === 0 ? (
          <div className="rounded-md bg-muted/40 p-6 text-center text-sm text-muted-foreground">
            No purchases in {MONTHS[Number(month)]} {year}.
          </div>
        ) : (
          <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Bill No</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>GSTIN</TableHead>
                  <TableHead>HSN</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">CGST</TableHead>
                  <TableHead className="text-right">SGST</TableHead>
                  <TableHead className="text-right">Total Tax</TableHead>
                  <TableHead className="text-right">Total Amt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs">{formatDate(r.date)}</TableCell>
                    <TableCell className="font-mono text-xs">{r.bill_no}</TableCell>
                    <TableCell className="text-xs">{r.supplier_name}</TableCell>
                    <TableCell className="font-mono text-xs">{r.supplier_gstin || '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{r.hsn_code}</TableCell>
                    <TableCell className="text-right text-xs">{formatINR(r.taxable_amount)}</TableCell>
                    <TableCell className="text-right text-xs">{formatINR(r.cgst)}</TableCell>
                    <TableCell className="text-right text-xs">{formatINR(r.sgst)}</TableCell>
                    <TableCell className="text-right text-xs">{formatINR(r.cgst + r.sgst)}</TableCell>
                    <TableCell className="text-right text-xs font-semibold">{formatINR(r.total_amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2 bg-muted/30 font-semibold">
                  <TableCell colSpan={5}>TOTAL</TableCell>
                  <TableCell className="text-right text-xs">{formatINR(totals.taxable)}</TableCell>
                  <TableCell className="text-right text-xs">{formatINR(totals.cgst)}</TableCell>
                  <TableCell className="text-right text-xs">{formatINR(totals.sgst)}</TableCell>
                  <TableCell className="text-right text-xs">{formatINR(totals.cgst + totals.sgst)}</TableCell>
                  <TableCell className="text-right text-xs">{formatINR(totals.total)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// Monthly GST Summary — Output vs Input vs Net Payable
// ============================================================================

function MonthlySummary() {
  const sales = useSales()
  const purchases = usePurchases()
  const settings = useSettings()
  const { toast } = useToast()
  const [month, setMonth] = useState(String(new Date().getMonth()))
  const [year, setYear] = useState(String(new Date().getFullYear()))

  const data = useMemo(() => {
    const sRows = (sales ?? []).filter((s) => {
      const d = new Date(s.date)
      return d.getMonth() === Number(month) && d.getFullYear() === Number(year)
    })
    const pRows = (purchases ?? []).filter((p) => {
      const d = new Date(p.date)
      return d.getMonth() === Number(month) && d.getFullYear() === Number(year)
    })
    const outputTaxable = sRows.reduce((s, x) => s + x.subtotal, 0)
    const outputCGST = sRows.reduce((s, x) => s + x.cgst, 0)
    const outputSGST = sRows.reduce((s, x) => s + x.sgst, 0)
    const inputTaxable = pRows.reduce((s, x) => s + x.taxable_amount, 0)
    const inputCGST = pRows.reduce((s, x) => s + x.cgst, 0)
    const inputSGST = pRows.reduce((s, x) => s + x.sgst, 0)
    const netCGST = outputCGST - inputCGST
    const netSGST = outputSGST - inputSGST
    const totalOutput = outputCGST + outputSGST
    const totalInput = inputCGST + inputSGST
    const netGST = totalOutput - totalInput
    return {
      salesCount: sRows.length,
      purchaseCount: pRows.length,
      outputTaxable,
      outputCGST,
      outputSGST,
      inputTaxable,
      inputCGST,
      inputSGST,
      netCGST,
      netSGST,
      totalOutput,
      totalInput,
      netGST,
    }
  }, [sales, purchases, month, year])

  const exportCsv = () => {
    const out: (string | number)[][] = [
      ['FMCG ERP — Monthly GST Summary (CA Sheet)', ''],
      ['Distributor:', settings?.store_name ?? ''],
      ['GSTIN:', settings?.gstin ?? ''],
      ['Period:', `${MONTHS[Number(month)]} ${year}`],
      [],
      ['--- OUTPUT (Sales) ---', ''],
      ['Sales Invoices', data.salesCount],
      ['Output Taxable', data.outputTaxable.toFixed(2)],
      ['Output CGST', data.outputCGST.toFixed(2)],
      ['Output SGST', data.outputSGST.toFixed(2)],
      ['Total Output GST', data.totalOutput.toFixed(2)],
      [],
      ['--- INPUT (Purchases / ITC) ---', ''],
      ['Purchase Bills', data.purchaseCount],
      ['Input Taxable', data.inputTaxable.toFixed(2)],
      ['Input CGST (ITC)', data.inputCGST.toFixed(2)],
      ['Input SGST (ITC)', data.inputSGST.toFixed(2)],
      ['Total Input GST', data.totalInput.toFixed(2)],
      [],
      ['--- NET GST PAYABLE / REFUNDABLE ---', ''],
      ['Net CGST', data.netCGST.toFixed(2)],
      ['Net SGST', data.netSGST.toFixed(2)],
      ['Net GST (Payable if +ve, Refund if -ve)', data.netGST.toFixed(2)],
    ]
    downloadCSV(`GST-Summary-${MONTHS[Number(month)]}-${year}`, out)
    toast({ title: 'CA Tax Summary CSV downloaded' })
  }

  const exportTxt = () => {
    const text = `
FMCG ERP — Monthly GST Summary (CA Sheet)
=========================================
Distributor: ${settings?.store_name ?? ''}
GSTIN:      ${settings?.gstin ?? ''}
Period:     ${MONTHS[Number(month)]} ${year}

OUTPUT (Sales)
- Sales Invoices: ${data.salesCount}
- Output Taxable: ${formatINR(data.outputTaxable)}
- Output CGST:    ${formatINR(data.outputCGST)}
- Output SGST:    ${formatINR(data.outputSGST)}
- Total Output GST: ${formatINR(data.totalOutput)}

INPUT (Purchases / ITC)
- Purchase Bills: ${data.purchaseCount}
- Input Taxable: ${formatINR(data.inputTaxable)}
- Input CGST (ITC): ${formatINR(data.inputCGST)}
- Input SGST (ITC): ${formatINR(data.inputSGST)}
- Total Input GST: ${formatINR(data.totalInput)}

NET GST (Payable if +ve, Refund if -ve)
- Net CGST: ${formatINR(data.netCGST)}
- Net SGST: ${formatINR(data.netSGST)}
- Net GST:  ${formatINR(data.netGST)}
`
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `GST-Summary-${MONTHS[Number(month)]}-${year}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast({ title: 'CA Tax Summary TXT downloaded' })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-end justify-between">
        <div>
          <CardTitle className="text-sm">Monthly GST Summary / CA Sheet</CardTitle>
          <p className="text-xs text-muted-foreground">
            Net GST payable or refundable based on Output − Input
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportTxt}>
            <FileText className="mr-1 h-4 w-4" /> Export TXT (PDF-ready)
          </Button>
          <Button onClick={exportCsv}>
            <Download className="mr-1 h-4 w-4" /> Export Full CA Tax Summary CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Month">
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={m} value={String(i)}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Year">
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 5 }).map((_, i) => {
                  const y = new Date().getFullYear() - i
                  return <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                })}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-sky-200 bg-sky-50 p-4">
            <div className="flex items-center gap-2 text-sky-700">
              <ArrowUp className="h-4 w-4" />
              <div className="text-xs font-semibold uppercase">Total Output GST</div>
            </div>
            <div className="mt-2 text-2xl font-bold text-sky-900">
              {formatINR(data.totalOutput)}
            </div>
            <div className="mt-1 text-xs text-sky-700">
              CGST {formatINR(data.outputCGST)} + SGST {formatINR(data.outputSGST)}
            </div>
            <div className="mt-1 text-[10px] text-sky-600">
              From {data.salesCount} sales invoices · Taxable {formatINR(data.outputTaxable)}
            </div>
          </div>

          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-center gap-2 text-emerald-700">
              <ArrowDown className="h-4 w-4" />
              <div className="text-xs font-semibold uppercase">Total Input GST (ITC)</div>
            </div>
            <div className="mt-2 text-2xl font-bold text-emerald-900">
              {formatINR(data.totalInput)}
            </div>
            <div className="mt-1 text-xs text-emerald-700">
              CGST {formatINR(data.inputCGST)} + SGST {formatINR(data.inputSGST)}
            </div>
            <div className="mt-1 text-[10px] text-emerald-600">
              From {data.purchaseCount} purchase bills · Taxable {formatINR(data.inputTaxable)}
            </div>
          </div>

          <div
            className={`rounded-lg border p-4 ${
              data.netGST >= 0
                ? 'border-red-200 bg-red-50'
                : 'border-emerald-200 bg-emerald-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <Calculator className="h-4 w-4" />
              <div className="text-xs font-semibold uppercase">
                Net GST {data.netGST >= 0 ? 'Payable' : 'Refundable'}
              </div>
            </div>
            <div
              className={`mt-2 text-2xl font-bold ${
                data.netGST >= 0 ? 'text-red-900' : 'text-emerald-900'
              }`}
            >
              {formatINR(Math.abs(data.netGST))}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Net CGST {formatINR(data.netCGST)} · Net SGST {formatINR(data.netSGST)}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {data.netGST >= 0 ? 'Pay to government' : 'Claim as refund'}
            </div>
          </div>
        </div>

        {/* Detail table */}
        <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Component</TableHead>
                <TableHead className="text-right">Output (Sales)</TableHead>
                <TableHead className="text-right">Input (Purchases)</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="text-xs">Taxable Amount</TableCell>
                <TableCell className="text-right text-xs">{formatINR(data.outputTaxable)}</TableCell>
                <TableCell className="text-right text-xs">{formatINR(data.inputTaxable)}</TableCell>
                <TableCell className="text-right text-xs">{formatINR(data.outputTaxable - data.inputTaxable)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-xs">CGST</TableCell>
                <TableCell className="text-right text-xs">{formatINR(data.outputCGST)}</TableCell>
                <TableCell className="text-right text-xs">{formatINR(data.inputCGST)}</TableCell>
                <TableCell className="text-right text-xs font-semibold">
                  {formatINR(data.netCGST)}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-xs">SGST</TableCell>
                <TableCell className="text-right text-xs">{formatINR(data.outputSGST)}</TableCell>
                <TableCell className="text-right text-xs">{formatINR(data.inputSGST)}</TableCell>
                <TableCell className="text-right text-xs font-semibold">
                  {formatINR(data.netSGST)}
                </TableCell>
              </TableRow>
              <TableRow className="border-t-2 bg-muted/30 font-semibold">
                <TableCell>TOTAL GST</TableCell>
                <TableCell className="text-right">{formatINR(data.totalOutput)}</TableCell>
                <TableCell className="text-right">{formatINR(data.totalInput)}</TableCell>
                <TableCell className="text-right">{formatINR(data.netGST)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

// ----------------------------------------------------------------------------
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-xs font-medium text-foreground">{label}</Label>
      {children}
    </div>
  )
}

function Mini({
  label,
  value,
  variant = 'default',
}: {
  label: string
  value: string
  variant?: 'default' | 'success' | 'info'
}) {
  const styles = {
    default: 'border-border bg-card',
    success: 'border-emerald-200 bg-emerald-50',
    info: 'border-sky-200 bg-sky-50',
  }[variant]
  return (
    <div className={`rounded-md border p-2 ${styles}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  )
}

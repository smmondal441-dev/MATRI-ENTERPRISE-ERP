'use client'

import { useState, useMemo } from 'react'
import { useCustomers } from '@/lib/hooks/use-erp'
import { CustomerService } from '@/lib/services/repository'
import { formatINR } from '@/lib/utils/format'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/hooks/use-toast'
import { Users, Plus, Search, Pencil, Trash2 } from 'lucide-react'
import type { Customer } from '@/lib/db/dexie'

interface FormState {
  customer_id: string
  name: string
  route_area: string
  phone: string
  gstin: string
  bill_number: string
  opening_balance: number
}

const EMPTY: FormState = {
  customer_id: '',
  name: '',
  route_area: '',
  phone: '',
  gstin: '',
  bill_number: '',
  opening_balance: 0,
}

export function CustomerMaster() {
  const customers = useCustomers()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return customers ?? []
    return (customers ?? []).filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.customer_id.toLowerCase().includes(q) ||
        c.route_area.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q)
    )
  }, [customers, search])

  const openAdd = async () => {
    const nextId = await CustomerService.nextCustomerId()
    setForm({ ...EMPTY, customer_id: nextId })
    setEditingId(null)
    setOpen(true)
  }

  const openEdit = (c: Customer) => {
    setForm({
      customer_id: c.customer_id,
      name: c.name,
      route_area: c.route_area,
      phone: c.phone,
      gstin: c.gstin ?? '',
      bill_number: c.bill_number ?? '',
      opening_balance: c.opening_balance,
    })
    setEditingId(c.id ?? null)
    setOpen(true)
  }

  const save = async () => {
    if (!form.name) {
      toast({
        title: 'Missing fields',
        description: 'Party Name is required.',
        variant: 'destructive',
      })
      return
    }
    try {
      const payload = {
        ...form,
        opening_balance: Number(form.opening_balance) || 0,
      }
      if (editingId) {
        await CustomerService.update(editingId, payload)
        toast({ title: 'Customer updated', description: payload.name })
      } else {
        await CustomerService.create(payload)
        toast({ title: 'Customer added', description: payload.name })
      }
      setOpen(false)
    } catch (e) {
      toast({ title: 'Save failed', description: String(e), variant: 'destructive' })
    }
  }

  const remove = async (c: Customer) => {
    if (!confirm(`Delete customer "${c.name}"?`)) return
    await CustomerService.remove(c.id!)
    toast({ title: 'Customer deleted', description: c.name })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Customer Master"
        description="Manage retailers, routes, GSTIN, and opening dues."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button onClick={openAdd}>
                <Plus className="mr-1 h-4 w-4" /> Add Customer
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
              placeholder="Search by name, code, route, phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title="No customers yet"
              description="Add your first customer to start billing."
              icon={<Users className="h-6 w-6" />}
            />
          ) : (
            <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Party Name</TableHead>
                    <TableHead>Route / Area</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Bill No.</TableHead>
                    <TableHead>GSTIN</TableHead>
                    <TableHead className="text-right">Opening Dues</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">
                        {c.customer_id}
                      </TableCell>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-xs">{c.route_area || '—'}</TableCell>
                      <TableCell className="text-xs">{c.phone || '—'}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {c.bill_number || '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {c.gstin || '—'}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <span
                          className={
                            c.opening_balance > 0
                              ? 'font-medium text-amber-600'
                              : 'text-muted-foreground'
                          }
                        >
                          {formatINR(c.opening_balance)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => openEdit(c)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => remove(c)}
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
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Customer' : 'Add Customer'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Customer Code">
              <Input value={form.customer_id} readOnly className="bg-muted/50 font-mono text-xs" />
            </Field>
            <Field label="Party Name *">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Sharma General Store"
              />
            </Field>
            <Field label="Route / Area">
              <Input
                value={form.route_area}
                onChange={(e) => setForm({ ...form, route_area: e.target.value })}
                placeholder="e.g. MG Road"
              />
            </Field>
            <Field label="Phone Number">
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="9876543210"
              />
            </Field>
            <Field label="GSTIN">
              <Input
                value={form.gstin}
                onChange={(e) => setForm({ ...form, gstin: e.target.value })}
                placeholder="29ABCDE1234F1Z5"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Bill Number">
              <Input
                value={form.bill_number}
                onChange={(e) => setForm({ ...form, bill_number: e.target.value })}
                placeholder="Optional reference / bill no."
              />
            </Field>
            <Field label="Opening Balance Dues (₹)">
              <Input
                type="number"
                value={form.opening_balance}
                onChange={(e) =>
                  setForm({ ...form, opening_balance: Number(e.target.value) })
                }
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save}>{editingId ? 'Update' : 'Add Customer'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

'use client'

// ============================================================================
// Combobox — searchable Autocomplete dropdown
// ----------------------------------------------------------------------------
// A thin wrapper around shadcn/ui `Popover` + `Command` (cmdk) primitives that
// exposes a controlled, generic, type-safe searchable dropdown.
//
// Why this exists:
//   The plain shadcn `<Select>` does not scale beyond ~50 items — there's no
//   text search, so finding a single customer or SKU in a 200-row list is
//   painful. This Combobox adds:
//     - Text search (caller-supplied filterFn so we can match across name,
//       code, route, phone, SKU, etc.)
//     - Rich item rendering (each row can show multiple data columns)
//     - ID-safe matching via `String(item.id)` so Dexie numbers and Turso
//       BigInt-stringified IDs never fail to resolve to the same row.
//
// The dropdown width is automatically matched to the trigger button width
// (with a 280px minimum) so the popover never overflows the form layout.
// ============================================================================

import * as React from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

export interface ComboboxProps<T> {
  /** Full list of items to render / filter. */
  items: T[]
  /** Currently-selected value (always compared as `String(...)`). */
  value: string
  /** Fired when the user picks an item (or clears by re-selecting). */
  onValueChange: (value: string) => void
  /** Returns the comparable ID string for an item — usually `String(item.id)`. */
  getItemValue: (item: T) => string
  /** Returns the plain-text label shown in the trigger button when selected. */
  getItemLabel: (item: T) => string
  /** Rich JSX rendered inside each dropdown row. */
  renderItem: (item: T) => React.ReactNode
  /** Caller-defined filter — receives the lowercased query. */
  filterFn: (item: T, query: string) => boolean
  /** Trigger placeholder when no value is selected. */
  placeholder?: string
  /** Search box placeholder. */
  searchPlaceholder?: string
  /** Empty-state text when no rows match the query. */
  emptyText?: string
  disabled?: boolean
  /** Extra classes on the trigger button. */
  className?: string
  /** Extra classes on the popover content panel. */
  contentClassName?: string
}

export function Combobox<T>({
  items,
  value,
  onValueChange,
  getItemValue,
  getItemLabel,
  renderItem,
  filterFn,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  emptyText = 'No results found.',
  disabled = false,
  className,
  contentClassName,
}: ComboboxProps<T>) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const [triggerWidth, setTriggerWidth] = React.useState<number | undefined>(
    undefined
  )

  // Read the trigger's pixel width whenever the popover opens so we can size
  // the dropdown to match (with a sensible 280px minimum).
  React.useLayoutEffect(() => {
    if (open && triggerRef.current) {
      const w = triggerRef.current.getBoundingClientRect().width
      setTriggerWidth(w)
    }
  }, [open])

  const selected = React.useMemo(() => {
    if (!value) return undefined
    return items.find((it) => String(getItemValue(it)) === String(value))
  }, [items, value, getItemValue])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) => filterFn(it, q))
  }, [items, query, filterFn])

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full justify-between font-normal',
            !selected && 'text-muted-foreground',
            className
          )}
        >
          <span className="truncate text-left">
            {selected ? getItemLabel(selected) : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        style={
          triggerWidth ? { width: Math.max(triggerWidth, 280) } : undefined
        }
        className={cn('p-0', contentClassName)}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {filtered.map((it) => {
                const v = String(getItemValue(it))
                const isSelected = String(value) === v
                return (
                  <CommandItem
                    key={v}
                    value={v}
                    onSelect={() => {
                      onValueChange(isSelected ? '' : v)
                      setOpen(false)
                      setQuery('')
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4 shrink-0',
                        isSelected ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <div className="flex-1 truncate">{renderItem(it)}</div>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

'use client'

import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'

interface StatCardProps {
  label: string
  value: string
  hint?: string
  icon?: React.ReactNode
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info'
  className?: string
}

const variantStyles: Record<NonNullable<StatCardProps['variant']>, string> = {
  default: 'border-border bg-card text-card-foreground',
  success:
    'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
  warning:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
  danger:
    'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100',
  info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100',
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  variant = 'default',
  className,
}: StatCardProps) {
  return (
    <Card className={cn('overflow-hidden', variantStyles[variant], className)}>
      <CardContent className="flex items-start justify-between gap-3 p-4 lg:p-5">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wider opacity-75">
            {label}
          </div>
          <div className="mt-1 truncate text-xl font-semibold lg:text-2xl">
            {value}
          </div>
          {hint && (
            <div className="mt-1 truncate text-xs opacity-70">{hint}</div>
          )}
        </div>
        {icon && (
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-black/5 dark:bg-white/10">
            {icon}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

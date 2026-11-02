import type {
  TokenCounts,
  TokenDayPoint,
  TokenMeta,
  TokenModelRow,
  TokenMonthRow,
  TokenSnapshot,
  TokenSummary,
} from '../types'

export type Counts = TokenCounts
export type DayLedger = Record<string, Record<string, Counts>>

export type UsageLike = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

const ZERO: Counts = [0, 0, 0, 0, 0]

export function emptyDays(): DayLedger {
  return {}
}

export function cloneCounts(c: Counts): Counts {
  return [c[0], c[1], c[2], c[3], c[4]]
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0
}

function addTo(target: Counts, c: Counts): void {
  target[0] += c[0]
  target[1] += c[1]
  target[2] += c[2]
  target[3] += c[3]
  target[4] += c[4]
}

export function addUsage(
  days: DayLedger,
  day: string,
  model: string,
  usage: UsageLike,
): void {
  const i = num(usage.input_tokens)
  const o = num(usage.output_tokens)
  const cr = num(usage.cache_read_input_tokens)
  const cc = num(usage.cache_creation_input_tokens)
  if (i + o + cr + cc === 0) return

  const byModel = days[day] ?? (days[day] = {})
  const name = model || 'unknown'
  const c = byModel[name] ?? [0, 0, 0, 0, 0]
  byModel[name] = [c[0] + i, c[1] + o, c[2] + cr, c[3] + cc, c[4] + 1]
}

export function mergeDays(into: DayLedger, from: DayLedger): void {
  for (const day of Object.keys(from)) {
    const models = from[day]
    if (!models) continue
    const target = into[day] ?? (into[day] = {})
    for (const model of Object.keys(models)) {
      const c = models[model]
      if (!c) continue
      const current = target[model]
      target[model] = current
        ? [current[0] + c[0], current[1] + c[1], current[2] + c[2], current[3] + c[3], current[4] + c[4]]
        : cloneCounts(c)
    }
  }
}

export function sanitizeDays(raw: unknown): DayLedger {
  const out = emptyDays()
  if (!raw || typeof raw !== 'object') return out

  const days = raw as Record<string, unknown>
  for (const day of Object.keys(days)) {
    if (!isDay(day)) continue
    const models = days[day]
    if (!models || typeof models !== 'object') continue

    const byModel = models as Record<string, unknown>
    for (const model of Object.keys(byModel)) {
      const value = byModel[model]
      if (!Array.isArray(value) || value.length < 5) continue
      const c: Counts = [
        num(value[0]),
        num(value[1]),
        num(value[2]),
        num(value[3]),
        num(value[4]),
      ]
      if (c[0] + c[1] + c[2] + c[3] === 0) continue
      const target = out[day] ?? (out[day] = {})
      target[model] = c
    }
  }
  return out
}

export function sanitizeStoreValue(raw: unknown): DayLedger {
  if (!raw || typeof raw !== 'object') return emptyDays()
  const value = raw as Record<string, unknown>
  return sanitizeDays(value.days ?? raw)
}

export function two(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0)
}

export function isDay(day: string): boolean {
  const d = parseDay(day)
  return d !== null && dayOf(d.getTime()) === day
}

export function isMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
}

export function addDays(day: string, n: number): string {
  const d = parseDay(day)
  if (!d) return day
  d.setDate(d.getDate() + n)
  return dayOf(d.getTime())
}

export function weekStartOf(day: string): string {
  const d = parseDay(day)
  if (!d) return day
  const weekday = d.getDay()
  const diff = weekday === 0 ? -6 : 1 - weekday
  return addDays(day, diff)
}

export function monthOf(day: string): string {
  return day.slice(0, 7)
}

export function addMonths(month: string, n: number): string {
  const [year, m] = month.split('-').map(Number)
  const d = new Date(year, m - 1 + n, 1, 12, 0, 0)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}`
}

export function monthEnd(month: string): string {
  const [year, m] = month.split('-').map(Number)
  // JS month index `m` is the next month; day 0 is the last day of `month`.
  return dayOf(new Date(year, m, 0, 12, 0, 0).getTime())
}

export function summaryOf(c: Counts | undefined): TokenSummary {
  const value = c ?? ZERO
  return {
    i: value[0],
    o: value[1],
    cr: value[2],
    cc: value[3],
    n: value[4],
    total: value[0] + value[1] + value[2] + value[3],
  }
}

export function sumRange(days: DayLedger, from: string, to: string): Counts {
  const sum: Counts = [0, 0, 0, 0, 0]
  for (const day of Object.keys(days)) {
    if (day < from || day > to) continue
    const models = days[day]
    if (!models) continue
    for (const model of Object.keys(models)) addTo(sum, models[model])
  }
  return sum
}

export function sumAll(days: DayLedger): Counts {
  return sumRange(days, '0000-01-01', '9999-12-31')
}

export function totalsByModel(
  days: DayLedger,
  from: string,
  to: string,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const day of Object.keys(days)) {
    if (day < from || day > to) continue
    const models = days[day]
    if (!models) continue
    for (const model of Object.keys(models)) {
      const c = models[model]
      out[model] = (out[model] ?? 0) + c[0] + c[1] + c[2] + c[3]
    }
  }
  return out
}

export function modelsInRange(
  days: DayLedger,
  from: string,
  to: string,
): TokenModelRow[] {
  const byModel: Record<string, Counts> = {}
  for (const day of Object.keys(days)) {
    if (day < from || day > to) continue
    const models = days[day]
    if (!models) continue
    for (const model of Object.keys(models)) {
      const target = byModel[model] ?? (byModel[model] = [0, 0, 0, 0, 0])
      addTo(target, models[model])
    }
  }

  return Object.keys(byModel)
    .map(model => ({ model, ...summaryOf(byModel[model]) }))
    .filter(row => row.total > 0)
    .sort((a, b) => b.total - a.total || (a.model < b.model ? -1 : 1))
}

export function dayPoint(days: DayLedger, date: string): TokenDayPoint {
  const models = days[date] ?? {}
  return {
    date,
    ...summaryOf(sumRangeDay(models)),
    models: totalsByModel(days, date, date),
  }
}

function sumRangeDay(models: Record<string, Counts>): Counts {
  const sum: Counts = [0, 0, 0, 0, 0]
  for (const model of Object.keys(models)) addTo(sum, models[model])
  return sum
}

export function buildSnapshot(
  days: DayLedger,
  now: number,
  meta: TokenMeta,
): TokenSnapshot {
  const today = dayOf(now)
  const weekStart = weekStartOf(today)
  const month = monthOf(today)
  const prevWeekStart = addDays(weekStart, -7)
  const prevWeekEnd = addDays(weekStart, -1)
  const prevMonth = addMonths(month, -1)
  const prevDay = addDays(today, -1)

  const daily: TokenDayPoint[] = []
  for (let n = 89; n >= 0; n--) daily.push(dayPoint(days, addDays(today, -n)))

  const monthly: TokenMonthRow[] = []
  for (let n = 11; n >= 0; n--) {
    const value = addMonths(month, -n)
    const from = `${value}-01`
    const to = monthEnd(value)
    monthly.push({
      month: value,
      ...summaryOf(sumRange(days, from, to)),
      models: totalsByModel(days, from, to),
    })
  }

  return {
    v: 1,
    generatedAt: now,
    today,
    weekStart,
    month,
    ranges: {
      today: summaryOf(sumRange(days, today, today)),
      prevDay: summaryOf(sumRange(days, prevDay, prevDay)),
      week: summaryOf(sumRange(days, weekStart, today)),
      prevWeek: summaryOf(sumRange(days, prevWeekStart, prevWeekEnd)),
      month: summaryOf(sumRange(days, `${month}-01`, today)),
      prevMonth: summaryOf(sumRange(days, `${prevMonth}-01`, monthEnd(prevMonth))),
      all: summaryOf(sumAll(days)),
    },
    models: {
      today: modelsInRange(days, today, today),
      week: modelsInRange(days, weekStart, today),
      month: modelsInRange(days, `${month}-01`, today),
      all: modelsInRange(days, '0000-01-01', '9999-12-31'),
    },
    daily,
    monthly,
    meta,
  }
}

export function emptySnapshot(): TokenSnapshot {
  return buildSnapshot({}, Date.now(), {
    backfill: 'none',
    sessions: 0,
    version: 1,
  })
}
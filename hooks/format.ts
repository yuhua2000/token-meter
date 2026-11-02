import type { TokenModelRow, TokenSummary } from '../types'
import {
  addDays,
  addMonths,
  dayPoint,
  monthEnd,
  monthOf,
  totalsByModel,
} from './ledger'
import type { DayLedger } from './ledger'

type Align = 'l' | 'r'

export function formatInt(n: number): string {
  const value = Math.round(n)
  const sign = value < 0 ? '-' : ''
  const digits = String(Math.abs(value))
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return sign + out
}

function compact(value: number): string {
  if (value >= 100) return String(Math.round(value))
  if (value >= 10) {
    const text = (Math.round(value * 10) / 10).toFixed(1)
    return text.endsWith('.0') ? text.slice(0, -2) : text
  }
  const text = (Math.round(value * 10) / 10).toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

export function formatTokens(n: number): string {
  const value = Math.round(n)
  if (value >= 1_000_000_000) return `${compact(value / 1_000_000_000)}B`
  if (value >= 1_000_000) return `${compact(value / 1_000_000)}M`
  if (value >= 1_000) return `${compact(value / 1_000)}k`
  return String(value)
}

export function pct(value: number, total: number): string {
  if (total <= 0) return '—'
  const p = (value / total) * 100
  if (p >= 10) return `${Math.round(p)}%`
  return `${(Math.round(p * 10) / 10).toFixed(1)}%`
}

export function cacheHit(s: TokenSummary): string {
  const base = s.i + s.cr + s.cc
  if (base <= 0) return '—'
  return `${(Math.round((s.cr / base) * 1000) / 10).toFixed(1)}%`
}

export function deltaPct(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? null : 0
  return ((current - previous) / previous) * 100
}

export function deltaText(current: number, previous: number): string {
  if (previous <= 0) return current > 0 ? '新增' : '持平'
  const value = ((current - previous) / previous) * 100
  const sign = value >= 0 ? '+' : ''
  return `${sign}${(Math.round(value * 10) / 10).toFixed(1)}%`
}

export function summaryLine(label: string, s: TokenSummary): string {
  return `${label}  ${formatTokens(s.total)} tok · ${formatInt(s.n)} 次请求 · 缓存命中 ${cacheHit(s)}`
}

export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    width += isWide(cp) ? 2 : 1
  }
  return width
}

function isWide(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  )
}

function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text
}

export function table(
  headers: string[],
  aligns: Align[],
  rows: string[][],
): string {
  const widths = headers.map((header, index) =>
    Math.max(
      displayWidth(header),
      ...rows.map(row => displayWidth(row[index] ?? '')),
    ),
  )

  const line = (cells: string[]): string =>
    cells
      .map((cell, index) =>
        aligns[index] === 'r' ? padStart(cell, widths[index]) : padEnd(cell, widths[index]),
      )
      .join('  ')

  const rule = widths.map(width => '─'.repeat(width)).join('  ')
  return [line(headers), rule, ...rows.map(line)].join('\n')
}

export function shortModel(model: string, max = 34): string {
  if (displayWidth(model) <= max) return model
  let out = ''
  for (const char of model) {
    if (displayWidth(out + char) > max - 1) break
    out += char
  }
  return `${out}…`
}

export function modelTable(
  rows: TokenModelRow[],
  total: number,
  maxModelWidth = 34,
): string {
  if (rows.length === 0) return '暂无数据'
  return table(
    ['模型', '请求', '输入', '缓存写', '缓存读', '输出', '合计', '占比'],
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
    rows.map(row => [
      shortModel(row.model, maxModelWidth),
      formatInt(row.n),
      formatTokens(row.i),
      formatTokens(row.cc),
      formatTokens(row.cr),
      formatTokens(row.o),
      formatTokens(row.total),
      pct(row.total, total),
    ]),
  )
}

export function dayTable(
  days: DayLedger,
  from: string,
  to: string,
  maxRows = 40,
): string {
  if (from > to) return '暂无数据'
  const rows: string[][] = []
  let cursor = from
  let guard = 0
  while (cursor <= to && guard < maxRows) {
    const point = dayPoint(days, cursor)
    rows.push([
      cursor,
      formatInt(point.n),
      formatTokens(point.i),
      formatTokens(point.cc),
      formatTokens(point.cr),
      formatTokens(point.o),
      formatTokens(point.total),
    ])
    cursor = addDays(cursor, 1)
    guard++
  }
  if (cursor <= to) rows.push(['…', '', '', '', '', '', ''])
  return table(
    ['日期', '请求', '输入', '缓存写', '缓存读', '输出', '合计'],
    ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    rows,
  )
}

export function matrixTable(
  days: DayLedger,
  from: string,
  to: string,
  maxModels = 5,
): string {
  if (from > to) return '暂无数据'
  const totals = Object.entries(totalsByModel(days, from, to))
    .sort((a, b) => b[1] - a[1])
    .map(([model]) => model)
  const shown = totals.slice(0, maxModels)
  const hasOther = totals.length > shown.length

  const headers = ['日期', ...shown.map(model => shortModel(model, 14)), '合计']
  if (hasOther) headers.splice(headers.length - 1, 0, '其他')

  const rows: string[][] = []
  let cursor = from
  let guard = 0
  while (cursor <= to && guard < 40) {
    const point = dayPoint(days, cursor)
    const values = shown.map(model => formatTokens(point.models[model] ?? 0))
    if (hasOther) {
      const other = totals
        .slice(maxModels)
        .reduce((sum, model) => sum + (point.models[model] ?? 0), 0)
      values.push(formatTokens(other))
    }
    values.push(formatTokens(point.total))
    rows.push([cursor, ...values])
    cursor = addDays(cursor, 1)
    guard++
  }

  const aligns: Align[] = ['l', ...headers.slice(1).map(() => 'r' as Align)]
  return table(headers, aligns, rows)
}

export function monthTable(days: DayLedger, today: string, count = 12): string {
  const rows: string[][] = []
  const current = monthOf(today)
  for (let n = count - 1; n >= 0; n--) {
    const month = addMonths(current, -n)
    const from = `${month}-01`
    const to = monthEnd(month)
    let total = 0
    let requests = 0
    let input = 0
    let cacheWrite = 0
    let cacheRead = 0
    let output = 0
    for (const day of Object.keys(days)) {
      if (day < from || day > to) continue
      const models = days[day]
      for (const model of Object.keys(models)) {
        const c = models[model]
        input += c[0]
        output += c[1]
        cacheRead += c[2]
        cacheWrite += c[3]
        requests += c[4]
        total += c[0] + c[1] + c[2] + c[3]
      }
    }
    rows.push([
      month,
      formatInt(requests),
      formatTokens(input),
      formatTokens(cacheWrite),
      formatTokens(cacheRead),
      formatTokens(output),
      formatTokens(total),
    ])
  }
  return table(
    ['月份', '请求', '输入', '缓存写', '缓存读', '输出', '合计'],
    ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    rows,
  )
}

export function bar(value: number, max: number, width = 16): string {
  if (value <= 0 || max <= 0) return ''
  const filled = Math.max(1, Math.round((value / max) * width))
  return '█'.repeat(filled)
}
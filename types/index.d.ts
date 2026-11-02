export type TokenCounts = [number, number, number, number, number]

export type TokenSummary = {
  i: number
  o: number
  cr: number
  cc: number
  n: number
  total: number
}

export type TokenModelRow = TokenSummary & { model: string }

export type TokenDayPoint = TokenSummary & {
  date: string
  models: Record<string, number>
}

export type TokenMonthRow = TokenSummary & {
  month: string
  models: Record<string, number>
}

export type TokenRanges = {
  today: TokenSummary
  prevDay: TokenSummary
  week: TokenSummary
  prevWeek: TokenSummary
  month: TokenSummary
  prevMonth: TokenSummary
  all: TokenSummary
}

export type TokenModels = {
  today: TokenModelRow[]
  week: TokenModelRow[]
  month: TokenModelRow[]
  all: TokenModelRow[]
}

export type TokenBackfillState = 'none' | 'running' | 'done' | 'error'

export type TokenMeta = {
  backfill: TokenBackfillState
  backfillError?: string
  sessions: number
  version: number
}

export type TokenSnapshot = {
  v: number
  generatedAt: number
  today: string
  weekStart: string
  month: string
  ranges: TokenRanges
  models: TokenModels
  daily: TokenDayPoint[]
  monthly: TokenMonthRow[]
  meta: TokenMeta
}

declare module 'claude-code' {
  interface PluginState {
    'token-meter': { snapshot: Shaped<TokenSnapshot> }
  }
}
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TokenMeta, TokenSnapshot } from '../types'
import {
  addDays,
  addMonths,
  addUsage,
  buildSnapshot,
  dayOf,
  emptyDays,
  emptySnapshot,
  isDay,
  isMonth,
  mergeDays,
  modelsInRange,
  monthEnd,
  monthOf,
  sanitizeStoreValue,
  sumAll,
  sumRange,
  summaryOf,
  weekStartOf,
} from './ledger'
import type { DayLedger } from './ledger'
import {
  bar,
  dayTable,
  deltaText,
  formatInt,
  formatTokens,
  matrixTable,
  modelTable,
  monthTable,
  shortModel,
  summaryLine,
} from './format'

const PANE_ID = 'token-meter'
const SNAPSHOT_SHAPE = 'snapshot-1'
const BACKFILL_STALE_MS = 10 * 60 * 1000

const snapshot = atom(
  { plugin: 'token-meter', key: 'snapshot' } as const,
  emptySnapshot(),
  { shape: SNAPSHOT_SHAPE },
)

let sessionId = ''
let sessionDays: DayLedger = emptyDays()
let pending: DayLedger = emptyDays()
let statusOn = true
let backfillRunning = false
let serverStarted = false
let serverUrl = ''
let lastDebug = ''

const HELP = `Token 用量统计

/tokens                 今日按模型
/tokens day [日期]      指定日，如 2026-10-30
/tokens week [last]     本周或上周，逐天 + 按模型
/tokens month [last]    本月或上月，逐天 + 按模型 + 矩阵
/tokens model [范围]    按模型，范围 today|week|month|all
/tokens matrix [范围]   日期 × 模型合计矩阵
/tokens all             全部历史 + 近 12 个月
/tokens pane            打开常驻面板
/tokens serve [端口]    启动浏览器看板，默认 8787
/tokens html            导出单文件 HTML 快照
/tokens backfill        导入历史 transcript（--force 重跑）
/tokens status on|off   状态栏开关`

type BackfillMeta = {
  state: string
  startedAt?: number
  cutoff?: number
  error?: string
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens',
      description: 'Token 用量统计：按模型、天、周、月',
      argumentHint: '[today|day|week|month|model|matrix|all|pane|serve|status|help]',
    })

    sessionId = await $.session.id()
    sessionDays = sanitizeStoreValue(await $.store.get(`s:${sessionId}`))

    const savedStatus = await $.store.get('meta:status')
    statusOn = savedStatus !== false

    await safeRefresh($)

    const backfill = await readBackfillMeta($)
    const isStale =
      backfill.state === 'running' &&
      Date.now() - (backfill.startedAt ?? 0) > BACKFILL_STALE_MS
    if (backfill.state === 'none' || isStale) {
      void startBackfill($, false).catch(error =>
        logDebug($, `token-meter: backfill start failed: ${String(error)}`),
      )
    }

    return next(e)
  })

  // `turn.step` streams: the hook must be an async generator.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage) {
      const usage = result.usage
      const day = dayOf(await $.clock.now())
      addUsage(pending, day, usage.model, usage)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await safeFlush($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await safeFlush($)
    return next(e)
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    const sub = (args[0] ?? 'today').toLowerCase()
    const now = await $.clock.now()
    const today = dayOf(now)
    const { days, sessions } = await scanAll($)

    switch (sub) {
      case 'help':
        return { text: HELP }

      case 'today': {
        const total = summaryOf(sumRange(days, today, today))
        const rows = modelsInRange(days, today, today)
        return {
          text: [
            `Token 用量 · 今日 ${today}`,
            summaryLine('今日', total),
            '',
            modelTable(rows, total.total),
            '',
            '合计 = 输入(未缓存) + 缓存写 + 缓存读 + 输出',
          ].join('\n'),
        }
      }

      case 'day': {
        const day = args[1] ?? today
        if (!isDay(day)) return { text: `日期格式不正确：${day}\n用法：/tokens day 2026-10-30` }
        const total = summaryOf(sumRange(days, day, day))
        const previous = summaryOf(sumRange(days, addDays(day, -1), addDays(day, -1)))
        return {
          text: [
            `Token 用量 · ${day}`,
            `${summaryLine(day, total)} · 环比 ${deltaText(total.total, previous.total)}`,
            '',
            modelTable(modelsInRange(days, day, day), total.total),
          ].join('\n'),
        }
      }

      case 'week': {
        let start = weekStartOf(today)
        if (args[1] === 'last') start = addDays(start, -7)
        else if (args[1] && isDay(args[1])) start = weekStartOf(args[1])
        else if (args[1]) return { text: `参数不正确：${args[1]}\n用法：/tokens week [last|2026-10-30]` }

        const thisWeek = weekStartOf(today)
        const lastWeek = addDays(thisWeek, -7)
        const end = start === thisWeek ? today : addDays(start, 6)
        const label = start === thisWeek ? '本周' : start === lastWeek ? '上周' : '周'
        const total = summaryOf(sumRange(days, start, end))
        const previousStart = addDays(start, -7)
        const previous = summaryOf(sumRange(days, previousStart, addDays(previousStart, 6)))

        return {
          text: [
            `Token 用量 · ${label} ${start} ~ ${end}`,
            `${summaryLine(label, total)} · 环比 ${deltaText(total.total, previous.total)}`,
            '',
            dayTable(days, start, end),
            '',
            modelTable(modelsInRange(days, start, end), total.total),
          ].join('\n'),
        }
      }

      case 'month': {
        let month = monthOf(today)
        if (args[1] === 'last') month = addMonths(month, -1)
        else if (args[1] && isMonth(args[1])) month = args[1]
        else if (args[1]) return { text: `参数不正确：${args[1]}\n用法：/tokens month [last|2026-10]` }

        const start = `${month}-01`
        const thisMonth = monthOf(today)
        const lastMonth = addMonths(thisMonth, -1)
        const end = month === thisMonth ? today : monthEnd(month)
        const label = month === thisMonth ? '本月' : month === lastMonth ? '上月' : month
        const total = summaryOf(sumRange(days, start, end))
        const previousMonth = addMonths(month, -1)
        const previous = summaryOf(sumRange(days, `${previousMonth}-01`, monthEnd(previousMonth)))

        return {
          text: [
            `Token 用量 · ${month}（${start} ~ ${end}）`,
            `${summaryLine(label, total)} · 环比 ${deltaText(total.total, previous.total)}`,
            '',
            dayTable(days, start, end),
            '',
            modelTable(modelsInRange(days, start, end), total.total),
            '',
            '日期 × 模型（合计）',
            matrixTable(days, start, end),
          ].join('\n'),
        }
      }

      case 'model': {
        const range = (args[1] ?? 'month').toLowerCase()
        const bounds = boundsFor(range, today)
        if (!bounds) return { text: `范围不正确：${range}\n用法：/tokens model today|week|month|all` }
        const total = summaryOf(sumRange(days, bounds.from, bounds.to))
        return {
          text: [
            `Token 用量 · 按模型 · ${bounds.label}`,
            summaryLine(bounds.label, total),
            '',
            modelTable(modelsInRange(days, bounds.from, bounds.to), total.total),
          ].join('\n'),
        }
      }

      case 'matrix': {
        const range = (args[1] ?? 'month').toLowerCase()
        const bounds = boundsFor(range === 'today' ? 'today' : range, today)
        if (!bounds) return { text: `范围不正确：${range}\n用法：/tokens matrix today|week|month` }
        return {
          text: [
            `Token 用量 · 日期 × 模型 · ${bounds.label}`,
            '',
            matrixTable(days, bounds.from, bounds.to),
          ].join('\n'),
        }
      }

      case 'all': {
        const total = summaryOf(sumAll(days))
        return {
          text: [
            `Token 用量 · 全部历史（${formatInt(sessions)} 个会话记录）`,
            summaryLine('全部', total),
            '',
            modelTable(modelsInRange(days, '0000-01-01', '9999-12-31'), total.total),
            '',
            '近 12 个月',
            monthTable(days, today),
          ].join('\n'),
        }
      }

      case 'pane': {
        await safeRefresh($)
        const opened = await $.ui.open({ id: PANE_ID, title: 'Token 用量' })
        return {
          text: opened.isPlaced
            ? '已打开 Token 用量面板。'
            : '面板已登记，但当前界面宽度不足或没有可用面板；可用 /tokens 查看文本统计。',
        }
      }

      case 'serve': {
        const port = parsePort(args[1])
        if (port === null) return { text: `端口不正确：${args[1]}\n用法：/tokens serve [8787]` }
        await safeRefresh($)
        const url = await startServer($, port)
        return {
          text: url.startsWith('http')
            ? `浏览器看板已启动：${url}\nWSL2 下用 Windows 浏览器打开 localhost 即可；打不开可换端口。\n看板服务随当前会话运行，会话结束后停止；需要留存可运行 /tokens html。`
            : url,
        }
      }

      case 'html': {
        await safeRefresh($)
        try {
          const path = await exportHtml($, await read($, snapshot))
          return { text: `已导出静态快照：${path}\n浏览器直接打开该文件即可。` }
        } catch (error) {
          return { text: `导出失败：${String(error)}` }
        }
      }

      case 'backfill': {
        const force = args.includes('--force')
        return { text: await startBackfill($, force) }
      }

      case 'status': {
        const value = (args[1] ?? '').toLowerCase()
        if (value !== 'on' && value !== 'off') {
          return { text: '用法：/tokens status on|off' }
        }
        statusOn = value === 'on'
        await $.store.set('meta:status', statusOn)
        applyStatus($, await read($, snapshot))
        return { text: statusOn ? '状态栏已开启。' : '状态栏已关闭。' }
      }

      default:
        return { text: `未知子命令：${sub}\n\n${HELP}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const data = await read($, snapshot)
    const room = Math.max(4, (e.viewport?.rows ?? 24) - 12)
    const models = data.models.today.slice(0, room)
    const more = data.models.today.length > models.length
    const last7 = data.daily.slice(-7)
    const maxDay = Math.max(1, ...last7.map(day => day.total))

    return (
      <Box flexDirection="column">
        <Text weight="semibold">Token 用量 · {data.today || '—'}</Text>
        <Text dimColor>
          今日 {formatTokens(data.ranges.today.total)} · 本周{' '}
          {formatTokens(data.ranges.week.total)} · 本月 {formatTokens(data.ranges.month.total)}
        </Text>
        <Text dimColor>浏览器看板：/tokens serve</Text>
        <Text> </Text>
        {models.length === 0 ? (
          <Text dimColor>暂无数据</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>
              模型{more ? `（前 ${models.length} 个）` : ''}          请求      合计
            </Text>
            {models.map(row => (
              <Text key={row.model} mono>
                {shortModel(row.model, 26)}  {formatInt(row.n).padStart(6)}{' '}
                {formatTokens(row.total).padStart(8)}
              </Text>
            ))}
          </Box>
        )}
        <Text> </Text>
        <Text dimColor>近 7 天</Text>
        <Box flexDirection="column">
          {last7.map(day => (
            <Text key={day.date} mono>
              {day.date.slice(5)}  {bar(day.total, maxDay, 14).padEnd(14)}{' '}
              {formatTokens(day.total)}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}

function boundsFor(
  range: string,
  today: string,
): { from: string; to: string; label: string } | null {
  if (range === 'today') return { from: today, to: today, label: `今日 ${today}` }
  if (range === 'week') {
    const from = weekStartOf(today)
    return { from, to: today, label: `本周 ${from} ~ ${today}` }
  }
  if (range === 'month') {
    const month = monthOf(today)
    return { from: `${month}-01`, to: today, label: `本月 ${month}` }
  }
  if (range === 'all') {
    return { from: '0000-01-01', to: '9999-12-31', label: '全部历史' }
  }
  return null
}

function parsePort(value: string | undefined): number | null {
  if (!value) return 8787
  if (!/^\d+$/.test(value)) return null
  const port = Number(value)
  return port >= 1024 && port <= 65535 ? port : null
}

async function pythonCommand($: EngineInterface): Promise<string | null> {
  for (const exe of ['python3', 'python']) {
    try {
      const result = await $.process.run([exe, '--version'], { timeoutMs: 5000 })
      if (
        result.exitCode === 0 &&
        `${result.stdout}${result.stderr}`.includes('Python 3')
      ) {
        return exe
      }
    } catch {
      // Try the next executable.
    }
  }
  return null
}

async function homeDir($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  if (home) return home
  const profile = await $.env.get('USERPROFILE')
  return profile ?? ''
}

function logDebug($: EngineInterface, text: string): void {
  if (text === lastDebug) return
  lastDebug = text
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // A debug line must never break a turn.
  }
}

async function scanAll(
  $: EngineInterface,
): Promise<{ days: DayLedger; sessions: number }> {
  const days = emptyDays()
  let sessions = 0
  for (const key of await $.store.keys()) {
    if (!key.startsWith('s:')) continue
    sessions++
    mergeDays(days, sanitizeStoreValue(await $.store.get(key)))
  }
  mergeDays(days, sanitizeStoreValue(await $.store.get('backfill:v1')))
  return { days, sessions }
}

async function readBackfillMeta($: EngineInterface): Promise<BackfillMeta> {
  const raw = await $.store.get('meta:backfill')
  if (!raw || typeof raw !== 'object') return { state: 'none' }
  const value = raw as Record<string, unknown>
  return {
    state: typeof value.state === 'string' ? value.state : 'none',
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : undefined,
    cutoff: typeof value.cutoff === 'number' ? value.cutoff : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
  }
}

function tokenMeta(backfill: BackfillMeta, sessions: number): TokenMeta {
  const state =
    backfill.state === 'running' || backfill.state === 'done' || backfill.state === 'error'
      ? backfill.state
      : 'none'
  return {
    backfill: state,
    backfillError: backfill.error,
    sessions,
    version: 1,
  }
}

async function refresh($: EngineInterface): Promise<TokenSnapshot> {
  const { days, sessions } = await scanAll($)
  const now = await $.clock.now()
  const data = buildSnapshot(days, now, tokenMeta(await readBackfillMeta($), sessions))
  await update($, snapshot, () => data)
  await writeDashboard($, data)
  applyStatus($, data)
  return data
}

async function safeRefresh($: EngineInterface): Promise<void> {
  try {
    await refresh($)
  } catch (error) {
    logDebug($, `token-meter: refresh failed: ${String(error)}`)
  }
}

async function flush($: EngineInterface): Promise<void> {
  if (Object.keys(pending).length > 0) {
    mergeDays(sessionDays, pending)
    pending = emptyDays()
  }
  if (sessionId) {
    await $.store.set(`s:${sessionId}`, { v: 1, days: sessionDays })
  }
  await refresh($)
}

async function safeFlush($: EngineInterface): Promise<void> {
  try {
    await flush($)
  } catch (error) {
    logDebug($, `token-meter: flush failed: ${String(error)}`)
  }
}

function applyStatus($: EngineInterface, data: TokenSnapshot): void {
  if (!statusOn) {
    $.ui.status(undefined)
    return
  }
  $.ui.status(
    `今日 ${formatTokens(data.ranges.today.total)} tok · 本周 ${formatTokens(data.ranges.week.total)}`,
  )
}

async function writeDashboard($: EngineInterface, data: TokenSnapshot): Promise<void> {
  const home = await homeDir($)
  if (!home) return
  try {
    await $.fs.write(
      `${home}/.claude/token-meter/dashboard.json`,
      JSON.stringify(data),
    )
  } catch (error) {
    logDebug($, `token-meter: dashboard write failed: ${String(error)}`)
  }
}

async function startBackfill(
  $: EngineInterface,
  force: boolean,
): Promise<string> {
  if (backfillRunning) return '历史导入已经在运行。'

  const meta = await readBackfillMeta($)
  if (!force && meta.state === 'done') return '历史数据已经导入。'
  if (!force && meta.state === 'running') {
    const age = Date.now() - (meta.startedAt ?? 0)
    if (age < BACKFILL_STALE_MS) return '历史导入正在运行。'
  }
  if (!force && meta.state === 'error') {
    return `上次历史导入失败：${meta.error ?? '未知错误'}\n可用 /tokens backfill --force 重试。`
  }

  const home = await homeDir($)
  if (!home) return '无法确定 HOME，跳过历史导入。'

  const now = await $.clock.now()
  const cutoff = force && typeof meta.cutoff === 'number' ? meta.cutoff : now
  backfillRunning = true
  await $.store.set('meta:backfill', {
    v: 1,
    state: 'running',
    startedAt: now,
    cutoff,
  })
  await safeRefresh($)

  void (async () => {
    try {
      const script = `${$.plugin.root}/scripts/backfill.py`
      const projects = `${home}/.claude/projects`
      const args = [script, '--projects', projects, '--before', String(cutoff)]
      const exe = await pythonCommand($)
      if (!exe) throw new Error('找不到可用的 Python 3')
      const result = await $.process.run([exe, ...args], { timeoutMs: 180000 })

      if (result.exitCode !== 0) {
        throw new Error(
          `backfill 退出码 ${result.exitCode}: ${(result.stderr || '').slice(0, 300)}`,
        )
      }
      const parsed = JSON.parse(result.stdout) as {
        days?: unknown
        stats?: unknown
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.days) {
        throw new Error('backfill 输出格式不正确')
      }

      await $.store.set('backfill:v1', { v: 1, days: parsed.days })
      await $.store.set('meta:backfill', {
        v: 1,
        state: 'done',
        at: await $.clock.now(),
        cutoff,
        stats: parsed.stats ?? {},
      })
    } catch (error) {
      const message = String(
        error instanceof Error ? error.message : error,
      ).slice(0, 500)
      await $.store
        .set('meta:backfill', {
          v: 1,
          state: 'error',
          at: Date.now(),
          cutoff,
          error: message,
        })
        .catch(() => {})
      logDebug($, `token-meter: backfill failed: ${message}`)
    } finally {
      backfillRunning = false
      await safeRefresh($)
    }
  })()

  return '已开始后台导入历史 transcript，完成后统计会自动刷新。'
}

async function startServer(
  $: EngineInterface,
  port: number,
): Promise<string> {
  const url = `http://127.0.0.1:${port}`
  if (serverStarted) return serverUrl || url

  const home = await homeDir($)
  if (!home) return '无法确定 HOME，无法启动浏览器看板。'
  const exe = await pythonCommand($)
  if (!exe) return '找不到可用的 Python 3，无法启动浏览器看板。'
  const script = `${$.plugin.root}/scripts/serve.py`
  serverStarted = true
  serverUrl = url

  void (async () => {
    try {
      const stream = $.process.spawn({
        argv: [exe, script, '--host', '127.0.0.1', '--port', String(port)],
        cwd: home,
      })
      for await (const chunk of stream) {
        if (chunk.stream === 'stderr' && chunk.text.trim()) {
          logDebug($, `token-meter server: ${chunk.text.trim()}`)
        }
      }
      const code = (await stream.result).code
      logDebug($, `token-meter: server exited with code ${String(code)}`)
    } catch (error) {
      logDebug($, `token-meter: server failed: ${String(error)}`)
    } finally {
      serverStarted = false
      serverUrl = ''
    }
  })()

  return url
}

async function exportHtml(
  $: EngineInterface,
  data: TokenSnapshot,
): Promise<string> {
  const home = await homeDir($)
  if (!home) throw new Error('无法确定 HOME')
  const template = await $.fs.read(`${$.plugin.root}/web/index.html`)
  const marker = '/*__TOKEN_METER_DATA__*/ null'
  if (!template.includes(marker)) throw new Error('web/index.html 缺少数据占位符')
  const payload = JSON.stringify(data).replace(/</g, '\\u003c')
  const html = template.replace(marker, () => payload)
  const path = `${home}/.claude/token-meter/report.html`
  await $.fs.write(path, html)
  return path
}
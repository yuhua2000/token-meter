# token-meter

本地 Claude Code Token 用量统计：按模型、按天、按周、按月，附带一个轻量的浏览器看板。

## 启用

这个目录是一个 Claude Code mod（插件）。在会话里第一次写入文件后，Claude Code 会询问是否开启本会话中编写的 mods；选择“开启它们”，mod 会在该回合结束时加载。没有被热加载时，可用 `claude --plugin-dir <此目录>` 启动会话，或把目录加入 `CLAUDE_CODE_PLUGIN_DIRS`。

## 命令

| 命令 | 内容 |
| --- | --- |
| `/tokens` | 今日按模型 |
| `/tokens day [日期]` | 指定日，例如 `2026-10-30` |
| `/tokens week [last]` | 本周或上周：逐天 + 按模型 |
| `/tokens month [last]` | 本月或上月：逐天 + 按模型 + 矩阵 |
| `/tokens model [today\|week\|month\|all]` | 按模型 |
| `/tokens matrix [today\|week\|month]` | 日期 × 模型矩阵 |
| `/tokens all` | 全部历史 + 近 12 个月 |
| `/tokens pane` | 打开常驻面板 |
| `/tokens serve [端口]` | 启动浏览器看板，默认 `http://127.0.0.1:8787` |
| `/tokens html` | 导出单文件静态快照到 `~/.claude/token-meter/report.html` |
| `/tokens backfill [--force]` | 后台导入历史 transcript |
| `/tokens status on\|off` | 状态栏开关 |

状态栏默认显示今日和本周合计。

## 浏览器看板

运行 `/tokens serve`，然后用 Windows 浏览器打开 `http://127.0.0.1:8787`。WSL2 的 localhost 转发通常可直接使用；如果打不开，改用 WSL 的 IP 地址，或换一个端口。看板服务随当前会话运行，会话结束后停止；需要长期留存时改用 `/tokens html`。看板每 5 秒读取 `~/.claude/token-meter/dashboard.json`，没有外部依赖，也不访问网络。

想在没有服务的情况下分享或留档，运行 `/tokens html`，直接打开生成的 `report.html` 即可。

## 统计口径

- 实时部分：挂在 `turn.step` 上，每个模型请求累加一次 `usage`，包含子代理和自定义网关返回的模型名。
- 历史部分：`scripts/backfill.py` 流式读取 `~/.claude/projects/**/*.jsonl`，按 `requestRef`（缺失时用 `message.id` / `uuid`）去重，跳过 `message.model == "<synthetic>"` 的记录。transcript 里同一条响应会重复写入，因此去重是必要的。
- 回填有一个 `--before` 截止时间：只导入启用插件之前的记录，启用后的记录由实时钩子负责，两边不重叠。
- 合计 = 未缓存输入 + 缓存写 + 缓存读 + 输出。缓存命中率 = 缓存读 /（未缓存输入 + 缓存读 + 缓存写）。
- 统计允许少量误差：重试、标题生成、压缩等内部调用可能落在 transcript 与 usage 钩子的差异里，通常是个位数百分比。
- 数据只在本机：插件 store（`~/.claude` 下）、`dashboard.json`、以及 Python 标准库 HTTP 服务。

## 依赖

文本统计、面板、状态栏和静态导出不需要额外依赖。历史回填和浏览器看板需要一个可用的 Python 3（`python3`，或 Windows 上的 `python`）；两者都只用标准库。

## 摘要（English）

token-meter is a local Claude Code mod that counts token usage by model and
calendar day. It records each API request's usage from the turn stream,
backfills historical transcripts with de-duplication, and renders totals for
today, the current week, the current month and all history. A small optional
Python server exposes a single-file browser dashboard on port 8787. All data
stays on the machine, and the historical parser is intentionally approximate
within a few percent.

## 文件

- `hooks/register.tsx` — 命令、实时采集、状态栏、面板、回填和看板启动
- `hooks/ledger.ts` — 按天/模型的聚合、日期运算、快照
- `hooks/format.ts` — 终端表格与数字格式
- `scripts/backfill.py` — 历史 transcript 解析
- `scripts/serve.py` — 标准库 HTTP 服务
- `web/index.html` — 单文件看板（无 CDN）
- `types/index.d.ts` — 插件状态契约

## 校验

```sh
claude plugin validate .
```

注意：如果系统 `node` 较旧（例如 v16），`claude plugin validate` 可能因缺少 `TransformStream` 而失败；用较新的 Node 运行时执行该命令即可。
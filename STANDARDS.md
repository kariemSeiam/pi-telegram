# Pi-Telegram — Production Standards

> *The octopus doesn't follow standards. It becomes them.*

---

## Identity

**What**: Pi-Telegram Bridge — Telegram ↔ Pi Coding Agent via RPC  
**Repo**: `kariemSeiam/pi-telegram-fork` (fork of `Ziphyrien/Pi-Telegram`)  
**Version**: 0.3.5  
**Runtime**: Node.js 16+ (ESM), TypeScript strict  
**LOC**: 6,594 across 20 source files  
**Deploy**: `npm install -g .` → `pitg` binary  
**Process**: `pitg.service` (systemd)  
**Config**: `~/.pi/telegram/settings.json`

---

## Architecture

```
src/
├── main.ts              # Entry — void runApp()
├── app/
│   ├── config.ts        # Settings CRUD, normalization, write queue
│   ├── paths.ts         # ~/.pi/telegram/{settings,sessions,cron,workspace}
│   └── runtime.ts       # Bot assembly, polling runner, auto-restart, shutdown
├── pi/
│   ├── types.ts         # ModelInfo, SessionStats, ContextUsage, TokenStats
│   ├── pool.ts          # PiPool — one PiRpc per chat, idle reaper, spawn/kill
│   └── rpc.ts           # PiRpc — subprocess wrapper, prompt queue, streaming
├── telegram/
│   ├── create-bot.ts    # 2802 lines — commands, handlers, middleware, AI prompt
│   ├── menu.ts          # Grammy Menu — model selector, stream toggle, thinking levels
│   ├── format.ts        # Markdown → Telegram HTML (markdown-it + sanitize-html)
│   ├── attachment.ts    # <tg-attachment> parser — file_id, URL, local, base64 upload
│   ├── reply.ts         # <tg-reply> parser — quote targeting, message history
│   ├── status.ts        # Bot status snapshot builder (model, cost, context, cron)
│   └── tool-prompt.ts   # AI tool registry — attachment, reply, cron instructions
├── cron/
│   ├── types.ts         # CronJobRecord, Schedule types, policy, executor interface
│   ├── directives.ts    # <tg-cron> XML parser — action/kind/attrs extraction
│   └── service.ts       # CronService — persistent JSON store, timer/croner, retry
└── shared/
    ├── types.ts         # AppConfig, BotConfig, CronConfig
    ├── log.ts           # Colored logger using Pi's theme system
    └── version.ts       # Version check, changelog parser, install method detect
```

---

## Commands

| Command | Action |
|---|---|
| `/new` | Create new session |
| `/kill` | Kill current operation |
| `/killall` | Kill and clear all queued prompts |
| `/compact` | Compact context (if idle) |
| `/steer <msg>` | Send steering message |
| `/undo` | Undo last reply + fork |
| `/export` | Export session as HTML |
| `/fork` | List forkable messages |
| `/model` | Open model selector menu |
| `/output` | Toggle streaming/non-streaming |
| `/thinking` | Set thinking level |
| `/status` | Show bot status |
| `/help` | Show help text |
| `/cron` | Open cron interactive menu |
| `/cron list` | List cron jobs |
| `/cron stat` | Cron service status |
| `/cron add at <ISO> <content>` | One-time job |
| `/cron add every <interval> <content>` | Interval job |
| `/cron add cron "<expr>" [tz] <content>` | Cron expression job |
| `/cron on\|off\|del <id>` | Toggle/delete job |
| `/cron rename <id> <name>` | Rename job |
| `/cron run <id>` | Manual trigger |

---

## Data Flow

```
User message (Telegram)
  → Grammy middleware chain (auth, session resolve, chat action)
  → PiPool.get(chatKey) → PiRpc (spawn or reuse subprocess)
  → PiRpc.prompt(msg, images, hooks)
    → RpcClient.prompt() → pi CLI subprocess stdin
    → Stream events: text_delta, tool_start, tool_end, agent_end
    → Hooks: onStart, onTextDelta (streaming), onToolStart, onToolError
  → Response text + tools
  → Parse: extractTgAttachments + extractTgReplyDirective + extractTgCronDirectives
  → mdToTgHtml (markdown → sanitized Telegram HTML)
  → ctx.reply (edit or send)
  → CronService.execute (if cron directive found)
```

---

## Translation Map (Chinese → English — COMPLETED)

All 154 Chinese strings across 10 files translated to English. Zero remaining.

| File | Count | Key Terms |
|---|---|---|
| runtime.ts | 12 | polling → polling, 启动 → start, 失败 → failed |
| directives.ts | 10 | 指令 → directive, 缺少 → missing, 过多 → too many |
| service.ts | 18 | 任务 → job, 启用 → enabled, 过期 → expired |
| attachment.ts | 8 | 附件 → attachment, 不支持 → unsupported |
| format.ts | 2 | 无回复 → no reply |
| create-bot.ts | 16 | 格式不对 → Invalid format, 排队中 → Queued |
| menu.ts | 33 | 模型 → Model, 刷新 → Refresh, 流式 → Streaming |
| reply.ts | 5 | 回复工具 → Reply tool, 未匹配 → No match |
| status.ts | 10 | 运行中 → Running, 空闲 → Idle, 花费 → Cost |
| tool-prompt.ts | 40 | 工具 → Tool, 示例 → Example, 桥接 → bridge |

---

## Production Config

```json
// ~/.pi/telegram/settings.json
{
  "bots": [{
    "token": "<BOT_TOKEN>",
    "name": "Pixy",
    "allowedUsers": [8671cf481359],
    "cwd": "~/.pi/telegram/workspace",
    "streamByChat": {}
  }],
  "idleTimeoutMs": 600000,
  "maxResponseLength": 4000,
  "cron": {
    "enabled": true,
    "defaultTimezone": "Africa/Cairo",
    "maxJobsPerChat": 20,
    "maxRunSeconds": 900,
    "maxLatenessMs": 600000,
    "retryMax": 2,
    "retryBackoffMs": 30000
  }
}
```

---

## Systemd

```ini
# /etc/systemd/system/pitg.service
[Unit]
Description=Pi Telegram Bridge
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/pitg
Restart=always
RestartSec=5
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
```

---

## Key Patterns

### Prompt Queue
- PiRpc runs **one prompt at a time** per chat
- New prompts queue in `_queue: Array<{run, reject}>`
- `cancelQueued()` rejects all queued — returns count
- Abort kills current + queued

### Streaming
- Two modes: **draft streaming** (edit message) vs **non-streaming** (send once)
- Toggle per-chat via `streamByChat` → persisted to settings.json
- Draft: edit status msg on every delta chunk (throttled)

### Session Management
- One pi subprocess per `bot{index}_chat{chatId}`
- Sessions stored at `~/.pi/telegram/sessions/{chatKey}/`
- Idle reaper runs every 60s — kills after `idleTimeoutMs`
- `/new` kills old subprocess, spawns fresh with `continueSession=false`

### Cron
- Persistent JSON at `~/.pi/telegram/cron/{botName}/jobs.json`
- Three schedule kinds: `at` (one-shot timer), `every` (interval), `cron` (croner expression)
- Policy: maxLateness, retryMax, retryBackoff, deleteAfterRun
- Max 8 directives per message, 20 jobs per chat
- Startup catchup for missed `at` jobs within maxLateness window

### AI Tool Bridge
- Three XML-like tags injected into pi's system prompt:
  - `<tg-attachment>` — send files/media
  - `<tg-reply>` — reply to specific messages with optional quote
  - `<tg-cron>` — manage scheduled tasks
- Parsed from AI response **after** generation, before delivery
- Tags stripped from visible output, warnings logged

---

## Production Standards

### Code
- TypeScript strict mode — no `any` without justification
- ESM only (`"type": "module"`)
- Named exports, no default exports
- One class/interface per file (exceptions: small related types)
- Error messages: concise, actionable, English only
- No Chinese/Japanese/Korean in user-facing strings — ever

### Commits
- Conventional: `feat:`, `fix:`, `chore:`, `refactor:`, `i18n:`
- Under 72 chars, imperative mood
- No emojis, no wolf, no signatures
- Agent = Kariem Seiam identity

### Dependencies
- `grammy` + plugins (runner, menu, auto-chat-action, auto-retry, hydrate, files, commands)
- `@earendil-works/pi-coding-agent` (RPC client)
- `croner` (cron expression scheduler)
- `markdown-it` + `markdown-it-cjk-friendly` + `sanitize-html`
- Zero dev dependencies in production

### Security
- `allowedUsers` whitelist — unauthorized = instant `⛔ Unauthorized`
- No user input executed directly
- File paths sanitized (no traversal)
- URL validation (http/https only)
- Base64 payload size limit (45MB)

---

## File-by-File Audit

| File | Lines | Purpose | Status |
|---|---|---|---|
| main.ts | 5 | Entry point | ✅ Clean |
| app/paths.ts | 16 | Path constants | ✅ Clean |
| app/config.ts | 166 | Settings CRUD | ✅ Clean |
| app/runtime.ts | 292 | Bot lifecycle | ✅ Translated |
| pi/types.ts | 30 | Type definitions | ✅ Clean |
| pi/pool.ts | 100 | Subprocess pool | ✅ Clean |
| pi/rpc.ts | 369 | RPC wrapper | ✅ Clean |
| shared/types.ts | 27 | Config types | ✅ Clean |
| shared/log.ts | 63 | Colored logger | ✅ Clean |
| shared/version.ts | 274 | Version helpers | ✅ Clean |
| telegram/create-bot.ts | 2802 | Commands + handlers | ✅ Translated |
| telegram/menu.ts | 405 | Grammy menus | ✅ Translated |
| telegram/format.ts | 171 | MD → TG HTML | ✅ Translated |
| telegram/attachment.ts | 321 | Attachment parser | ✅ Translated |
| telegram/reply.ts | 197 | Reply parser | ✅ Translated |
| telegram/status.ts | 63 | Status builder | ✅ Translated |
| telegram/tool-prompt.ts | 89 | AI tool registry | ✅ Translated |
| cron/types.ts | 102 | Cron types | ✅ Clean |
| cron/directives.ts | 191 | Cron parser | ✅ Translated |
| cron/service.ts | 911 | Cron scheduler | ✅ Translated |

**Total**: 6,594 lines | 20 files | 0 Chinese | 0 tests (upstream has none)

---

## Known Gaps

1. **No tests** — upstream has zero test coverage
2. **No CI/CD** — no GitHub Actions, no build pipeline
3. **No CHANGELOG.md** — version.ts parses it but file missing
4. **No LICENSE** — upstream MIT, fork should declare
5. **create-bot.ts is 2802 lines** — god file, needs decomposition
6. **No rate limiting** — Telegram API rate limits handled by grammY auto-retry only
7. **No health check endpoint** — no HTTP server, pure long-polling
8. **Settings write queue** — silent catch on write failure (line 160 of config.ts)

---

## Restart Procedure

```bash
# Rebuild after changes
cd /root/pi-telegram-fork && npm run build

# Restart service
systemctl restart pitg

# Verify
systemctl status pitg
journalctl -u pitg -f --no-pager -n 30
```

---

🐙 *Standards aren't rules. They're the shape the organism takes when it stops thinking about moving.*

# Pi-Telegram

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Ziphyrien/Pi-Telegram)
[![npm version](https://img.shields.io/npm/v/pi-telegram?logo=npm)](https://www.npmjs.com/package/pi-telegram)
[![npm downloads](https://img.shields.io/npm/dm/pi-telegram)](https://www.npmjs.com/package/pi-telegram)

A Telegram bridge for the [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Messages flow Telegram → Pi → Telegram, with full session management, streaming, scheduled tasks, and multi-bot support.

## Features

- Direct Pi access from any Telegram chat
- Text, image, and document message support
- Isolated sessions per chat
- Streaming responses with draft-preview mode
- Scheduled tasks (one-shot, interval, cron)
- Multi-bot support
- Model switching, thinking level control
- Session export, fork, and undo

## Prerequisites

1. Install [Node.js](https://nodejs.org/) (v16+)
2. Install and configure [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) — verify `pi` works in your terminal
3. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and get the token

## Installation

### Global install (production)

```bash
npm install -g pi-telegram
pitg
```

### Local development

```bash
git clone https://github.com/kariemSeiam/pi-telegram.git
cd pi-telegram
npm install
npm run build
npm start
```

## First Run

On first launch, a config template is generated and the process exits:

- Linux/macOS: `~/.pi/telegram/settings.json`
- Windows: `%USERPROFILE%/.pi/telegram/settings.json`

Edit the token to your real bot token, then restart.

## Configuration

```json
{
  "bots": [
    {
      "token": "<YOUR_TELEGRAM_BOT_TOKEN>",
      "name": "Pi-Telegram",
      "allowedUsers": [],
      "cwd": "~/.pi/telegram/workspace",
      "streamByChat": {}
    }
  ],
  "idleTimeoutMs": 600000,
  "maxResponseLength": 4000,
  "cron": {
    "enabled": true,
    "defaultTimezone": "UTC",
    "maxJobsPerChat": 20,
    "maxRunSeconds": 900,
    "maxLatenessMs": 600000,
    "retryMax": 2,
    "retryBackoffMs": 30000
  }
}
```

| Field | Description |
|-------|-------------|
| `bots` | Bot list — configure multiple bots |
| `bots[].token` | Telegram bot token from BotFather |
| `bots[].name` | Bot name — used for session and cron directories |
| `bots[].allowedUsers` | User IDs or usernames allowed to access. Empty = unrestricted |
| `bots[].cwd` | Working directory for Pi |
| `idleTimeoutMs` | Idle time before Pi process is reclaimed (default: 10 min) |
| `maxResponseLength` | Max response length — auto-split if exceeded |
| `cron` | Scheduled task configuration |

## Usage

Send any message to your bot. Supported input:

- **Text** — plain messages
- **Images** — sent as context to Pi
- **Documents** — forwarded to Pi for processing

Replying to a historical message includes the quoted content as context.

## Commands

| Command | Action |
|---------|--------|
| `/new` | Start a new session |
| `/kill` | Kill current task |
| `/killall` | Kill current task + clear queue |
| `/compact [instructions]` | Compact session context |
| `/steer <message>` | Send a steering message mid-run |
| `/fork` | Branch from a previous message |
| `/undo` | Undo last reply and regenerate |
| `/export` | Export session as HTML |
| `/model` | Open model selector |
| `/output` | Toggle streaming / non-streaming output |
| `/thinking` | Set thinking level |
| `/status` | Show bot status |
| `/help` | Show help text |
| `/cron` | Open cron menu |

## Scheduled Tasks

```
/cron list                                    List all jobs
/cron stat                                    Service status
/cron add at <ISO-time> <content>             One-shot at specific time
/cron add every <interval> <content>          Repeating interval
/cron add cron "<expr>" [timezone] <content>  Cron expression
/cron on|off <id>                             Enable/disable
/cron del <id>                                Delete
/cron rename <id> <name>                      Rename
/cron run <id>                                Manual trigger
```

Intervals: `s`, `m`, `h`, `d` — e.g. `30s`, `10m`, `2h`, `1d`

Named jobs: `name||content`

```bash
/cron add every 10m Check||Check alerts and summarize
/cron add at 2026-06-01T09:00:00Z Morning||Summarize yesterday's logs
/cron add cron "0 9 * * 1-5" UTC Weekday report||Daily summary
```

## AI Tool Tags

Pi-Telegram injects three tag protocols into the model's system prompt. The model uses them automatically when needed — you don't write these manually.

- `<tg-reply>` — Attach a reply to a specific message with optional quote
- `<tg-attachment>` — Send files, photos, or other media
- `<tg-cron>` — Create and manage scheduled tasks

## Data Directory

```
~/.pi/telegram/
├── settings.json     # Main configuration
├── workspace/        # Default working directory
├── sessions/         # Session data per bot/chat
├── cron/             # Persistent cron jobs
└── inbound/          # Downloaded images and files
```

## Session Management

Each chat gets a dedicated Pi subprocess with a fixed `--session-dir`:

```
~/.pi/telegram/sessions/<bot-name>/bot<hash>_chat<id>
```

- Same chat = same directory, context persists across restarts
- `/new` creates a fresh session
- You can inspect any chat's history from the terminal:

```bash
pi --session-dir "<session-dir>" -r          # Open session list
pi --session-dir "<session-dir>" -c           # Continue latest session
pi --session-dir "<session-dir>" --session <id>  # Open specific session
```

## License

This project is a fork of [Ziphyrien/Pi-Telegram](https://github.com/Ziphyrien/Pi-Telegram).

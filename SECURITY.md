# Security model

Pi-Telegram gives a Telegram chat the full power of a coding agent. Treat the bot token
and the allowlist as the keys to the machine it runs on.

## What is enforced

| Control | Behaviour |
|---|---|
| Allowlist | `allowedUsers` must be a non-empty list of **numeric** Telegram user IDs. Empty list or usernames: the process refuses to start. The guard runs before every handler, menus and callbacks included. |
| Attachments (path) | `<tg-attachment path>` must be absolute, resolve (symlinks followed) inside a bot's `cwd`, and not look like a credential (`.env`, `auth.json`, `*.pem`, `settings.json`, SSH keys, ...). |
| Attachments (URL) | `http(s)` only. The URL is handed to Telegram to fetch; the server never fetches it. |
| Cron | State-changing `<tg-cron>` from the model (`add/run/on/off/del/rename`) needs an Approve tap from the same user within 5 minutes. Single use. |
| `cwd` | `/`, `$HOME` and `~/.pi` are rejected at startup. |

## What is not enforced

The agent itself still runs with the Unix permissions of the service user and can read or
write anything that user can. The controls above bound what the *bridge* does with model
output. They do not sandbox the agent. Use `deploy/pitg.service` to run it as an
unprivileged user in a private filesystem view, and keep secrets out of that user's reach.

## Reporting

Open a private security advisory on the repository.

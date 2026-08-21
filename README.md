<div align="center">

<img src="docs/ModWatcher.png" alt="Mod Watcher" width="160" />

# Mod Watcher

**The detailed 7 Days to Die mod-update posts from [7d2dmodding.com](https://7d2dmodding.com), delivered to your Discord server.**

Invite the official bot or self-host your own—either way, it posts mod updates and does nothing else.

[![License: WTFPL](https://img.shields.io/badge/License-WTFPL-brightgreen)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![discord.js](https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)
[![7 Days to Die](https://img.shields.io/badge/7%20Days%20to%20Die-Mod%20Updates-b22222)](https://7daystodie.com/)
[![7d2dmodding.com](https://img.shields.io/badge/Powered%20by-7d2dmodding.com-gold)](https://7d2dmodding.com)

</div>

---

## 👁️ What Is This?

A small, open-source Discord bot that mirrors the **7 Days to Die** mod update feed from
[7d2dmodding.com](https://7d2dmodding.com) into your server. The heavy lifting — watching Nexus,
7daystodiemods, the official forums, CurseForge and GitHub, de-duplicating and enriching every
update — happens on 7d2dmodding.com. This bot polls one API and posts the result.

It is deliberately minimal, and the permissions prove it:

| Surface | What it asks for |
| --- | --- |
| 🛰️ Gateway intents | `Guilds` only — it never reads messages, members, or presence |
| 🔗 Invite scopes | `bot`, `applications.commands` |
| 🔒 Channel permissions | **View Channel**, **Send Messages** |

---

## 🤝 Two Ways to Have It

- 🎟️ **Invite the official bot** — no hosting needed. It posts the feed as configured by
  7d2dmodding.com. Run `/setup channel:#your-channel` and you're done.
- 🛠️ **Self-host this repo** — your own Discord application, your own feed key, your own filters
  (configured on your 7d2dmodding.com account page).

---

## ⌨️ Commands

| Command | Who | What |
| --- | --- | --- |
| `/setup channel:#…` | Manage Server | Pick the channel mod updates post in. Run with no option to check the current one. |
| `/status` | Manage Server | Ephemeral health check: last poll, last post, channel binding. |
| `/collection show link:…` | everyone | Share a 7d2dmodding.com mod collection in the channel. |

That's the whole surface. Setup of *what* gets posted (filters by source, author, or mod, and
output options) lives on 7d2dmodding.com, attached to the API key.

---

## 🚀 Self-Hosting

### 1. 🤖 Create a Discord application

At <https://discord.com/developers/applications> — add a bot, copy the token.
No privileged intents are needed.

### 2. 🔑 Get a feed key

Sign in at [7d2dmodding.com](https://7d2dmodding.com) and create your API key (one per user).
Configure filters and output there too.

### 3. 🧰 Configure

Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `FEED_KEY`.

### 4. 🎮 Run

Node 24+ and [pnpm](https://pnpm.io):

```sh
pnpm install
pnpm build
pnpm start
```

For development: `pnpm dev`.

### 5. 📬 Invite it

Scopes `bot applications.commands`, permissions **View Channel** + **Send Messages**,
then run `/setup` in your server.

> 💡 The bot keeps one small JSON state file (`./data/state.json` by default): its position in
> the feed, a short ledger of what it already posted, and each server's chosen channel. Delete
> it to reset — a fresh state starts from *now* and never back-posts history.

---

## 🧠 Behaviour Worth Knowing

- 🕐 A new install (or newly bound channel) starts with the **next** update; it does not backfill.
- 😴 If 7d2dmodding.com is unreachable, the bot backs off quietly (up to 30 min between retries)
  and catches up at a steady pace — at most a handful of posts per cycle, never a flood.
- 🤫 Failures never show up as messages in your channel. `/status` and the log are where
  problems are visible.
- 🔕 Posts can never ping anyone: every message is sent with mentions disabled.

---

## 📜 License

[WTFPL](LICENSE). Do what you want with it. The official bot's name, avatar, and branding belong
to its application; your self-hosted copy runs under yours.

---

<div align="center">

**👁️ Happy watching. May your mods stay updated and your blood moons plentiful. 🌙**

</div>

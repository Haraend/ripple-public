# Ripple

Lightweight multi-guild Discord bot for music playback and Apex Legends RP tracking.
Designed to run on a **Raspberry Pi 3** (arm64, ~1 GB RAM, 32 GB storage).

## Current phase

**Phase 2 — Music module** (in progress on `feat/phase-2-music`; yt-dlp, track cache, Spotify, queue, throttles, autoleave, pause/volume/seek).

Later phases (Apex tracker, Pi deployment) and remaining Phase 2 checkboxes live in a
local gitignored `TODO.md` on the maintainer machine. This file is the public status pointer.

## Features (roadmap)

| Phase | Scope |
| --- | --- |
| 1 | Framework, SQLite settings, `/ping` `/help` `/config` `/owner`, voice smoke (`/join` `/leave` `/play` direct URL), SSRF URL guard, busy-channel voice policy |
| 2 | Full music: yt-dlp, queue, loop, buttons, autoleave, volume/seek hybrid pipeline |
| 3 | Apex Legends RP tracker with delta-only SQLite writes and channel announcements |
| 4 | systemd unit, Pi provisioning, on-device validation |

## Requirements

- Node.js **24+** (arm64 on the Pi)
- pnpm 10 (`corepack enable`)
- System `ffmpeg` on `PATH` (voice)
- System `yt-dlp` on `PATH` (Phase 2+)
- Discord bot token + application client ID

## Quick start

```bash
corepack enable
pnpm install
cp .env.example .env
# fill DISCORD_TOKEN and DISCORD_CLIENT_ID

pnpm doctor
pnpm deploy-commands
pnpm build
pnpm start
# or during development:
pnpm dev
```

Invite the bot with the `applications.commands` and `bot` scopes. Grant
`Connect` and `Speak` in voice channels for the smoke-test music commands.

## Configuration

All settings are validated at startup via zod in `src/config/env.ts`.
See [`.env.example`](.env.example) for the full list.

Sensitive admin actions require Discord **Manage Server**. Owner-only commands
are gated by `OWNER_IDS`. Optional DJ role gating is stored per guild in SQLite
and toggled via `/config`.

## Hardware notes (Pi 3)

- No JavaScript Opus encoder — FFmpeg emits Ogg/Opus; Discord.js only demuxes.
- Prefer Opus passthrough (`-c:a copy`) unless volume or seek forces a transcode.
- Never write audio to disk; only metadata lives in SQLite under `./data/`.
- Concurrent streams are capped (`MUSIC_MAX_CONCURRENT_STREAMS`, default 2).

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm typecheck` | Strict TypeScript check |
| `pnpm lint` | oxlint |
| `pnpm test` | vitest (pure logic) |
| `pnpm build` | tsup → `dist/index.js` |
| `pnpm doctor` | Node / ffmpeg / yt-dlp / aes-256-gcm checks |
| `pnpm deploy-commands` | Register slash commands |

## License

MIT — see [LICENSE](LICENSE).

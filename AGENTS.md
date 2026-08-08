# Agent guide — Ripple

Public Discord bot (music + Apex Legends tracker) optimized for Raspberry Pi 3.

## Current phase

**Phase 1 — Core skeleton + voice smoke test** (complete on `feat/phase-1-core`; next is Phase 2 music).

Detailed checkbox tasks for Phases 1–4 live in a **gitignored** `TODO.md` on the
maintainer machine. If you are a fresh clone / cloud agent and do not see
`TODO.md`, follow the phase table in `README.md` and the architecture notes below.
Do not invent scope beyond the active phase.

## Non-negotiables

1. Secrets only via `src/config/env.ts` (zod). Never hardcode tokens or IDs.
2. Never commit `.env`, `data/`, `*.db`, cookies, or `TODO.md`.
3. Strict TypeScript: no `any`, no non-null `!`, no `as` outside parse boundaries.
4. External JSON → zod. User errors → `UserFacingError` (no stack traces in Discord).
5. No JS Opus encoder, no `ffmpeg-static`, no media written to disk.
6. Kill every spawned FFmpeg/yt-dlp child on every exit path.
7. SQLite writes only when state actually changes.
8. Justify any new runtime dependency against the 1 GB / 32 GB Pi budget.

## Stack (pinned)

- Node 24, pnpm 10, TypeScript 7.0.2, tsup 8.5.1, tsx 4.23.11
- discord.js 14.27.0, @discordjs/voice 0.19.2
- drizzle-orm 0.45.2 + better-sqlite3 13.0.3
- zod 4.4.3, pino 10.3.1, oxlint (TypeScript 7 → not typescript-eslint)

## Git

Branch per phase (`feat/phase-1-core`, …). Conventional commits. No commits to
`main`. Leave branches unpushed unless asked. See `.cursor/rules/git-workflow.mdc`.

## Module contract

Commands, events, and modules implement the interfaces in `src/core/types.ts`.
Do not redefine them. Music and Apex are optional modules that disable cleanly
when their env keys are absent.

## Verification before marking work done

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm doctor
```

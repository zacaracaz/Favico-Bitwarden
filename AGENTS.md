# AGENTS.md — favico × Bitwarden

Shared context for Codex and Codex Cowork. This is the **local, guided
CLI wizard** that gives Bitwarden / Vaultwarden logins real icons. (The hosted
icon service is a separate project, `favico-website`.)

## What this is

Bitwarden shows the favicon of the domain a login points at, so entries with no
good icon become a wall of look-alike tiles. This tool connects to the user's
vault locally, finds entries lacking icons, and lets them pick one. It adds the
icon by inserting `https://<name>.favico.app` as **URI 1** with match detection
set to **Never** (icon shows, never autofills) and pushing the real login URL
down to **URI 2** (still matches/autofills). Fully reversible via "Revert all
favico URIs".

## Who you're working with

Zac — Brisbane. Wants brief, direct replies and quick execution. Built for
non-technical end users, so the launcher must stay hand-holding and forgiving.

## Repo & stack

- GitHub: `zacaracaz/favico-bitwarden` (README/download links may say `favico-app`)
- Plain, **un-compiled JavaScript, ES modules, Node built-ins only — no
  third-party dependencies** (there is no `package.json`/`node_modules`). The
  web UI is inline; nothing loads from a CDN. This is a deliberate,
  audit-in-one-sitting design — **keep it dependency-free.**
- Talks to the official Bitwarden **`bw` CLI** as a child process.

## How it runs

- **Windows:** double-click `start.cmd` (installs Node via winget if missing)
- **macOS / Linux:** `./start.sh` (installs Node via brew/apt/dnf/pacman if missing)
- **Any OS with Node:** `node start.mjs`
- `start.mjs` is the launcher: checks Node + `bw` CLI (offers to install the CLI
  via npm), logs in only if needed, unlocks the vault, writes an **encrypted
  backup**, then opens the wizard.
- `scripts/bw-favico-ui.mjs` — the actual tool + inline web UI (the 6-step wizard).

## Wizard steps

1. Matched (auto-matched no-icon entries) → 2. Pick icons → 3. Replace →
4. Rename → 5. Duplicates (soft-delete to Trash) → 6. Review & apply.
Nothing is written to the vault until the final **Apply** step.

## Constraints & gotchas (this is a security-sensitive tool)

- **Everything runs locally. The master password and vault secrets must never
  leave the machine** — decryption is via the official `bw` CLI only. Do not add
  any code that transmits vault contents anywhere.
- Only two servers may ever be contacted: `icons.bitwarden.net` (existing-favicon
  checks) and `www.favico.app` (icon search/upload). Nothing else.
- Anything shared to improve matching must stay **opt-in and fully anonymous** —
  no account/email/device/user id, no URLs, no secrets.
- **Write an encrypted backup before any vault mutation.** Duplicate removal is
  **soft-delete to Trash only**, never permanent.
- **Never commit secrets** — no session keys, tokens, or vault data in the repo
  or chat output.
- Keep it **zero-dependency and CDN-free** so the whole tool stays auditable from
  just `start.mjs` + `scripts/bw-favico-ui.mjs`.

## How to work here

- Precise, minimal diffs; say what changed and why, briefly.
- Preserve the non-technical UX: narrate each step, ask before installing anything.

## Cross-project conversation log — READ AT START, UPDATE AT END

All projects share ONE master log at the Projects root:
`C:\Users\Zac\Projects\CONVERSATIONS.md` (one level up from this repo).

- **Read it at the start of a session** for this project's history, and whenever
  Zac asks to borrow from another project (e.g. "use the resizing tool from
  favico-website") — every project's notes live in that one file, each under its
  own heading.
- **Append entries under this project's heading — `# favico × Bitwarden` — newest at the
  bottom, dated.** Don't create a per-project log; keep everything in the master.
- Plain Codex.ai chats and design chats can't write to that file — paste their
  gist in by hand, or run the work through Cowork so it logs itself.

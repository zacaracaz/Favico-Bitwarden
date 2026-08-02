# favico × Bitwarden

Give your Bitwarden / Vaultwarden logins **real icons**.

## What is favico?

Bitwarden shows the **favicon of the website** each login points at (it fetches it
from the domain in the entry's URL). The catch: lots of entries have **no icon**, or
a generic placeholder — so your vault ends up a wall of look-alike tiles.

**favico.app** is a small service that hosts custom icons, each at its own subdomain
— e.g. `netflix.favico.app` serves a Netflix icon. **This tool** is a local, guided
wizard that connects to your vault, finds the entries without good icons, and lets you
pick one from a library, search the web, or upload your own.

## How it adds the icon to a Bitwarden item

Bitwarden takes an entry's icon from its **first** web address (URI 1). So the tool:

1. Inserts `https://name.favico.app` as **URI 1**, with its **match detection set to
   "Never"** — Bitwarden will *show that icon* but will *never* use that address for
   autofill.
2. Pushes your **real login URL down to URI 2**, where it still matches and autofills
   exactly as before.

```text
Before:
  URI 1  https://login.example.com      (icon: none)

After:
  URI 1  https://example.favico.app      match = Never     ← icon comes from here
  URI 2  https://login.example.com       match = default   ← still autofills
```

Nothing else about the entry changes, and it's reversible anytime — the wizard has a
**"Revert all favico URIs"** button that strips out everything it added.

Along the way it can also suggest cleaner entry names and flag likely-duplicate logins.

## Platform support

- **Windows is the supported and tested platform today.** Use `start.cmd` for
  the guided setup.
- **macOS and Linux support is experimental.** A dedicated `start.sh` launcher
  and cross-platform Node paths are included and are expected to work, but the
  complete journey has not yet been verified on either platform. Use
  `bash start.sh` from a downloaded ZIP and please report anything that fails.
  The Debian prerequisite path avoids global npm installs and does not require
  Favico to run as root.

## Get it

**Easiest — download the ZIP (no tools needed):** on this
[GitHub page](https://github.com/zacaracaz/favico), click the green
**`<> Code`** button → **Download ZIP**, then unzip it.

Then open the folder and run `start.cmd` — it will do the rest.

> Tips: on Windows a freshly-downloaded `start.cmd` may trigger SmartScreen —
> click *More info → Run anyway*. On macOS/Linux from a ZIP, launch with
> `bash start.sh` (a ZIP drops the file's executable bit).

## Running it

The only thing you must already have is a **Bitwarden account** — the launcher
offers to install everything else it needs:

- **Node.js** — if it's missing, the wrapper installs it for you: `start.cmd`
  uses **winget** (Windows); `start.sh` uses **Homebrew / apt / dnf / pacman**
  (macOS/Linux). Each asks first.
- **Bitwarden CLI** — `start.mjs` offers to download Bitwarden's official,
  dependency-free executable into a private `.favico-runtime` folder. It does
  not change the system installation or need `sudo`/Administrator access.

Then just:

- **Windows:** double-click **`start.cmd`**
- **macOS / Linux:** run **`./start.sh`**
- **Any OS (Node already installed):** `node start.mjs`

The launcher walks you through everything, narrating each step: installs/checks
prerequisites, logs you in only if needed, unlocks your vault (your master
password stays hidden), makes an **encrypted backup**, and opens a 6-step wizard
in your browser.

> On Windows, the very first run after a fresh Node install may say *"Node was
> installed but this window needs reopening"* — just close it and double-click
> `start.cmd` again (a one-time PATH refresh).

If you'd rather install the prerequisites yourself: Node.js from
<https://nodejs.org>, then the native Bitwarden CLI from
<https://bitwarden.com/help/cli/>.

## What the wizard does

Start by choosing:

- **Go through the flow (recommended)** — the guided experience with automatic
  matching, detailed duplicate comparison, mostly-empty duplicate warnings,
  rename suggestions, unresolved-icon help, low-resolution icon detection,
  optional replacement, a final review and a downloadable change record.
- **Editor Mode** — a manual list of every login where you can directly change
  its name, 48×48 icon or web addresses. After saving, Favico offers to take you
  through the recommended flow for its extra checks and suggestions.

The guided flow is:

1. **Options** — choose whether local password comparison and anonymous hints
   are allowed.
2. **Duplicates** — see exactly what differs, flag mostly-empty copies, and
   choose **Keep this one**; every other copy only moves to recoverable Trash.
3. **Matched** — review confident automatic icon matches before rename.
4. **Rename** — review cleaner names for URL/package-style entries.
5. **Pick icons** — search the library or web, enter a direct image URL, extract
   images from a webpage URL, or upload/paste an image.
6. **Improve quality** — replace existing icons measuring 47×47 pixels or less.
7. **Replace** — optionally swap any other entry's existing icon.
8. **Review & apply** — see the full summary, download a change record, then
   apply.

The image editor shows icons at 48×48 throughout, supports up to 10× zoom, and
accepts both a visual background-colour choice and an exact hex code.

Nothing is written to your vault until the final **Apply** step.

## Safety & privacy

- Runs **entirely on your machine**. Your vault is decrypted locally via the
  official Bitwarden CLI — **your master password and secrets never leave it**.
- An **encrypted backup** is written before anything changes.
- Duplicate removal **soft-deletes to Bitwarden's Trash** (recoverable), never permanent.
- The only servers contacted are **`icons.bitwarden.net`** (to check existing
  favicons) and **`www.favico.app`** (icon search / upload). Nothing else.
- Icons you **upload or pick from a web search are stored on the favico.app
  server** and added to its shared, searchable library (by design, for reuse) —
  they contain only the image and the short name you give it, **no vault data**.
- Anything shared to **improve matching for everyone is opt-in and fully anonymous**
  — generic rename hints, which icon you pick for a site, and icon-usage counts. It
  carries **no account, email, device or user identifier, no URLs and no secrets**,
  so it **cannot be linked to you or your Bitwarden account**.

## Verify it yourself

It's plain, un-compiled JavaScript with **no third-party dependencies** (only
Node built-ins + the official `bw` CLI), and the web UI is **inline** — nothing
is loaded from a CDN. The whole thing to audit is `start.mjs` and
`scripts/bw-favico-ui.mjs`. A quick check:

```
grep -nE "fetch\(" scripts/bw-favico-ui.mjs        # every outbound request
grep -niE "password" scripts/bw-favico-ui.mjs       # never sent over the network
```

## Feedback & bugs

- **Ideas, questions, general feedback** → [GitHub Discussions](https://github.com/zacaracaz/favico-app/discussions)
- **Bugs / something broke** → [GitHub Issues](https://github.com/zacaracaz/favico-app/issues)
- **Security issues** → see [SECURITY.md](SECURITY.md) (please report privately)

## License & name

Licensed under the **PolyForm Noncommercial License 1.0.0** (see [LICENSE.md](LICENSE.md)):
free to use, self-host, modify, and share for **non-commercial** purposes —
**commercial use is not permitted**.

The name **"favico"** and the funnel logo are reserved by the author and are **not**
covered by the code license.

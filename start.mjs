#!/usr/bin/env node
/*
 * favico × Bitwarden — guided launcher.
 *
 * One command for non-technical users. It walks through, narrating each step:
 *   1. checks Node + the Bitwarden CLI (offers to install the CLI)
 *   2. logs you in (only if needed)
 *   3. unlocks your vault and captures a session — your password stays hidden
 *   4. hands off to the tool, which makes an ENCRYPTED backup and opens the wizard
 *
 * Everything runs locally. Your master password and secrets never leave the machine.
 *
 *   node start.mjs
 *
 * (Windows users can double-click start.cmd; macOS/Linux can run ./start.sh)
 */
import { spawnSync } from "child_process";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import path from "path";
import { fileURLToPath } from "url";

// Silence the Bitwarden CLI's "punycode is deprecated" warning in every bw child.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--no-deprecation"].filter(Boolean).join(" ");

const isWin = process.platform === "win32";
const here = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(here, "scripts", "bw-favico-ui.mjs");

// ── tiny ANSI helpers ────────────────────────────────────────────────
const sgr = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const bold = (s) => sgr(1, s), dim = (s) => sgr(2, s);
const green = (s) => sgr(32, s), red = (s) => sgr(31, s), yellow = (s) => sgr(33, s), cyan = (s) => sgr(36, s);
const ok = (s) => console.log("  " + green("✓") + " " + s);
const info = (s) => console.log("  " + cyan("•") + " " + s);
const warn = (s) => console.log("  " + yellow("•") + " " + s);
const fail = (s) => console.log("  " + red("✗") + " " + s);

// On Windows the CLI is bw.cmd; run it through cmd so PATHEXT resolves it and
// Node's .cmd-spawn restriction doesn't bite. node/npm handled directly.
function bwCapture(args) {
  return isWin ? spawnSync("cmd", ["/c", "bw", ...args], { encoding: "utf8" })
               : spawnSync("bw", args, { encoding: "utf8" });
}
function bwInherit(args) {
  return isWin ? spawnSync("cmd", ["/c", "bw", ...args], { stdio: "inherit" })
               : spawnSync("bw", args, { stdio: "inherit" });
}
// interactive prompt on stderr, typed password on stdin, raw session on stdout
function bwUnlockRaw() {
  const opt = { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" };
  return isWin ? spawnSync("cmd", ["/c", "bw", "unlock", "--raw"], opt)
               : spawnSync("bw", ["unlock", "--raw"], opt);
}
function npmInstallCli() {
  return isWin ? spawnSync("cmd", ["/c", "npm", "i", "-g", "@bitwarden/cli"], { stdio: "inherit" })
               : spawnSync("npm", ["i", "-g", "@bitwarden/cli"], { stdio: "inherit" });
}
function bwStatus() {
  const r = bwCapture(["status"]);
  if (r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout.slice(r.stdout.indexOf("{"), r.stdout.lastIndexOf("}") + 1)); }
  catch { return null; }
}

function serverLabel(u) {
  if (!u) return "bitwarden.com (US, default)";
  const h = u.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (h.includes("bitwarden.eu")) return h + " (EU)";
  if (h.includes("bitwarden.com")) return h + " (US)";
  return h + " (self-hosted)";
}

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q) => (await rl.question(q)).trim();
const askYes = async (q) => /^y(es)?$/i.test(await ask(q + dim(" [y/N] ")));

async function main() {
  console.log(bold("\n  favico × Bitwarden — guided setup\n"));
  console.log("  Bitwarden shows the favicon of the site each login points at — but many");
  console.log("  entries have no icon, or the wrong one. favico.app hosts custom icons at");
  console.log('  name.favico.app; this tool adds one as an entry\'s first web address (set to');
  console.log('  "never autofill"), so Bitwarden shows the icon while your real login URL');
  console.log("  still works exactly as before.\n");
  console.log("  This runs " + bold("entirely on your machine") + ". Your vault is decrypted locally");
  console.log("  via the official Bitwarden CLI — your master password and secrets never leave");
  console.log("  this computer. An " + bold("encrypted backup") + " is made before anything, and " + bold("nothing"));
  console.log("  is written to your vault until you click Apply at the end.\n");

  // 1 ── Node + Bitwarden CLI ─────────────────────────────────────────
  console.log(bold("  Step 1 of 4 — Checking prerequisites"));
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) { fail(`Node ${process.versions.node} is too old — install Node 18+ from https://nodejs.org`); process.exit(1); }
  ok(`Node ${process.versions.node}`);

  let ver = bwCapture(["--version"]);
  if (ver.status !== 0) {
    warn("Bitwarden CLI (bw) is not installed.");
    if (await askYes("    Install it now with npm?")) {
      info("Installing @bitwarden/cli globally…");
      npmInstallCli();
      ver = bwCapture(["--version"]);
    }
    if (ver.status !== 0) { fail("Still not found. Install it manually, then re-run:  npm i -g @bitwarden/cli"); process.exit(1); }
  }
  ok(`Bitwarden CLI ${(ver.stdout || "").trim()}`);

  // 2 ── Login (only if needed) ───────────────────────────────────────
  console.log(bold("\n  Step 2 of 4 — Bitwarden account"));
  let st = bwStatus();
  if (!st || st.status === "unauthenticated") {
    info("You're not logged in. Starting Bitwarden login…");
    console.log(dim("    (email, master password, and your 2FA code if enabled)\n"));
    bwInherit(["login"]);
    st = bwStatus();
    if (!st || st.status === "unauthenticated") { fail("Login didn't complete. Re-run when you're ready."); process.exit(1); }
  }
  ok(`Logged in as ${st.userEmail || "(your account)"} on ${serverLabel(st.serverUrl)}`);

  // 3 ── Unlock → capture session ─────────────────────────────────────
  console.log(bold("\n  Step 3 of 4 — Unlock your vault"));
  let session = "";
  for (let i = 0; i < 3 && !session; i++) {
    session = (bwUnlockRaw().stdout || "").trim();
    if (!session) fail("Wrong master password or cancelled." + (i < 2 ? " Try again." : ""));
  }
  if (!session) { fail("\n  Could not unlock. Re-run when you're ready.\n"); process.exit(1); }
  ok("Vault unlocked.");
  rl.close();

  // 4 ── Launch the tool ──────────────────────────────────────────────
  console.log(bold("\n  Step 4 of 4 — Starting the tool"));
  info("Making an encrypted backup, then opening the wizard in your browser…\n");
  const extra = process.argv.slice(2); // pass-through, e.g. --no-backup / --no-open
  const ui = spawnSync(process.execPath, [UI, ...extra], {
    stdio: "inherit",
    cwd: here, // keep backups/ next to the tool
    env: { ...process.env, BW_SESSION: session },
  });
  process.exit(ui.status || 0);
}

main().catch((e) => { fail("Unexpected error: " + (e && e.message)); process.exit(1); });

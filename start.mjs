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
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import path from "path";
import { fileURLToPath } from "url";
import {
  BITWARDEN_SERVERS,
  bitwardenDownloadUrl,
  bundledBwPath,
  bwInvocation,
  loginArgs,
  validServerUrl,
} from "./scripts/bw-command.mjs";

// Silence the Bitwarden CLI's "punycode is deprecated" warning in every bw child.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--no-deprecation"].filter(Boolean).join(" ");

const isWin = process.platform === "win32";
const here = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(here, "scripts", "bw-favico-ui.mjs");
const LOCAL_BW = bundledBwPath(here);
let activeBwPath = existsSync(LOCAL_BW) ? LOCAL_BW : "";

// ── tiny ANSI helpers ────────────────────────────────────────────────
const sgr = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const bold = (s) => sgr(1, s), dim = (s) => sgr(2, s);
const green = (s) => sgr(32, s), red = (s) => sgr(31, s), yellow = (s) => sgr(33, s), cyan = (s) => sgr(36, s);
const ok = (s) => console.log("  " + green("✓") + " " + s);
const info = (s) => console.log("  " + cyan("•") + " " + s);
const warn = (s) => console.log("  " + yellow("•") + " " + s);
const fail = (s) => console.log("  " + red("✗") + " " + s);

function runBw(args, options) {
  const command = bwInvocation(args, { localPath: activeBwPath });
  return spawnSync(command.file, command.args, options);
}
function bwCapture(args) {
  return runBw(args, { encoding: "utf8" });
}
function bwInherit(args) {
  return runBw(args, { stdio: "inherit" });
}
// interactive prompt on stderr, typed password on stdin, raw session on stdout
function bwUnlockRaw() {
  const opt = { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" };
  return runBw(["unlock", "--raw"], opt);
}

function extractCli(zipPath, runtimeDir) {
  if (isWin) {
    return spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $env:FAVICO_BW_ZIP -DestinationPath $env:FAVICO_BW_RUNTIME -Force",
    ], {
      stdio: "ignore",
      env: { ...process.env, FAVICO_BW_ZIP: zipPath, FAVICO_BW_RUNTIME: runtimeDir },
    }).status === 0;
  }
  const attempts = [
    ...(process.platform === "darwin" ? [["ditto", ["-x", "-k", zipPath, runtimeDir]]] : []),
    ["unzip", ["-oq", zipPath, "-d", runtimeDir]],
    ["python3", ["-m", "zipfile", "-e", zipPath, runtimeDir]],
  ];
  return attempts.some(([file, args]) => spawnSync(file, args, { stdio: "ignore" }).status === 0);
}

async function installBundledCli() {
  const url = bitwardenDownloadUrl();
  if (!url) {
    fail(`Automatic Bitwarden setup is not yet available for ${process.platform}/${process.arch}.`);
    return false;
  }

  const runtimeDir = path.dirname(LOCAL_BW);
  const zipPath = path.join(runtimeDir, "bitwarden-cli.zip");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    if (!extractCli(zipPath, runtimeDir) || !existsSync(LOCAL_BW)) {
      throw new Error("the downloaded archive could not be unpacked");
    }
    if (!isWin) chmodSync(LOCAL_BW, 0o700);
    activeBwPath = LOCAL_BW;
    process.env.FAVICO_BW_PATH = LOCAL_BW;
    return true;
  } catch (error) {
    fail(`Bitwarden CLI installation failed: ${error?.message || "unknown error"}`);
    return false;
  } finally {
    rmSync(zipPath, { force: true });
  }
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

async function chooseServer(currentUrl) {
  console.log("\n    Where is this Bitwarden account?");
  console.log("      1. bitwarden.com (US)");
  console.log("      2. bitwarden.eu (EU)");
  console.log("      3. A self-hosted Bitwarden/Vaultwarden server");
  const choice = await ask(dim("    Choose 1, 2 or 3 [1]: ")) || "1";
  if (choice === "2") return BITWARDEN_SERVERS.eu;
  if (choice === "3") {
    const custom = await ask(dim("    Enter the full server URL (for example https://vault.example.com): "));
    if (!validServerUrl(custom)) {
      warn("That is not a valid http/https server URL.");
      return null;
    }
    return custom.replace(/\/$/, "");
  }
  if (choice !== "1") warn("Choice not recognised; using bitwarden.com (US).");
  return BITWARDEN_SERVERS.us;
}

async function chooseLoginCommand() {
  console.log("\n    How do you sign in?");
  console.log("      1. Email and master password (recommended)");
  console.log("      2. Single sign-on (SSO)");
  console.log("      3. Personal API key (for FIDO2, Duo, or a bot-challenge message)");
  const choice = await ask(dim("    Choose 1, 2 or 3 [1]: ")) || "1";
  if (choice === "2") return loginArgs("sso");
  if (choice === "3") return loginArgs("apikey");
  if (choice !== "1") warn("Choice not recognised; using email and master password.");
  return loginArgs("password");
}

async function loginToBitwarden(initialStatus) {
  let status = initialStatus;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const server = await chooseServer(status?.serverUrl);
    if (!server) {
      if (attempt < 3 && await askYes("    Try choosing the server again?")) continue;
      return status;
    }
    info(`Connecting this private CLI to ${serverLabel(server)}…`);
    const configured = bwInherit(["config", "server", server]);
    if (configured.status !== 0) {
      warn("Bitwarden could not save that server setting.");
    } else {
      const command = await chooseLoginCommand();
      console.log(dim("    Favico does not read or store anything entered into Bitwarden's prompts.\n"));
      bwInherit(command);
      status = bwStatus();
      if (status && status.status !== "unauthenticated") return status;
      warn("Bitwarden still reports this CLI as logged out.");
      console.log(dim("    Check the selected US/EU/self-hosted server and the message Bitwarden printed above."));
      console.log(dim("    FIDO2 and Duo accounts need the Personal API key option; SSO accounts need SSO."));
    }
    if (attempt >= 3 || !await askYes("    Try another server or sign-in method now?")) return status;
  }
  return status;
}

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
    warn("A working Bitwarden CLI (bw) was not found.");
    if (await askYes("    Download Bitwarden's official standalone CLI for Favico?")) {
      info("Downloading the dependency-free Bitwarden CLI into Favico's private folder…");
      await installBundledCli();
      ver = bwCapture(["--version"]);
    }
    if (ver.status !== 0) {
      fail("Bitwarden CLI is still unavailable. Re-run and approve the private download, or install bw from bitwarden.com/help/cli/.");
      process.exit(1);
    }
  }
  ok(`Bitwarden CLI ${(ver.stdout || "").trim()}`);

  // 2 ── Login (only if needed) ───────────────────────────────────────
  console.log(bold("\n  Step 2 of 4 — Bitwarden account"));
  let st = bwStatus();
  if (!st || st.status === "unauthenticated") {
    info("You're not logged in. Let's select the correct account server and sign-in method.");
    st = await loginToBitwarden(st);
    if (!st || st.status === "unauthenticated") {
      fail("Bitwarden is still logged out. The exact Bitwarden message above identifies the remaining account-side issue.");
      process.exit(1);
    }
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
    env: { ...process.env, BW_SESSION: session, ...(activeBwPath ? { FAVICO_BW_PATH: activeBwPath } : {}) },
  });
  process.exit(ui.status || 0);
}

main().catch((e) => { fail("Unexpected error: " + (e && e.message)); process.exit(1); });

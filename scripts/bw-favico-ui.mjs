#!/usr/bin/env node
/*
 * Local web UI to manage Bitwarden favicons via favico.app.
 *
 * Lists every login entry with its icon, split into:
 *   1) No icon + favico HAS a match  (checked by default → "Add icons" button)
 *   2) No icon + no favico match      (search the library or upload a custom one)
 *   3) Has an icon                     (option to replace via the library)
 *
 * Applying = prepend https://<name>.favico.app as URI 1 (match = Never) and push
 * existing URIs down, so Bitwarden shows that icon but autofill is unaffected.
 *
 * Run:
 *   npm i -g @bitwarden/cli
 *   bw login && export BW_SESSION=$(bw unlock --raw)
 *   # (the tool also auto-creates an ENCRYPTED backup on launch — see backups/)
 *   # optional: set BW_BACKUP_PASSWORD for a portable password-protected backup
 *   node scripts/bw-favico-ui.mjs            # then open the printed localhost URL
 */
import http from "http";
import { execFileSync, spawn } from "child_process";
import { mkdirSync, statfsSync } from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// Silence the Bitwarden CLI's noisy "punycode is deprecated" warning. bw is a
// Node app, so it inherits this and drops the DeprecationWarning lines.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--no-deprecation"].filter(Boolean).join(" ");

const SESSION = process.env.BW_SESSION;
const PORT = Number(process.env.PORT) || 8787;
const FAVICO = "https://www.favico.app";
const ROOT = "favico.app";
const BW_ICONS = "https://icons.bitwarden.net";
const MATCH_NEVER = 5;
const VERSION = "2.1.0";
// Per-run token: the served page carries it and every /api call must echo it.
// Stops a random website (or DNS rebinding) from driving the local server.
const UI_TOKEN = crypto.randomBytes(18).toString("hex");

// favico funnel mark — served locally so the tool's own tab shows the brand icon (no network needed)
const ICON_SVG = `<svg id="Layer_1" xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 600 600">
  <defs>
    <linearGradient id="favico" x1="93.75" y1="37.5" x2="506.25" y2="581.25" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FF8A1E"/>
      <stop offset="0.24" stop-color="#FF3D5F"/>
      <stop offset="0.46" stop-color="#F02D86"/>
      <stop offset="0.64" stop-color="#B23BE0"/>
      <stop offset="0.82" stop-color="#7A3DF2"/>
      <stop offset="1" stop-color="#2E5BFF"/>
    </linearGradient>
    <style>
      .st0 { fill: url(#favico); stroke: url(#favico); stroke-miterlimit: 10; }
    </style>
  </defs>
  <path class="st0" d="M113.35,100c-27.61,0-50,22.39-50,50v300c0,27.61,22.39,50,50,50s50-22.39,50-50V150c0-27.61-22.39-50-50-50Z"/>
  <path class="st0" d="M234.06,150c-27.61,0-50,22.39-50,50v200c0,27.61,22.39,50,50,50s50-22.39,50-50v-200c0-27.61-22.39-50-50-50Z"/>
  <path class="st0" d="M354.78,200c-27.61,0-50,22.39-50,50v100c0,27.61,22.39,50,50,50s50-22.39,50-50v-100c0-27.61-22.39-50-50-50Z"/>
  <path class="st0" d="M541.13,275.09l-81.16-33.25c-16.45-6.74-34.48,5.36-34.48,23.13v66.51c0,17.78,18.03,29.87,34.48,23.13l81.16-33.25c20.7-8.48,20.7-37.79,0-46.27Z"/>
</svg>`;

const isWin = process.platform === "win32";
const MIN_FREE_BYTES = 250 * 1024 * 1024;
function diskFullError(target) {
  const root = path.parse(path.resolve(target)).root || target;
  const error = new Error(`${root} does not have enough free space for Bitwarden to save safely. Free at least 250 MB, then run Favico again. No further vault changes were attempted.`);
  error.code = "ENOSPC";
  return error;
}
function assertWorkingSpace() {
  for (const target of [...new Set([process.cwd(), process.env.APPDATA].filter(Boolean))]) {
    try {
      const stats = statfsSync(target);
      if (Number(stats.bavail) * Number(stats.bsize) < MIN_FREE_BYTES) throw diskFullError(target);
    } catch (error) {
      if (error?.code === "ENOSPC") throw error;
      // If a platform cannot report space, let Bitwarden handle the operation.
    }
  }
}
function safeBwError(error, operation) {
  const raw = [error?.message, error?.stderr?.toString(), error?.stdout?.toString()].filter(Boolean).join("\n");
  if (/ENOSPC|no space left on device/i.test(raw)) return diskFullError(process.env.APPDATA || process.cwd());
  const message = /out of date/i.test(raw)
    ? "Bitwarden says this entry is out of date. Sync Bitwarden, then retry."
    : /session|vault is locked|not logged in/i.test(raw)
      ? "The Bitwarden session expired or locked. Run Favico again to unlock it."
      : `Bitwarden could not complete the ${operation} operation. Sync Bitwarden and retry.`;
  const safe = new Error(message);
  safe.code = "BW_COMMAND_FAILED";
  return safe;
}
// On Windows the CLI is bw.cmd/bw.ps1; spawn it through cmd so PATHEXT resolves
// it and Node's .cmd-spawn restriction doesn't bite.
function runBw(args, opts) {
  const a = [...args, ...(SESSION ? ["--session", SESSION] : [])];
  try {
    return isWin ? execFileSync("cmd", ["/c", "bw", ...a], opts) : execFileSync("bw", a, opts);
  } catch (error) {
    throw safeBwError(error, args[0] || "requested");
  }
}
function bw(args) {
  return runBw(args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// Friendly label for the Bitwarden server region from `bw status`.serverUrl.
function serverLabel(u) {
  if (!u) return "bitwarden.com (US, default)";
  const h = u.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (h.includes("bitwarden.eu")) return h + " (EU)";
  if (h.includes("bitwarden.com")) return h + " (US)";
  return h + " (self-hosted)";
}

// Web-vault base URL for "open this entry" deep links, from `bw status`.serverUrl.
// The desktop app has no per-item deep links, so the web vault is the target.
let VAULT_WEB = "https://vault.bitwarden.com";
function vaultWebUrl(u) {
  if (!u) return "https://vault.bitwarden.com";
  const base = u.replace(/\/+$/, "");
  if (base.includes("bitwarden.eu")) return "https://vault.bitwarden.eu";
  if (base.includes("bitwarden.com")) return "https://vault.bitwarden.com";
  return base; // self-hosted serves the web vault at the base URL
}

const MULTI = new Set(["co.uk","org.uk","ac.uk","gov.uk","com.au","net.au","org.au","co.nz","co.jp","co.kr","co.in","com.br","com.cn","com.mx","com.tr","co.za","com.sg","com.hk","com.tw","com.ua","co.il","com.ar","com.co","com.my"]);
const VALID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const hostOf = (uri) => { try { const u = new URL(uri.includes("://") ? uri : `https://${uri}`); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "").toLowerCase() : null; } catch { return null; } };
const validLoginUri = (uri) => Boolean(hostOf(uri)) || /^[a-z][a-z0-9+.-]*:\S+$/i.test(uri);
const brandOf = (h) => { if (!h) return null; const p = h.split(".").filter(Boolean); if (p.length < 2) return null; const l2 = p.slice(-2).join("."); const b = MULTI.has(l2) && p.length >= 3 ? p[p.length-3] : p[p.length-2]; return VALID.test(b) ? b : null; };
const slug = (s) => { const v = (s||"").toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/-+/g,"-").replace(/^-+|-+$/g,"").slice(0,63); return VALID.test(v) ? v : null; };

// Node's fetch has no default timeout — one slow/blackholed host could stall the
// scan for minutes (the "stuck at 99%" tail). Cap every icon-service request.
const FETCH_TIMEOUT = 8000;
function imageDimensions(buf) {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 8 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1 && buf.readUInt16LE(4) > 0) {
    return { width: buf[6] || 256, height: buf[7] || 256 };
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    const kind = buf.subarray(12, 16).toString("ascii");
    if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L" && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const size = buf.readUInt16BE(offset + 2);
      if (size < 2 || offset + 2 + size > buf.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
      }
      offset += 2 + size;
    }
  }
  return { width: null, height: null };
}
const needsQualityImprovement = (icon) =>
  icon.kind === "icon" && icon.width > 0 && icon.height > 0 && icon.width <= 47 && icon.height <= 47;

async function inspectIcon(url) {
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (r.ok) {
      const bytes = Buffer.from(await r.arrayBuffer());
      const hash = crypto.createHash("sha1").update(bytes).digest("hex");
      return { kind: "icon", hash, status: r.status, ...imageDimensions(bytes) };
    }
    // Bitwarden historically returned a fixed placeholder image for missing
    // icons, but now also returns 404/503. A known-icon health probe below
    // distinguishes the new missing response from a real service outage.
    if (r.status === 404 || r.status === 503) return { kind: "missing", hash: null, status: r.status };
    return { kind: "unavailable", hash: null, status: r.status };
  } catch {
    return { kind: "unavailable", hash: null, status: null };
  }
}
async function probeBitwardenIconService(requestIcon = inspectIcon) {
  const health = await requestIcon(`${BW_ICONS}/google.com/icon.png`);
  if (health.kind !== "icon") {
    throw new Error("Bitwarden's icon service is unavailable. Your vault was not changed; please try again later.");
  }

  const defaultHashes = new Set();
  let missingResponses = 0;
  for (const host of ["zzqq-no-such-9988.com", "qx7-nonexistent-brand-22.com", "example.com"]) {
    const result = await requestIcon(`${BW_ICONS}/${host}/icon.png`);
    if (result.kind === "icon") defaultHashes.add(result.hash);
    else if (result.kind === "missing") missingResponses++;
  }
  if (!defaultHashes.size && !missingResponses) {
    throw new Error("Bitwarden's icon service could not confirm missing icons. Your vault was not changed; please try again later.");
  }
  return defaultHashes;
}
async function favicoExists(name) { try { const r = await fetch(`${FAVICO}/api/icons?subdomain=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }); return !!(await r.json()).exists; } catch { return false; } }
async function pool(items, n, w) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await w(items[i++]); })); }

function backupVault() {
  const dir = "backups";
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `vault-${ts}-encrypted.json`);
  const pw = process.env.BW_BACKUP_PASSWORD;
  // Encrypted export (no plaintext on disk). Default = account-restricted
  // (re-importable to THIS Bitwarden account). Set BW_BACKUP_PASSWORD for a
  // portable, password-protected export instead.
  const args = ["export", "--output", file, "--format", "encrypted_json"];
  if (pw) args.push("--password", pw);
  runBw(args, { stdio: "inherit" }); // stdio inherited so any prompt is answerable
  return file;
}

// Suggest a cleaner display name for URL/package-style entry names.
const TLDISH = new Set(["com","org","net","io","app","co","dev","me","gov","edu","info","biz","tv","ai","xyz","studio","online","site","cloud"]);
const RENAME_MULTI = new Set(["com.au","co.uk","co.nz","com.br","co.jp","co.in","com.sg","co.za","com.mx","org.uk","net.au","org.au"]);
// Words that are too generic to be the brand if they're the last package segment.
const GENERIC_SEG = new Set(["app","apps","android","androidapp","ios","mobile","client","prod","production","main","www","web","beta","release","free","lite","music","studio","core","ui","tv","game","games","cam","camera","battery","security","home","smart","smarthome","life","hub","connect","control","remote","watch","wear","health","fit","fitness","tracker","device","devices","scanner","manager","portal","account","login","auth"]);
function splitWords(seg){ return (seg||"").replace(/[_-]+/g," ").replace(/([a-z])([A-Z])/g,"$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g,"$1 $2").trim(); }
function titleCase(s){ return splitWords(s).split(/\s+/).filter(Boolean).map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(" "); }
// Multi-tenant platform domains (identity providers + SaaS): the brand lives in the
// tenant subdomain, not in the platform domain itself.
const TENANT_HOSTS = new Set(["b2clogin.com","okta.com","oktapreview.com","okta-emea.com","auth0.com","onelogin.com","microsoftonline.com","pingone.com","redcatcloud.com.au","myshopify.com"]);
// Pull a brand out of a tenant label like "prodcompassionaub2c" → "compassion".
function cleanTenant(t){
  let x=(t||"").toLowerCase();
  x=x.replace(/^(production|prod|development|dev|staging|stage|stg|sandbox|sbx|preprod|nonprod|test|tst|uat|qa|demo|int)/,"");
  let p; do{ p=x; x=x.replace(/(b2clogin|b2c|signin|login|sso|oauth|auth|tenant|idp|aad|ad)$/,""); }while(x!==p);
  const m=x.match(/^(.*?)(usa|au|us|uk|gb|eu|nz|ca|in|sg|za|ie|de|fr|es|it|jp|cn|hk|br|mx)$/); // peel a trailing region code
  if(m && m[1].length>=4) x=m[1];
  return x;
}
function suggestClean(raw){
  let s=(raw||"").trim();
  if(!s || /\s/.test(s)) return null;            // already has spaces → looks human
  s=s.replace(/^[a-z][a-z0-9+.-]*:\/\//i,"").split("/")[0].split("?")[0].split(":")[0];
  if(!s.includes(".")) return null;
  const partsOrig=s.split(".").filter(Boolean);
  const parts=partsOrig.map((p)=>p.toLowerCase());
  if(parts.length<2) return null;
  let brand, suffix="";
  if(TLDISH.has(parts[0])){
    // reverse-DNS package id. tld.vendor[.generic] → vendor (e.g. com.picsart.studio
    // → Picsart). But a longer tld.publisher.platform.App, e.g.
    // com.netflix.NGP.WorldofGooHD, is the *App*, not the publisher → use the last
    // segment (keeping its original case so camelCase splits into words).
    const li=parts.length-1;
    if(parts.length>=4 && parts[li].length>2 && !GENERIC_SEG.has(parts[li])) brand=partsOrig[li];
    else brand=parts[1];
  } else {
    const last2=parts.slice(-2).join(".");
    const reg=(RENAME_MULTI.has(last2)&&parts.length>=3)?parts.slice(-3).join("."):last2;
    if(TENANT_HOSTS.has(reg) && parts.length>reg.split(".").length){
      // multi-tenant platform (Azure B2C, Okta, Auth0, Redcat, Shopify…) — the brand
      // is the tenant subdomain, not the platform. e.g. schnitz.redcatcloud.com.au
      const cleaned=cleanTenant(parts[0]);
      brand = cleaned.length>=3 ? cleaned : parts[0];
    } else {
      const idx=(RENAME_MULTI.has(last2)&&parts.length>=3)?parts.length-3:parts.length-2;
      if(idx<0) return null;
      brand=parts[idx];
      if(idx>0 && parts[0]==="api") suffix=" API";  // api.printnode.com → Printnode API
    }
  }
  if(!brand || brand.length<2) return null;
  const clean=titleCase(brand)+suffix;
  if(clean.toLowerCase()===(raw||"").toLowerCase()) return null;
  return clean;
}

const byId = new Map(); // id -> bw item (kept in sync after edits)
let SECTIONS = { s1: [], s2: [], quality: [], s3: [], renames: [], dups: [], editor: [] };

// Likely-duplicate logins. Grouped strictly: the SAME site host plus the same
// username (or, when there's no username, the same host + same name). Using the full
// host (not just the brand) avoids lumping different services of one company together.
// Detection uses ONLY non-secret fields — passwords are never read or compared.
function computeDups(logins) {
  const dmap = new Map();
  for (const it of logins) {
    const host = it.login.uris.map((u) => hostOf(u.uri)).find(Boolean) || null;
    if (!host) continue;
    const user = (it.login.username || "").trim().toLowerCase();
    const key = user ? host + "|" + user : host + "|name:" + (it.name || "").trim().toLowerCase();
    if (!dmap.has(key)) dmap.set(key, []);
    dmap.get(key).push({ id: it.id, name: it.name || "(no name)", host, username: it.login.username || "" });
  }
  return [...dmap.values()].filter((g) => g.length > 1)
    .sort((a, b) => (a[0].host || a[0].name).localeCompare(b[0].host || b[0].name));
}

async function classify(onProgress) {
  bw(["sync"]);
  const items = JSON.parse(bw(["list", "items"]));
  const allLogins = items.filter((it) => it.type === 1);
  const logins = allLogins.filter((it) => it.login?.uris?.length);
  byId.clear();
  for (const it of allLogins) byId.set(it.id, it);

  // Confirm a known icon works before treating Bitwarden's 404/503 response as
  // a missing icon. Older deployments return a placeholder image instead, so
  // retain its hash when present.
  const defaultHashes = await probeBitwardenIconService();

  // Download community hints once (public, aggregated — nothing is sent). Used both
  // to auto-match icons (host → icon) and to improve rename suggestions below.
  const learnedRenames = new Map(), learnedIcons = new Map();
  try {
    const r = await fetch(`${FAVICO}/api/learn`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (r.ok) {
      const d = await r.json();
      for (const m of (d.renames || [])) if (!learnedRenames.has(m.from)) learnedRenames.set(m.from, m.to);
      for (const m of (d.icons || [])) if (!learnedIcons.has(m.host)) learnedIcons.set(m.host, m.cand);
    }
  } catch { /* hints are optional */ }

  const s1 = [], s2 = [], s3 = [], quality = [];
  let progressed = 0;
  if (onProgress) onProgress(0, logins.length);
  await pool(logins, 8, async (it) => {
   try {
    const host = it.login.uris.map((u) => hostOf(u.uri)).find(Boolean) || null;
    const already = host && (host === ROOT || host.endsWith(`.${ROOT}`));
    const icon = host ? await inspectIcon(`${BW_ICONS}/${host}/icon.png`) : { kind: "missing", hash: null };
    // Only a confirmed missing response is actionable. Unexpected per-host
    // failures are left alone so a transient error cannot trigger bad edits.
    const hasIcon = already
      || icon.kind === "unavailable"
      || (icon.kind === "icon" && !defaultHashes.has(icon.hash));
    if (hasIcon) {
      const entry = { id: it.id, name: it.name || "(no name)", host, iconUrl: host ? `${BW_ICONS}/${host}/icon.png` : null, width: icon.width || null, height: icon.height || null };
      s3.push(entry);
      if (needsQualityImprovement(icon)) quality.push(entry);
      return;
    }
    const cands = [...new Set([(host ? learnedIcons.get(host) : null), brandOf(host), slug(it.name)].filter(Boolean))];
    let cand = null;
    for (const c of cands) { if (await favicoExists(c)) { cand = c; break; } }
    if (cand) s1.push({ id: it.id, name: it.name || "(no name)", host, cand, iconUrl: `https://${cand}.${ROOT}/favicon.ico` });
    else s2.push({ id: it.id, name: it.name || "(no name)", host });
   } finally {
    if (onProgress) onProgress(++progressed, logins.length);
   }
  });
  const byName = (a, b) => a.name.localeCompare(b.name);
  const learnKey = (s) => (s || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  const suggestName = (name) => {
    const hint = learnedRenames.get(learnKey(name));         // crowd hint wins when present
    if (hint && hint.toLowerCase() !== learnKey(name)) return hint;
    return suggestClean(name);                               // else the local heuristic
  };
  const renames = logins
    .map((it) => ({ id: it.id, current: it.name || "(no name)", suggested: suggestName(it.name), host: it.login.uris.map((u) => hostOf(u.uri)).find(Boolean) || null }))
    .filter((r) => r.suggested && r.suggested !== r.current)
    .sort((a, b) => a.current.localeCompare(b.current));

  const dups = computeDups(logins);
  const editor = allLogins.map((it) => {
    const uris = (it.login?.uris || []).map((u) => u.uri || "").filter(Boolean);
    const host = uris.map(hostOf).find(Boolean) || null;
    return {
      id: it.id,
      name: it.name || "(no name)",
      host,
      uris,
      iconUrl: host ? `${BW_ICONS}/${host}/icon.png` : null,
    };
  }).sort(byName);

  SECTIONS = { s1: s1.sort(byName), s2: s2.sort(byName), quality: quality.sort(byName), s3: s3.sort(byName), renames, dups, editor };
}

function applyRename(id, name) {
  const it = byId.get(id);
  if (!it) throw new Error("unknown item");
  const nm = (name || "").trim().slice(0, 200);
  if (!nm) throw new Error("empty name");
  it.name = nm;
  bw(["edit", "item", id, Buffer.from(JSON.stringify(it)).toString("base64")]);
}

function applyFavico(id, cand) {
  const it = byId.get(id);
  if (!it) throw new Error("unknown item");
  if (!VALID.test(cand)) throw new Error("invalid icon name");
  it.login.uris = [{ match: MATCH_NEVER, uri: `https://${cand}.${ROOT}` }, ...(it.login.uris || [])];
  bw(["edit", "item", id, Buffer.from(JSON.stringify(it)).toString("base64")]);
}

// Apply a rename and/or an icon to one item in a SINGLE edit, so each item is
// written exactly once. Editing the same item twice in a run fails with
// Bitwarden's "item is out of date" (the first edit bumps its revisionDate).
function applyChanges(id, { cand, name, uris: nextUris }) {
  const it = byId.get(id);
  if (!it) throw new Error("unknown item");
  if (name !== undefined) {
    const nm = (name || "").trim().slice(0, 200);
    if (!nm) throw new Error("empty name");
    it.name = nm;
  }
  if (nextUris !== undefined) {
    const uris = [...new Set((nextUris || []).map((uri) => (uri || "").trim()).filter(Boolean))];
    if (!uris.every(validLoginUri)) throw new Error("invalid web address");
    const previous = it.login.uris || [];
    it.login.uris = uris.map((uri, index) => previous[index]?.match === undefined
      ? { uri }
      : { uri, match: previous[index].match });
  }
  if (cand !== undefined) {
    if (!VALID.test(cand)) throw new Error("invalid icon name");
    const uris = it.login.uris || [];
    // drop any existing favico URI, then add the chosen one as URI 1 (no stacking)
    const rest = uris.filter((u) => { const h = hostOf(u.uri); return !(h && (h === ROOT || h.endsWith(`.${ROOT}`))); });
    it.login.uris = [{ match: MATCH_NEVER, uri: `https://${cand}.${ROOT}` }, ...rest];
  }
  bw(["edit", "item", id, Buffer.from(JSON.stringify(it)).toString("base64")]);
}

function deleteItem(id) {
  const it = byId.get(id);
  if (!it) throw new Error("unknown item");
  bw(["delete", "item", id]); // soft-delete to Trash (recoverable); never --permanent
  byId.delete(id);
}

// Equality signature for "same login" — username + password. Computed locally;
// only used to compare, never returned/shown/logged.
const loginSig = (it) => (it.login?.username || "") + "\0" + (it.login?.password || "");

// Describe exactly which safe-to-display parts of duplicate entries differ.
// Secret values are compared locally but never returned to the browser.
function duplicateComparison(items, comparePasswords = false) {
  const same = (values) => values.every((value) => value === values[0]);
  const stable = (value) => JSON.stringify(value ?? null);
  const secretLabels = (values, emptyLabel, savedLabel) => {
    const unique = [...new Set(values.filter(Boolean))];
    return values.map((value) => !value
      ? emptyLabel
      : `${savedLabel}${unique.length > 1 ? ` ${unique.indexOf(value) + 1}` : ""}`);
  };
  const entries = items.map((it) => {
    const login = it.login || {};
    const uris = (login.uris || []).map((u) => u.uri || "").filter(Boolean);
    const fields = it.fields || [];
    const attachments = it.attachments || [];
    const useful = [
      login.password,
      login.totp,
      ...(login.fido2Credentials || []),
      it.notes,
      ...fields,
      ...attachments,
    ].filter(Boolean);
    return {
      id: it.id,
      name: it.name || "(no name)",
      username: login.username || "",
      uris,
      passwordSig: login.password || "",
      totpSig: login.totp || "",
      passkeySig: stable(login.fido2Credentials || []),
      passkeyCount: (login.fido2Credentials || []).length,
      notesSig: it.notes || "",
      fieldsSig: stable(fields),
      fieldNames: fields.map((f) => f.name || "unnamed"),
      attachmentsSig: stable(attachments),
      attachmentNames: attachments.map((a) => a.fileName || "unnamed"),
      favorite: Boolean(it.favorite),
      reprompt: Number(it.reprompt || 0),
      revisionDate: it.revisionDate || "",
      mostlyEmpty: useful.length === 0,
    };
  });
  const differences = [];
  const add = (label, raw, display = raw) => {
    if (!same(raw)) differences.push({ label, values: display });
  };
  add("Name", entries.map((e) => e.name));
  add("Username", entries.map((e) => e.username), entries.map((e) => e.username || "No username"));
  add("Web addresses", entries.map((e) => stable(e.uris)), entries.map((e) => e.uris.length ? e.uris.join("\n") : "No web address"));
  if (comparePasswords) {
    const passwords = entries.map((e) => e.passwordSig);
    add("Password", passwords, secretLabels(passwords, "No password", "Saved password"));
  }
  const totp = entries.map((e) => e.totpSig);
  add("Authenticator key", totp, secretLabels(totp, "None", "Saved key"));
  add("Passkeys", entries.map((e) => e.passkeySig), entries.map((e) => `${e.passkeyCount} saved`));
  const notes = entries.map((e) => e.notesSig);
  add("Notes", notes, secretLabels(notes, "No notes", "Notes saved"));
  add("Custom fields", entries.map((e) => e.fieldsSig), entries.map((e) => e.fieldNames.length ? `${e.fieldNames.length} saved: ${e.fieldNames.join(", ")}` : "None"));
  add("Attachments", entries.map((e) => e.attachmentsSig), entries.map((e) => e.attachmentNames.length ? `${e.attachmentNames.length} saved: ${e.attachmentNames.join(", ")}` : "None"));
  add("Favourite", entries.map((e) => e.favorite), entries.map((e) => e.favorite ? "Yes" : "No"));
  add("Master-password reprompt", entries.map((e) => e.reprompt), entries.map((e) => e.reprompt ? "Required" : "Not required"));
  add("Last updated", entries.map((e) => e.revisionDate), entries.map((e) => e.revisionDate ? new Date(e.revisionDate).toLocaleString() : "Unknown"));
  return {
    passwordCompared: comparePasswords,
    entries: entries.map(({ passwordSig, totpSig, passkeySig, notesSig, fieldsSig, attachmentsSig, ...entry }) => entry),
    differences,
  };
}

// Merge entries that are the same login: keep one, union their URIs, carry over
// any field the primary lacks, and Trash the rest (recoverable).
function mergeItems(ids, keepId) {
  const items = ids.map((id) => byId.get(id)).filter(Boolean);
  if (items.length < 2) throw new Error("need at least two entries to merge");
  if (!items.every((it) => loginSig(it) === loginSig(items[0]))) throw new Error("entries are not identical");
  const primary = (keepId && items.find((it) => it.id === keepId)) || items.find((it) => (it.login?.uris || []).some((u) => { const h = hostOf(u.uri); return h && (h === ROOT || h.endsWith(`.${ROOT}`)); })) || items[0];
  const others = items.filter((it) => it.id !== primary.id);
  primary.login = primary.login || {};
  const seen = new Set(); const uris = [];
  for (const it of [primary, ...others]) for (const u of (it.login?.uris || [])) { const k = (u.uri || "").toLowerCase(); if (!seen.has(k)) { seen.add(k); uris.push(u); } }
  primary.login.uris = uris;
  for (const it of others) {
    if (!primary.login.totp && it.login?.totp) primary.login.totp = it.login.totp;
    if (!(primary.login.fido2Credentials || []).length && (it.login?.fido2Credentials || []).length) primary.login.fido2Credentials = it.login.fido2Credentials;
    if (!primary.notes && it.notes) primary.notes = it.notes;
    if ((it.fields || []).length) primary.fields = [...(primary.fields || []), ...it.fields];
  }
  const out = bw(["edit", "item", primary.id, Buffer.from(JSON.stringify(primary)).toString("base64")]);
  // Refresh the kept item (new revisionDate) so a later icon/rename edit on it
  // doesn't fail with Bitwarden's "item is out of date".
  try { const updated = JSON.parse(out); if (updated && updated.id) byId.set(updated.id, updated); } catch { /* keep old */ }
  for (const it of others) deleteItem(it.id);
  return { kept: primary.id, removed: others.map((o) => o.id) };
}

function revertAll() {
  let n = 0;
  for (const it of byId.values()) {
    const uris = it.login?.uris || [];
    const kept = uris.filter((u) => { const h = hostOf(u.uri); return !(h && (h === ROOT || h.endsWith(`.${ROOT}`))); });
    if (kept.length !== uris.length) {
      it.login.uris = kept;
      bw(["edit", "item", it.id, Buffer.from(JSON.stringify(it)).toString("base64")]);
      n++;
    }
  }
  return n;
}

async function uploadCustom(name, dataUrl, listed = true) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!m) throw new Error("bad image data");
  const buf = Buffer.from(m[2], "base64");
  let sub = slug(name);
  if (!sub) throw new Error("invalid name");
  // try the name; on collision, take the suggested -vN
  for (let attempt = 0; attempt < 2; attempt++) {
    const fd = new FormData();
    fd.set("subdomain", sub);
    fd.set("listed", listed ? "true" : "false"); // false = stored but not in public search
    fd.set("file", new Blob([buf], { type: m[1] }), "icon");
    const r = await fetch(`${FAVICO}/api/icons`, { method: "POST", body: fd });
    const d = await r.json();
    if (r.ok) return sub;
    if (r.status === 409 && d.suggestion) { sub = d.suggestion; continue; }
    throw new Error(d.error || "upload failed");
  }
  throw new Error("name unavailable");
}

function openBrowser(u) {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", u], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "darwin") spawn("open", [u], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [u], { stdio: "ignore", detached: true }).unref();
  } catch { /* user can click the printed link */ }
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readJson(req) { return new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    // DNS-rebinding guard: only accept loopback Host headers.
    const hostName = (req.headers.host || "").split(":")[0];
    if (hostName !== "localhost" && hostName !== "127.0.0.1") return send(res, 403, { error: "bad host" });
    // CSRF guard: every /api call must echo the per-run token, which only our own page knows.
    if (url.pathname.startsWith("/api/") && req.headers["x-favico-token"] !== UI_TOKEN) return send(res, 403, { error: "forbidden" });
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, HTML.replace("__UI_TOKEN__", UI_TOKEN), "text/html");
    if (req.method === "GET" && (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico")) return send(res, 200, ICON_SVG, "image/svg+xml");
    if (req.method === "GET" && url.pathname === "/api/data") return send(res, 200, { ...SECTIONS, vault: VAULT_WEB });
    if (req.method === "POST" && url.pathname === "/api/reclassify") {
      await classify();
      return send(res, 200, { ...SECTIONS, vault: VAULT_WEB });
    }
    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = url.searchParams.get("q") || "";
      const r = await fetch(`${FAVICO}/api/search?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      return send(res, 200, { results: (d.results || []).map((n) => ({ name: n, iconUrl: `https://${n}.${ROOT}/favicon.ico` })) });
    }
    if (req.method === "POST" && url.pathname === "/api/rename") {
      const { items = [] } = await readJson(req);
      const out = [];
      for (const { id, name } of items) { try { applyRename(id, name); out.push({ id, ok: true }); } catch (e) { out.push({ id, ok: false, error: e.message }); } }
      return send(res, 200, { results: out });
    }
    if (req.method === "POST" && url.pathname === "/api/apply") {
      const { items = [] } = await readJson(req);
      const out = [];
      for (const { id, cand } of items) { try { applyFavico(id, cand); out.push({ id, ok: true }); } catch (e) { out.push({ id, ok: false, error: e.message }); } }
      return send(res, 200, { results: out });
    }
    if (req.method === "POST" && url.pathname === "/api/apply-one") {
      const { id, cand } = await readJson(req);
      try { applyFavico(id, cand); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/dup-status") {
      // Secret values never leave this process; the browser receives only
      // same/different labels and safe display fields.
      const comparePasswords = url.searchParams.get("passwords") === "1";
      const groups = (SECTIONS.dups || []).map((g) => {
        const items = g.map((e) => byId.get(e.id)).filter(Boolean);
        return duplicateComparison(items, comparePasswords);
      });
      return send(res, 200, { groups });
    }
    if (req.method === "POST" && url.pathname === "/api/rescan-dups") {
      // Re-sync the vault and rebuild ONLY the duplicate groups (cheap — no icon
      // service checks), so fixes made directly in Bitwarden show up immediately.
      bw(["sync"]);
      const items = JSON.parse(bw(["list", "items"]));
      const logins = items.filter((it) => it.type === 1 && it.login?.uris?.length);
      byId.clear();
      for (const it of logins) byId.set(it.id, it);
      SECTIONS.dups = computeDups(logins);
      return send(res, 200, { dups: SECTIONS.dups });
    }
    if (req.method === "POST" && url.pathname === "/api/commit") {
      const { icons = [], renames = [], urls = [], deletes = [], merges = [], report = false, synonyms = [] } = await readJson(req);
      const results = { icons: [], renames: [], urls: [], deletes: [], merges: [] };
      // Stream NDJSON progress so the browser can show a live bar + per-item log.
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
      const emit = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch { /* client gone */ } };
      const nameOf = (id) => { const it = byId.get(id); return (it && it.name) || id; };
      // Per-item changes (each item edited once).
      const changes = new Map();
      for (const { id, cand } of icons) { const c = changes.get(id) || {}; c.cand = cand; changes.set(id, c); }
      for (const { id, name } of renames) { const c = changes.get(id) || {}; c.name = name; changes.set(id, c); }
      for (const { id, uris } of urls) { const c = changes.get(id) || {}; c.uris = uris; changes.set(id, c); }
      const total = merges.length + changes.size + deletes.length;
      let done = 0;
      const finish = (label, ok, error) => { done++; emit({ type: "done_item", done, total, label, ok, error }); };
      const tick = () => new Promise((r) => setImmediate(r)); // yield so each chunk flushes
      const hints = [], iconMatches = [], uses = []; // opted-in sharing
      try {
        emit({ type: "start", total });
        assertWorkingSpace();
        // 1) merges first (so the surviving entry is fresh before icon/rename edits)
        for (const m of merges) {
          const label = `Merging duplicates of “${nameOf(m.keep)}”`;
          emit({ type: "doing", label }); await tick();
          try { const r = mergeItems(m.ids || [], m.keep); results.merges.push({ ok: true, id: m.keep, ...r }); finish(label, true); }
          catch (e) { results.merges.push({ ok: false, id: m && m.keep, error: e.message }); finish(label, false, e.message); if (e.code === "ENOSPC") throw e; }
        }
        // 2) icon and/or rename per item
        for (const [id, c] of changes) {
          const it = byId.get(id);
          const before = it?.name;
          const label = [c.cand, c.name, c.uris].filter((value) => value !== undefined).length > 1 ? `Updating “${before || id}”`
            : (c.cand !== undefined) ? `Setting icon for “${before || id}”`
            : (c.name !== undefined) ? `Renaming “${before || id}” → “${c.name}”`
            : `Updating web addresses for “${before || id}”`;
          emit({ type: "doing", label }); await tick();
          let host = null;
          for (const u of (it?.login?.uris || [])) { const hh = hostOf(u.uri); if (hh && !(hh === ROOT || hh.endsWith(`.${ROOT}`))) { host = hh; break; } }
          try {
            applyChanges(id, c);
            if (c.cand !== undefined) { results.icons.push({ id, ok: true }); uses.push(c.cand); if (host) iconMatches.push({ host, cand: c.cand }); }
            if (c.name !== undefined) { results.renames.push({ id, ok: true }); if (before && before !== c.name) hints.push({ from: before, to: c.name }); }
            if (c.uris !== undefined) results.urls.push({ id, ok: true });
            finish(label, true);
          } catch (e) {
            if (c.cand !== undefined) results.icons.push({ id, ok: false, error: e.message });
            if (c.name !== undefined) results.renames.push({ id, ok: false, error: e.message });
            if (c.uris !== undefined) results.urls.push({ id, ok: false, error: e.message });
            finish(label, false, e.message);
            if (e.code === "ENOSPC") throw e;
          }
        }
        // 3) deletes (soft-delete to Trash)
        for (const id of deletes) {
          const label = `Moving “${nameOf(id)}” to Trash`;
          emit({ type: "doing", label }); await tick();
          try { deleteItem(id); results.deletes.push({ id, ok: true }); finish(label, true); }
          catch (e) { results.deletes.push({ id, ok: false, error: e.message }); finish(label, false, e.message); if (e.code === "ENOSPC") throw e; }
        }
        // 4) opt-in anonymous hints (best-effort, timeout-capped so the stream can't hang)
        if (report && (hints.length || iconMatches.length || uses.length || (synonyms || []).length)) {
          emit({ type: "doing", label: "Sharing anonymous hints" });
          try { await fetch(`${FAVICO}/api/learn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ renames: hints, iconMatches, uses, synonyms }), signal: AbortSignal.timeout(FETCH_TIMEOUT) }); } catch { /* best-effort */ }
        }
        emit({ type: "done", results });
      } catch (e) {
        emit({ type: "error", error: e.message, results });
      }
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/quit") {
      send(res, 200, { ok: true });
      console.error("\n  ✓ All done — favico is shutting down. You can close the browser tab.");
      setTimeout(() => process.exit(0), 150);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/revert") {
      const n = revertAll();
      await classify(); // refresh sections after removing favico URIs
      return send(res, 200, { reverted: n });
    }
    if (req.method === "POST" && url.pathname === "/api/upload") {
      const { name, dataUrl, listed = true } = await readJson(req);
      try { const sub = await uploadCustom(name, dataUrl, listed); return send(res, 200, { ok: true, cand: sub }); }
      catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/upload-apply") {
      const { id, name, dataUrl, listed = true } = await readJson(req);
      try { const sub = await uploadCustom(name, dataUrl, listed); applyFavico(id, sub); return send(res, 200, { ok: true, cand: sub }); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>favico × Bitwarden</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
:root{color-scheme:light dark}
.brandword{background:linear-gradient(143deg,#ff8a1e 0%,#ff3d5f 24%,#f02d86 46%,#b23be0 64%,#7a3df2 82%,#2e5bff 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
body{font-family:system-ui,sans-serif;max-width:880px;margin:0 auto;padding:24px;line-height:1.4}
h1{margin:0 0 4px}.sub{opacity:.6;font-size:14px;margin:0 0 20px}
.ver{font-size:12px;opacity:.45;font-weight:400;vertical-align:middle}
h2{font-size:16px;margin:28px 0 6px}.hint{opacity:.6;font-size:13px;margin:0 0 10px}
.row{display:flex;align-items:center;gap:12px;padding:10px;border:1px solid #8884;border-radius:8px;margin:7px 0}
.row img{width:48px;height:48px;border-radius:8px;object-fit:contain;flex:0 0 auto;background:#8881}
.name{font-weight:600;font-size:14px}.host{opacity:.55;font-size:12px}
.grow{flex:1;min-width:0}.grow>div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{font:inherit;border:1px solid #8886;background:#8881;border-radius:7px;padding:6px 12px;cursor:pointer}
button.primary{background:#2563eb;color:#fff;border-color:#2563eb}
.arrow{opacity:.4}.done{color:#16a34a;font-size:13px;font-weight:600}.err{color:#dc2626;font-size:12px}
.pick{position:relative}.results{display:none;position:absolute;right:0;top:34px;z-index:5;background:Canvas;border:1px solid #8886;border-radius:8px;padding:6px;max-height:260px;overflow:auto;width:240px;box-shadow:0 8px 24px #0003}
.results.open{display:block}.results .r{display:flex;align-items:center;gap:8px;padding:5px;border-radius:6px;cursor:pointer}.results .r:hover{background:#8882}.results img{width:48px;height:48px;object-fit:contain}
.chosen{display:flex;align-items:center;gap:6px}.chosen img{width:48px;height:48px;object-fit:contain;border-radius:8px}
input[type=search]{font:inherit;padding:5px 8px;border:1px solid #8886;border-radius:7px;width:150px}
.bar{position:sticky;top:0;background:Canvas;padding:10px 0;display:flex;gap:10px;align-items:center;border-bottom:1px solid #8884;z-index:10}
small{opacity:.6}
.notice{margin:0 0 18px;border:1px solid #8884;border-radius:8px;padding:8px 12px;font-size:13px}
.notice summary{cursor:pointer;font-weight:600}
.notice ul{margin:8px 0 2px;padding-left:18px}.notice li{margin:4px 0}
.modal-bg{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;z-index:100}
.modal{background:Canvas;border:1px solid #8886;border-radius:12px;padding:18px;width:320px;max-width:92vw}
.modal h3{margin:0 0 8px}.modal input[type=text]{width:100%;padding:6px 8px;border:1px solid #8886;border-radius:7px;font:inherit;margin:4px 0 8px;box-sizing:border-box}
.cropbox{position:relative;width:256px;height:256px;overflow:hidden;border-radius:10px;border:1px solid #8886;background:#8881;margin:10px auto;touch-action:none;cursor:grab}
.cropbox img{position:absolute;max-width:none;user-select:none;pointer-events:none}
.previews{display:flex;gap:10px;justify-content:center;align-items:flex-end;margin:8px 0}
.previews .p{overflow:hidden;border-radius:5px;border:1px solid #8884;position:relative}
.previews .p img{position:absolute;max-width:none}
.row2{display:flex;gap:8px;margin-top:10px}
.stepper{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 18px}
.stp{display:flex;align-items:center;gap:6px;border:1px solid #8886;background:#8881;border-radius:999px;padding:5px 11px;font-size:12px;cursor:pointer}
.stp .num{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#8883;font-size:11px}
.stp.on{border-color:#2563eb;background:#2563eb22}.stp.on .num{background:#2563eb;color:#fff}
.stp.done .num{background:#16a34a;color:#fff}
.selall{display:inline-flex;align-items:center;gap:6px;font-size:13px;opacity:.85;margin:0 0 8px}
.row .curimg{width:48px;height:48px;border-radius:8px;background:#8881;flex:0 0 auto}
.navbar{display:flex;align-items:center;gap:10px;margin-top:24px;padding-top:14px;border-top:1px solid #8884}
.navbar button{padding:9px 16px}
.dupgroup{border:1px solid #8884;border-radius:8px;padding:8px 10px;margin:8px 0}
.duphdr{font-weight:600;font-size:13px;opacity:.75;margin-bottom:4px}
.dup{display:flex;align-items:center;gap:10px;padding:8px 6px;border-radius:6px}
.dup:hover{background:#8881}.dup .grow,.crow .grow{flex:1;min-width:0;display:flex;flex-direction:column}
.dup .grow span,.crow .grow span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dupnum{font-size:11px;font-weight:700;opacity:.55}
.emptybadge{display:inline-block;width:max-content;margin-top:3px;padding:2px 6px;border-radius:999px;background:#f59e0b22;color:#b45309;font-size:11px;font-weight:700}
.keepbtn{white-space:nowrap}
.keepnote{margin:8px 6px 2px;padding:8px 10px;border-radius:7px;background:#16a34a18;color:#15803d;font-size:12px;font-weight:600}
.diffs{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px}
.diffs caption{text-align:left;font-weight:700;padding:5px 6px}
.diffs th,.diffs td{text-align:left;vertical-align:top;padding:6px;border-top:1px solid #8883;white-space:pre-line;overflow-wrap:anywhere}
.diffs th{width:20%;opacity:.7}.diffs td{width:40%}
.nodiff{margin:8px 6px;font-size:12px;color:#15803d;font-weight:600}
.summary{display:flex;gap:18px;margin:10px 0;font-size:14px}
.csec{margin:16px 0}.csec h3{margin:0 0 6px;font-size:14px}
.crow{display:flex;align-items:center;gap:10px;padding:5px 8px;border:1px solid #8884;border-radius:7px;margin:4px 0}
.crow .ci{width:48px;height:48px;object-fit:contain;border-radius:8px;flex:0 0 auto}
.confirm-actions{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
.proc{font-weight:600}.result{margin-top:12px}
.iconcell{width:52px;height:52px;flex:0 0 auto;display:grid;place-items:center}
.iconcell img{width:48px;height:48px;object-fit:contain;border-radius:8px;background:#8881}
.iconcell .noicon{width:48px;height:48px;border-radius:8px;background:#8881;display:grid;place-items:center;opacity:.45;font-size:18px;font-weight:700}
.row .change{white-space:nowrap}
.modal.picker{width:440px;max-height:90vh;overflow:auto}
.tabs{display:flex;gap:6px;margin:2px 0 10px}
.tab{flex:1;padding:7px 8px;border:1px solid #8886;background:#8881;border-radius:8px;cursor:pointer;font:inherit;font-size:13px}
.tab.on{background:#2563eb;color:#fff;border-color:#2563eb}
.fld{display:block;font-size:13px;font-weight:600;margin:10px 0 2px}
.fld input[type=text],.fld input[type=search]{display:block;width:100%;margin-top:5px;padding:8px 10px;border:1px solid #8886;border-radius:8px;font:inherit;font-weight:400;box-sizing:border-box}
.fld .row-in{display:flex;gap:6px;margin-top:5px}.fld .row-in input{margin-top:0;flex:1}
.fld small{font-weight:400;opacity:.6}
.phint{font-size:12px;opacity:.75;margin:6px 0}
.grid{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;max-height:150px;overflow:auto}
.grid .ic{width:72px;height:82px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:2px solid transparent;border-radius:9px;background:#8881;cursor:pointer;padding:3px;overflow:hidden}
.grid .ic:hover{background:#8882}
.grid .ic img{width:48px;height:48px;object-fit:contain}
.grid .ic span{font-size:9px;max-width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.7}
.grid .ic.sel{border-color:#2563eb;background:#2563eb22;box-shadow:0 0 0 1px #2563eb inset}
.crop-wrap{margin-top:10px;border-top:1px solid #8884;padding-top:8px}
.zoomrow{display:flex;align-items:center;gap:8px}.zoomrow input[type=range]{flex:1}
.zreset{padding:4px 10px;font-size:12px}
.seg{display:inline-flex;border:1px solid #8886;border-radius:7px;overflow:hidden}
.seg .bgopt{border:none;border-radius:0;background:#8881;padding:5px 11px;font-size:12px;cursor:pointer}
.seg .bgopt+.bgopt{border-left:1px solid #8886}
.seg .bgopt.on{background:#2563eb;color:#fff}
.bgrow{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:13px}
.bgrow label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.bgrow input[type=color]{width:44px;height:26px;padding:0;border:1px solid #8886;border-radius:6px;background:none;cursor:pointer}
.bgrow .hexcolor{width:86px;padding:5px 7px;border:1px solid #8886;border-radius:6px;font:12px ui-monospace,monospace;text-transform:uppercase}
.checker{background-image:linear-gradient(45deg,#8884 25%,transparent 25%),linear-gradient(-45deg,#8884 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#8884 75%),linear-gradient(-45deg,transparent 75%,#8884 75%);background-size:14px 14px;background-position:0 0,0 7px,7px -7px,-7px 0}
.optrow{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid #8884;border-radius:9px;margin:8px 0}
.optrow .grow>div{white-space:normal;overflow:visible;text-overflow:clip}
.optdesc{font-size:12px;opacity:.72;margin-top:3px;line-height:1.45}
.dupgroup.willmerge,.dupgroup.willkeep{border-color:#16a34a}
.iconok{font-size:12px;color:#16a34a;margin:-2px 0 8px 64px}
.pbar{height:10px;background:#8883;border-radius:6px;overflow:hidden;margin:8px 0}
.pfill{height:100%;width:0;background:#2563eb;transition:width .25s}
.pmeta{display:flex;align-items:center;gap:10px;font-size:12px;opacity:.85}
.pcur{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdet{font:inherit;font-size:12px;padding:2px 8px}
.plog{max-height:200px;overflow:auto;font-size:12px;margin:8px 0;padding-left:20px}
.plog li{margin:2px 0}.plog li.ok{color:#16a34a}.plog li.bad{color:#dc2626}
.tally{display:flex;flex-direction:column;gap:3px;margin:12px 0;font-size:14px;font-weight:600}
.pactions{margin-top:16px;display:flex;justify-content:flex-end}
.pclose{font-size:14px;padding:8px 16px}
.switch{position:relative;display:inline-block;width:44px;height:24px;flex:0 0 auto;cursor:pointer;margin-top:2px}
.switch input{opacity:0;width:0;height:0}
.switch .track{position:absolute;inset:0;background:#8886;border-radius:999px;transition:background .15s}
.switch .track:before{content:"";position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .15s}
.switch input:checked+.track{background:#2563eb}
.switch input:checked+.track:before{transform:translateX(20px)}
.warnrow{margin-top:6px;font-size:13px;color:#b45309;font-weight:500}
.openbw{font-size:12px;white-space:nowrap;color:#2563eb;text-decoration:none;margin-left:8px}
.openbw:hover{text-decoration:underline}
.duprefresh{display:flex;justify-content:center;align-items:center;gap:8px;margin:20px 0 4px;text-align:center}
.modecards{display:grid;grid-template-columns:1.2fr 1fr;gap:14px;margin:20px 0}
.modecard{border:1px solid #8884;border-radius:12px;padding:18px;background:#88808}
.modecard.recommended{border-color:#2563eb;background:#2563eb0d}
.modecard h2{margin:0 0 6px;font-size:18px}.modecard p{font-size:13px;opacity:.75}
.modecard ul,.flowextras{font-size:13px;padding-left:20px}.modecard li,.flowextras li{margin:5px 0}
.modecard button{width:100%;padding:10px;margin-top:8px;font-weight:700}
.editoritem{border:1px solid #8884;border-radius:10px;padding:10px;margin:8px 0}
.editorhead{display:flex;align-items:center;gap:12px}
.editorfields{flex:1;min-width:0;display:grid;gap:7px}
.editorfields input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #8886;border-radius:7px;font:inherit}
.editorurls{display:grid;gap:5px;margin:8px 0 0 64px}
.editorurl{display:flex;gap:6px}.editorurl input{flex:1;min-width:0;padding:7px 9px;border:1px solid #8886;border-radius:7px;font:inherit}
.editorurl .removeurl{padding:5px 9px}.addurl{margin:7px 0 0 64px;font-size:12px}
@media(max-width:680px){.modecards{grid-template-columns:1fr}.editorhead{align-items:flex-start;flex-wrap:wrap}.editorfields{flex-basis:calc(100% - 68px)}.editorurls,.addurl{margin-left:0}.openbw{display:none}}
</style></head><body>
<h1><span class="brandword">favico</span> × Bitwarden <span class="ver">v${VERSION}</span></h1>
<p class="sub">A guided review of your logins. Adds <code>name.favico.app</code> as URI&nbsp;1 (match&nbsp;=&nbsp;Never) so Bitwarden shows the icon; your real URL moves down and still autofills. <b>Nothing is written to your vault until the final Apply step.</b></p>
<details class="notice"><summary>🔒 What leaves your machine</summary>
<ul>
<li>Your vault is decrypted <b>only on this machine</b>, using the Bitwarden session you unlocked. <b>Passwords and other secrets are never sent anywhere and never logged.</b></li>
<li>Sent to <b>Bitwarden's own icon service</b> (icons.bitwarden.net): each entry's <b>domain</b>, to check whether it already has a favicon. (Bitwarden already stores your vault.)</li>
<li>Sent to <b>favico.app</b>: brand-name guesses derived from your domains (to find matching icons), anything you type in a <b>search</b> box, any image/page URL you deliberately enter, and any <b>image you choose/upload</b> (to store as an icon).</li>
<li><b>Icons you upload or pick from a web search are saved on the favico.app server</b> (they must be, so Bitwarden can fetch them) and added to the <b>shared, searchable library</b> so others with the same site benefit. They hold only the image and the short name you give it — <b>no vault data</b>.</li>
<li><b>Community hints (opt-in, anonymous):</b> the tool <b>downloads</b> a public list of "old name → new name" and "site → icon" suggestions to improve matching (nothing is sent to fetch it). Only if you turn on the "help improve matching" toggle does it <b>send</b> generic <code>old → new</code> renames, which icon you picked for a site, and icon-usage counts. This is <b>fully anonymised</b> — no account, email, device or user identifier, no URLs and no secrets — so it <b>cannot be linked to you or your Bitwarden account</b>.</li>
<li><b>Duplicate detection</b> runs entirely on this machine and only looks at each login's <b>site and username</b> — never the password. Anything you choose to remove is <b>soft-deleted to Bitwarden's Trash</b> (recoverable), not erased.</li>
<li>Stays local: all <b>edits, renames, deletions, and the encrypted backup</b> go only between this machine and Bitwarden via the CLI — favico.app never sees them.</li>
<li>It's <b>open source</b> — you can read exactly what it does.</li>
</ul></details>
<div id="app">Loading your vault…</div>
<script>
const T='__UI_TOKEN__';
const _fetch=window.fetch.bind(window);
window.fetch=(u,o)=>{ o=o||{}; if(typeof u==='string'&&u[0]==='/'){ o.headers={...(o.headers||{}),'x-favico-token':T}; } return _fetch(u,o); };
const $=(h)=>{const t=document.createElement('template');t.innerHTML=h.trim();return t.content.firstChild};
let data;
let plan={icons:{},renames:{},urls:{},deletes:{},merges:{}}, cur=0, visited={}, committed=false, appMode='start';
let consent={compare:false,report:false}, gone={}, pendingSynonyms=[];
const gkey=(g)=>g.map(e=>e.id).slice().sort().join(',');
const mergedDrop=(id)=>Object.values(plan.merges).some(m=>m.ids.includes(id)&&id!==m.keep);
let iconIndex={}, renameIndex={}, dupIndex={}, editorIndex={};
function indexData(next){
  data=next; iconIndex={}; renameIndex={}; dupIndex={}; editorIndex={};
  ['s1','s2','quality','s3'].forEach(s=>(data[s]||[]).forEach(e=>{e._sec=s;iconIndex[e.id]=e;}));
  (data.renames||[]).forEach(e=>renameIndex[e.id]=e);
  (data.dups||[]).forEach(g=>g.forEach(e=>dupIndex[e.id]=e));
  (data.editor||[]).forEach(e=>editorIndex[e.id]=e);
}
async function load(){ indexData(await (await fetch('/api/data')).json()); mount(); }
function rowBase(e){ const img=e.iconUrl?\`<img src="\${e.iconUrl}" onerror="this.style.visibility='hidden'">\`:'<img>';
  return \`\${img}<div class="grow"><div class="name">\${esc(e.name)}</div><div class="host">\${esc(e.host||'no web URL')}</div></div>\`; }
function esc(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}

// Order: declutter duplicates → apply easy icon matches → identify names → finish icons → review.
// Entries you mark for removal in step 1 are hidden from the later steps.
const FLOW_STEPS=[
  {key:'consent',title:'Options',render:renderConsent},
  {key:'dups',title:'Duplicates',render:renderDups},
  {key:'s1',title:'Matched',render:()=>renderIcons('s1',{pre:true,hint:'A matching icon was found for each entry that has none. Untick any you do not want; fix a wrong match with the search or upload.'})},
  {key:'renames',title:'Rename',render:renderRenames},
  {key:'s2',title:'Pick icons',render:()=>renderIcons('s2',{hint:'No icon and no automatic match. Search the library, search the web, or upload one — picking an icon ticks the row.'})},
  {key:'quality',title:'Improve quality',render:()=>renderIcons('quality',{current:true,showResolution:true,hint:'These existing icons are 47×47 pixels or smaller. Choose a sharper library icon, image, or upload; entries you leave untouched keep their current icon.'})},
  {key:'s3',title:'Replace',render:()=>renderIcons('s3',{current:true,hint:'These already have an icon. Optional: pick a replacement; rows you leave untouched keep their current icon.'})},
  {key:'confirm',title:'Review',render:renderConfirm},
];
const EDITOR_STEPS=[
  {key:'editor',title:'Editor Mode',render:renderEditor},
  {key:'confirm',title:'Review',render:renderConfirm},
];
const currentSteps=()=>appMode==='flow'?FLOW_STEPS:appMode==='editor'?EDITOR_STEPS:[{key:'start',title:'Choose mode',render:renderStart}];

function mount(){
  const steps=currentSteps();
  const app=document.getElementById('app'); app.innerHTML='';
  if(appMode!=='start') app.appendChild(stepper());
  const body=$('<div id="stepbody"></div>');
  body.appendChild(steps[cur].render());
  app.appendChild(body);
  if(appMode!=='start') app.appendChild(navbar());
  refreshNav();
}

function stepper(){
  const steps=currentSteps();
  const s=$('<div class="stepper"></div>');
  steps.forEach((st,i)=>{
    const p=$(\`<button class="stp \${i===cur?'on':''} \${i<cur?'done':''}"><span class="num">\${i<cur?'✓':(i+1)}</span><span class="lbl">\${esc(st.title)}</span></button>\`);
    p.onclick=()=>{ collect(); cur=i; mount(); };
    s.appendChild(p);
  });
  return s;
}

function renderStart(){
  const wrap=$('<div data-step="start"></div>');
  wrap.appendChild($('<p class="hint">Choose how you want to work with your vault. Nothing changes until you review and apply your selections.</p>'));
  const cards=$('<div class="modecards"></div>');
  const flow=$('<section class="modecard recommended"><h2>Go through the flow <span class="done">(recommended)</span></h2><p>The guided experience does the checking and organising for you.</p><ul><li>Finds likely duplicates, states exactly what differs and flags mostly-empty copies</li><li>Suggests confident icon matches and cleaner names</li><li>Finds unresolved entries and icons at 47×47 or lower</li><li>Guides icon search, webpage/image URLs, uploads, cropping and replacement</li><li>Shows a final review and downloads a change record before applying</li></ul><button class="primary chooseflow">Go through the flow</button></section>');
  const editor=$('<section class="modecard"><h2>Editor Mode</h2><p>A simple manual editor. It shows every login with its name, 48×48 logo and web addresses so you can rename it, change its icon or edit its URLs yourself.</p><p>Editor Mode does not include the guided flow’s duplicate analysis, automatic matches, rename suggestions, missing-icon help or quality checks.</p><button class="chooseeditor">Open Editor Mode</button></section>');
  flow.querySelector('.chooseflow').onclick=()=>{ appMode='flow';cur=0;mount(); };
  editor.querySelector('.chooseeditor').onclick=()=>{ appMode='editor';cur=0;mount(); };
  cards.appendChild(flow); cards.appendChild(editor); wrap.appendChild(cards);
  return wrap;
}

function editorUrlRow(value){
  const row=$(\`<div class="editorurl"><input type="text" class="editurl" value="\${esc(value||'')}" placeholder="https://example.com" aria-label="Login web address"><button type="button" class="removeurl" title="Remove this web address">Remove</button></div>\`);
  row.querySelector('.removeurl').onclick=()=>row.remove();
  return row;
}

function renderEditor(){
  const wrap=$('<div data-step="editor"></div>');
  wrap.appendChild($('<p class="hint">Manual editor: every login is shown below. Change any name, icon or web address you want, then continue to review. The recommended guided flow can run after these edits are saved.</p>'));
  const holder=$('<div></div>');
  for(const e of (data.editor||[])){
    const item=$(\`<div class="editoritem" data-id="\${e.id}"><div class="editorhead"><span class="iconcell"></span><div class="editorfields"><input type="text" class="editname" value="\${esc(plan.renames[e.id]||e.name)}" aria-label="Login name"><span class="host">\${esc(e.host||'No web address')}</span></div><button type="button" class="editicon">Change icon…</button>\${bwVaultLink(e.id)}</div><div class="editorurls"></div><button type="button" class="addurl">+ Add web address</button></div>\`);
    const cell=item.querySelector('.iconcell');
    const chosen=plan.icons[e.id];
    cell.innerHTML=chosen?\`<img src="https://\${chosen}.favico.app/favicon.ico" onerror="this.style.visibility='hidden'">\`:(e.iconUrl?\`<img src="\${e.iconUrl}" onerror="this.style.visibility='hidden'">\`:'<span class="noicon">?</span>');
    const values=plan.urls[e.id]||e.uris||[];
    const urls=item.querySelector('.editorurls');
    values.forEach(uri=>urls.appendChild(editorUrlRow(uri)));
    item.querySelector('.addurl').onclick=()=>{ const row=editorUrlRow(''); urls.appendChild(row); row.querySelector('input').focus(); };
    item.querySelector('.editicon').onclick=async()=>{ const cand=await pickIcon(e,cell); if(cand)item.querySelector('.editicon').textContent='Change icon again…'; };
    holder.appendChild(item);
  }
  wrap.appendChild(holder);
  return wrap;
}

function renderIcons(key,opts){
  opts=opts||{};
  const wrap=$(\`<div data-step="\${key}"></div>\`);
  const list=(data[key]||[]).filter(e=>!plan.deletes[e.id]&&!gone[e.id]&&!mergedDrop(e.id)&&!(key==='s3'&&plan.icons[e.id]));
  if(opts.hint) wrap.appendChild($(\`<p class="hint">\${opts.hint}</p>\`));
  if(!list.length){ wrap.appendChild($('<p class="hint">Nothing in this section. 🎉</p>')); return wrap; }
  if(key!=='s3') wrap.appendChild($('<label class="selall"><input type="checkbox" class="allchk"'+(key==='s1'?' checked':'')+'> Select all</label>'));
  const holder=$('<div></div>');
  const seeded=opts.pre&&!visited[key];   // pre-checked default only until the user has touched this step
  for(const e of list){
    const initial=(e.id in plan.icons)?plan.icons[e.id]:(seeded?e.cand:undefined);
    holder.appendChild(iconRow(e,{cand:initial,current:opts.current,showResolution:opts.showResolution}));
  }
  wrap.appendChild(holder);
  const all=wrap.querySelector('.allchk'); if(all) all.onchange=()=>{ holder.querySelectorAll('.cpick').forEach(c=>{c.checked=all.checked;}); refreshNav(); };
  wrap.addEventListener('change',refreshNav); wrap.addEventListener('input',refreshNav);
  return wrap;
}

async function pickIcon(e, cell){
  const known=plan.icons[e.id]||'';
  const picked=await openPicker({ search:known, name:known });
  if(!picked)return null;
  const setC=(cand)=>{ plan.icons[e.id]=cand; cell.innerHTML=\`<img src="https://\${cand}.favico.app/favicon.ico" onerror="this.style.visibility='hidden'">\`; return cand; };
  if(picked.cand){ return setC(picked.cand); }
  if(picked.upload){ const old=cell.innerHTML; cell.innerHTML='<span class="noicon">…</span>';
    try{ const res=await (await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:picked.upload.name,dataUrl:picked.upload.dataUrl})})).json();
      if(res.ok) return setC(res.cand); else { cell.innerHTML=old; return null; }
    }catch{ cell.innerHTML=old; return null; } }
  return null;
}

function renderRenames(){
  const wrap=$('<div data-step="renames"></div>');
  const rn=(data.renames||[]).filter(e=>!plan.deletes[e.id]&&!gone[e.id]&&!mergedDrop(e.id));
  wrap.appendChild($('<p class="hint">Cleaner names for entries that look like URLs or package IDs. Edit a suggestion before applying — only ticked rows are renamed. You can also change an entry\\'s icon here.</p>'));
  if(!rn.length){ wrap.appendChild($('<p class="hint">No rename suggestions.</p>')); return wrap; }
  wrap.appendChild($('<label class="selall"><input type="checkbox" class="allchk"> Select all</label>'));
  const holder=$('<div></div>');
  for(const e of rn){
    const val=(e.id in plan.renames)?plan.renames[e.id]:e.suggested;
    const ck=(e.id in plan.renames)?'checked':'';
    const row=$(\`<div class="row" data-id="\${e.id}"><input type="checkbox" class="cr" \${ck}><span class="iconcell"></span><div class="grow"><div class="host">\${esc(e.current)}</div></div><span class="arrow">→</span><input type="text" class="newname" value="\${esc(val)}" style="flex:1;min-width:0;padding:5px 8px;border:1px solid #8886;border-radius:7px;font:inherit"><button class="change">Change icon</button></div>\`);
    const cell=row.querySelector('.iconcell');
    if(plan.icons[e.id]) cell.innerHTML=\`<img src="https://\${plan.icons[e.id]}.favico.app/favicon.ico" onerror="this.style.visibility='hidden'">\`;
    else if(e.host) cell.innerHTML=\`<img src="https://icons.bitwarden.net/\${e.host}/icon.png" onerror="this.style.visibility='hidden'">\`;
    else cell.innerHTML='<span class="noicon">?</span>';
    const okmsg=$('<div class="iconok" hidden></div>');
    row.querySelector('.change').onclick=async()=>{ const cand=await pickIcon(e, cell); if(cand){ okmsg.hidden=false; okmsg.innerHTML='Icon will be updated to <b>'+esc(cand)+'.favico.app</b> — this applies on its own. Tick the box if you also want to rename this entry.'; } };
    const item=$('<div class="rnitem"></div>'); item.appendChild(row); item.appendChild(okmsg); holder.appendChild(item);
  }
  wrap.appendChild(holder);
  wrap.querySelector('.allchk').onchange=(ev)=>{ holder.querySelectorAll('.cr').forEach(c=>c.checked=ev.target.checked); refreshNav(); };
  wrap.addEventListener('change',refreshNav);
  return wrap;
}

function renderConsent(){
  const wrap=$('<div data-step="consent"></div>');
  wrap.appendChild($('<p class="hint">A few optional choices before you start — all off by default. Flip on only what you want.</p>'));
  const opts=[
    ['compare','Compare passwords to help with duplicates','Lets the tool check, <b>on this machine only</b>, whether two duplicates share a password — so it can offer a safe Merge. The value is <b style="color:#dc2626">never shown, stored, or sent</b>. If off, duplicates match on site + username only and stay hidden.'],
    ['report','Anonymously help improve matching for everyone','Sends generic, anonymous hints — renames (<code>old → new</code>), which icon you pick for a site, your library-search picks, and which icons you use — so future users get smarter matching, search, and suggestions. No identifiers, no URLs, no passwords, no full entries.'],
  ];
  for(const [k,title,desc] of opts){
    const row=$(\`<div class="optrow"><label class="switch"><input type="checkbox" class="opt" data-k="\${k}"\${consent[k]?' checked':''}><span class="track"></span></label><div class="grow"><div class="name">\${title}</div><div class="optdesc">\${desc}</div></div></div>\`);
    row.querySelector('.opt').onchange=(ev)=>{ consent[k]=ev.target.checked; };
    wrap.appendChild(row);
  }
  return wrap;
}

// Deep link to one entry in the Bitwarden web vault (same server as the CLI),
// so the copies can be compared side by side. Desktop app has no item links.
function bwVaultLink(id){
  const base=(data.vault||'https://vault.bitwarden.com');
  return '<a class="openbw" href="'+base+'/#/vault?itemId='+encodeURIComponent(id)+'&action=view" target="_blank" rel="noopener" title="Open this entry in the Bitwarden web vault to compare">Open in Bitwarden ↗</a>';
}

function dupEntryRow(en, detail, index, onKeep, selected){
  const ic=en.host?\`<img src="https://icons.bitwarden.net/\${en.host}/icon.png" onerror="this.style.visibility='hidden'">\`:'<span class="noicon">?</span>';
  const row=$(\`<div class="dup"><span class="dupnum">Entry \${index+1}</span><span class="iconcell">\${ic}</span><span class="grow"><span class="name">\${esc(en.name)}</span><span class="host">\${esc(en.username||'no username')}\${en.host?(' · '+esc(en.host)):''}</span>\${detail&&detail.mostlyEmpty?'<span class="emptybadge">Mostly empty — no password or other saved details</span>':''}</span>\${bwVaultLink(en.id)}<button class="keepbtn\${selected?' primary':''}">\${selected?'Keeping this one':'Keep this one'}</button></div>\`);
  row.querySelector('.keepbtn').onclick=onKeep;
  return row;
}

// Bottom-of-page refresh: re-sync the vault and rebuild just the duplicate
// groups (fast), so fixes made directly in Bitwarden disappear from the list.
function dupRefreshRow(){
  const w=$('<div class="duprefresh"><button class="primary">Have you fixed these? Then refresh by clicking this button</button><span class="state"></span></div>');
  const b=w.querySelector('button'), st=w.querySelector('.state');
  b.onclick=async()=>{
    b.disabled=true; st.textContent=' syncing with Bitwarden…';
    try{
      const r=await (await fetch('/api/rescan-dups',{method:'POST'})).json();
      data.dups=r.dups||[];
      dupIndex={}; data.dups.forEach(g=>g.forEach(e=>dupIndex[e.id]=e));
      // Drop picks that no longer point at a listed duplicate.
      const ids=new Set(Object.keys(dupIndex));
      Object.keys(plan.deletes).forEach(id=>{ if(!ids.has(id)) delete plan.deletes[id]; });
      const keys=new Set((data.dups||[]).map(gkey));
      Object.keys(plan.merges).forEach(k=>{ if(!keys.has(k)) delete plan.merges[k]; });
      mount();
    }catch{ b.disabled=false; st.innerHTML=' <span class="err">refresh failed — try again</span>'; }
  };
  return w;
}

function selectedKeeper(g){
  return g.find(en=>!plan.deletes[en.id]&&g.every(other=>other.id===en.id||plan.deletes[other.id]));
}

function renderDifferenceTable(comparison){
  if(!comparison||!comparison.differences||!comparison.differences.length) return $('<div class="nodiff">No differences found in the compared fields.</div>');
  const cols=(comparison.entries||[]).map((_,i)=>\`<th>Entry \${i+1}</th>\`).join('');
  const rows=comparison.differences.map(d=>\`<tr><th>\${esc(d.label)}</th>\${d.values.map(v=>\`<td>\${esc(String(v))}</td>\`).join('')}</tr>\`).join('');
  return $(\`<table class="diffs"><caption>Exactly what is different</caption><thead><tr><th>Detail</th>\${cols}</tr></thead><tbody>\${rows}</tbody></table>\`);
}

async function renderDupGroups(holder, comparePasswords){
  let status; try{ status=(await (await fetch('/api/dup-status?passwords='+(comparePasswords?'1':'0'))).json()).groups||[]; }catch{ status=[]; }
  holder.className=''; holder.innerHTML='';
  (data.dups||[]).forEach((g,i)=>{
    if(g.every(en=>gone[en.id])) return;
    const comparison=status[i]||{entries:[],differences:[]};
    const keeper=selectedKeeper(g);
    const box=$(keeper?'<div class="dupgroup willkeep"></div>':'<div class="dupgroup"></div>');
    box.appendChild($(\`<div class="duphdr">\${esc(g[0].host||g[0].name)} · \${g.length} entries</div>\`));
    g.forEach((en,j)=>{
      const choose=()=>{
        delete plan.merges[gkey(g)];
        g.forEach(other=>{
          if(other.id===en.id) delete plan.deletes[other.id];
          else { plan.deletes[other.id]=true; delete plan.icons[other.id]; delete plan.renames[other.id]; }
        });
        mount();
      };
      box.appendChild(dupEntryRow(en,comparison.entries[j],j,choose,keeper&&keeper.id===en.id));
    });
    box.appendChild(renderDifferenceTable(comparison));
    if(!comparePasswords) box.appendChild($('<div class="warnrow">Password differences were not checked because password comparison is off.</div>'));
    if(keeper){
      const count=g.length-1;
      const note=$(\`<div class="keepnote">Keeping Entry \${g.indexOf(keeper)+1}. \${count===1?'The other entry':\`The other \${count} entries\`} will go to Bitwarden’s Trash only when you click Apply. \${count===1?'It is':'They are'} never permanently deleted. <button class="undo">Undo</button></div>\`);
      note.querySelector('.undo').onclick=()=>{ g.forEach(en=>delete plan.deletes[en.id]); mount(); };
      box.appendChild(note);
    }
    holder.appendChild(box);
  });
  if(!holder.children.length) holder.appendChild($('<p class="hint">All duplicate groups handled. 🎉</p>'));
  refreshNav();
}

function renderDups(){
  const wrap=$('<div data-step="dups"></div>');
  const remaining=(data.dups||[]).filter(g=>!g.every(en=>gone[en.id]));
  if(!remaining.length){ wrap.appendChild($('<p class="hint">No duplicate logins\\u00a0— or all handled. 🎉</p>')); return wrap; }

  if(!consent.compare){
    wrap.appendChild($('<p class="hint">You chose not to let the tool compare passwords, so these are matched on <b>site + username only</b>. Favico can still show every other difference, but the entries may be different logins. <b style="color:#dc2626">Passwords are never read or compared.</b></p>'));
    const holder=$('<div></div>');
    const btn=$('<button class="primary">Show duplicates anyway</button>');
    btn.onclick=()=>{ btn.remove(); holder.className='hint'; holder.textContent='Comparing entry details…'; renderDupGroups(holder,false); };
    wrap.appendChild(btn); wrap.appendChild(holder);
    wrap.appendChild(dupRefreshRow());
    return wrap;
  }

  wrap.appendChild($('<p class="hint">Favico shows exactly which saved details differ. Choose <b>Keep this one</b> on the entry you want; the other copy goes to Bitwarden’s Trash when you click Apply and is <b>never permanently deleted</b>. Passwords are compared on this machine only — never shown or sent.</p>'));
  const holder=$('<div class="hint">Comparing entry details…</div>');
  wrap.appendChild(holder);
  wrap.appendChild(dupRefreshRow());
  renderDupGroups(holder,true);
  return wrap;
}

function renderConfirm(){
  const wrap=$('<div data-step="confirm"></div>');
  const icons=Object.entries(plan.icons), renames=Object.entries(plan.renames), urls=Object.entries(plan.urls), deletes=Object.keys(plan.deletes), merges=Object.values(plan.merges);
  wrap.appendChild($('<p class="hint">Review everything below. <b>Nothing has changed in your vault yet</b> — changes apply only when you click Apply.</p>'));
  wrap.appendChild($(\`<div class="summary"><span><b>\${icons.length}</b> icon\${icons.length===1?'':'s'}</span><span><b>\${renames.length}</b> rename\${renames.length===1?'':'s'}</span><span><b>\${urls.length}</b> URL update\${urls.length===1?'':'s'}</span><span><b>\${merges.length}</b> merge\${merges.length===1?'':'s'}</span><span><b>\${deletes.length}</b> to Trash</span></div>\`));
  if(icons.length){ const sec=$('<div class="csec"><h3>Icons</h3></div>'); icons.forEach(([id,cand])=>{ const r=renameIndex[id]; const e=iconIndex[id]||dupIndex[id]||(r?{name:r.current,host:r.host}:null)||{}; const rep=e._sec==='s3'; sec.appendChild($(\`<div class="crow"><img class="ci" src="https://\${cand}.favico.app/favicon.ico" onerror="this.style.visibility='hidden'"><span class="grow"><span class="name">\${esc(e.name||id)}</span><span class="host">\${rep?'replace':'add'} → \${esc(cand)}.favico.app\${e.host?(' · '+esc(e.host)):''}</span></span></div>\`)); }); wrap.appendChild(sec); }
  if(renames.length){ const sec=$('<div class="csec"><h3>Renames</h3></div>'); renames.forEach(([id,name])=>{ const e=renameIndex[id]||editorIndex[id]||{}; const cand=plan.icons[id]; const ic=cand?\`<img class="ci" src="https://\${cand}.favico.app/favicon.ico" onerror="this.style.visibility='hidden'">\`:(e.host?\`<img class="ci" src="https://icons.bitwarden.net/\${e.host}/icon.png" onerror="this.style.visibility='hidden'">\`:''); sec.appendChild($(\`<div class="crow">\${ic}<span class="grow"><span class="name">\${esc(name)}</span><span class="host">was: \${esc(e.current||e.name||'')}</span></span></div>\`)); }); wrap.appendChild(sec); }
  if(urls.length){ const sec=$('<div class="csec"><h3>Web addresses</h3></div>'); urls.forEach(([id,next])=>{ const e=editorIndex[id]||{}; sec.appendChild($(\`<div class="crow"><span class="grow"><span class="name">\${esc(plan.renames[id]||e.name||id)}</span><span class="host">was: \${esc((e.uris||[]).join(' · ')||'none')}</span><span class="host">will be: \${esc((next||[]).join(' · ')||'none')}</span></span></div>\`)); }); wrap.appendChild(sec); }
  if(deletes.length){ const sec=$('<div class="csec"><h3>Move to Trash</h3></div>'); sec.appendChild($('<p class="hint">Recoverable from Bitwarden Trash, <code>bw restore item &lt;id&gt;</code>, or your encrypted backup.</p>')); deletes.forEach(id=>{ const e=dupIndex[id]||{}; sec.appendChild($(\`<div class="crow"><span class="grow"><span class="name">\${esc(e.name||id)}</span><span class="host">\${esc(e.username||'no username')}\${e.host?(' · '+esc(e.host)):''}</span></span></div>\`)); }); wrap.appendChild(sec); }
  if(merges.length){ const sec=$('<div class="csec"><h3>Merges</h3></div>'); sec.appendChild($('<p class="hint">Each group becomes one entry (web addresses combined); the extra copies move to Trash (recoverable).</p>')); merges.forEach(m=>{ const e=dupIndex[m.keep]||{}; const drop=m.ids.length-1; const ic=e.host?\`<img class="ci" src="https://icons.bitwarden.net/\${e.host}/icon.png" onerror="this.style.visibility='hidden'">\`:''; sec.appendChild($(\`<div class="crow">\${ic}<span class="grow"><span class="name">\${esc(e.name||m.keep)}</span><span class="host">merge \${m.ids.length} → 1 · \${drop} to Trash\${e.host?(' · '+esc(e.host)):''}</span></span></div>\`)); }); wrap.appendChild(sec); }
  if(!icons.length&&!renames.length&&!urls.length&&!deletes.length&&!merges.length) wrap.appendChild($('<p class="hint">No changes selected. Go back to pick some — or just close the tool, nothing will happen.</p>'));
  const actions=$('<div class="confirm-actions"></div>');
  const dl=$('<button class="dl">⬇ Download change record</button>'); dl.onclick=downloadRecord; actions.appendChild(dl);
  const apply=$('<button class="primary apply">Apply changes</button>'); if(committed||(!icons.length&&!renames.length&&!urls.length&&!deletes.length&&!merges.length)) apply.disabled=true; apply.onclick=()=>commit(apply,dl); actions.appendChild(apply);
  wrap.appendChild(actions);
  if(committed) wrap.appendChild($('<p class="hint">These changes were already applied in this session. Reload the page to start a fresh pass.</p>'));
  wrap.appendChild($('<div class="result" id="commitresult"></div>'));
  wrap.appendChild(revertLink());
  return wrap;
}

function revertLink(){
  const w=$('<div style="margin-top:20px;border-top:1px solid #8884;padding-top:12px"><small>Safety net: </small><button class="rev">Revert all favico URIs</button> <small>removes every *.favico.app URI this tool added</small> <span class="revst"></span></div>');
  w.querySelector('.rev').onclick=async()=>{ if(!confirm('Remove ALL favico.app URIs from your vault logins? Your original URLs are kept.'))return; const st=w.querySelector('.revst'); st.textContent=' working…'; try{ const r=await (await fetch('/api/revert',{method:'POST'})).json(); st.textContent=' reverted '+r.reverted+' — reloading…'; setTimeout(()=>location.reload(),900);}catch{ st.innerHTML=' <span class="err">failed</span>'; } };
  return w;
}

function collect(){
  const body=document.getElementById('stepbody'); if(!body)return;
  const step=body.querySelector('[data-step]'); if(!step)return;
  const key=step.dataset.step; visited[key]=true;
  if(key==='s1'||key==='s2'||key==='quality'||key==='s3'){ step.querySelectorAll('.row[data-id]').forEach(r=>{ const id=r.dataset.id, cb=r.querySelector('.cpick'); if(cb&&cb.checked&&r.dataset.cand) plan.icons[id]=r.dataset.cand; else delete plan.icons[id]; }); }
  else if(key==='renames'){ step.querySelectorAll('.row[data-id]').forEach(r=>{ const id=r.dataset.id, cb=r.querySelector('.cr'), nm=r.querySelector('.newname').value.trim(); if(cb.checked&&nm) plan.renames[id]=nm; else delete plan.renames[id]; }); }
  else if(key==='dups'){ /* Keep-this-one buttons update the deferred plan immediately. */ }
  else if(key==='editor'){ step.querySelectorAll('.editoritem[data-id]').forEach(item=>{ const id=item.dataset.id,e=editorIndex[id]; if(!e)return; const name=item.querySelector('.editname').value.trim(); if(name&&name!==e.name)plan.renames[id]=name; else delete plan.renames[id]; const uris=[...item.querySelectorAll('.editurl')].map(input=>input.value.trim()).filter(Boolean); if(JSON.stringify(uris)!==JSON.stringify(e.uris||[]))plan.urls[id]=uris; else delete plan.urls[id]; }); }
}

function countTicks(){
  const body=document.getElementById('stepbody'); if(!body)return 0;
  const step=body.querySelector('[data-step]'); if(!step)return 0;
  const key=step.dataset.step;
  if(key==='s1'||key==='s2'||key==='quality'||key==='s3') return [...step.querySelectorAll('.cpick:checked')].filter(c=>c.closest('.row').dataset.cand).length;
  if(key==='renames') return step.querySelectorAll('.cr:checked').length;
  if(key==='dups') return Object.keys(plan.deletes).length;
  if(key==='editor') return Object.keys(plan.icons).length+Object.keys(plan.renames).length+Object.keys(plan.urls).length;
  return 0;
}

function navbar(){
  const steps=currentSteps();
  const n=$('<div class="navbar"></div>');
  const back=$('<button class="back">← Back</button>'); back.onclick=()=>{ collect(); if(cur>0){cur--;mount();} };
  const next=$('<button class="primary next"></button>'); next.onclick=()=>{ collect(); if(cur<steps.length-1){cur++;mount();} };
  n.appendChild(back); n.appendChild($('<div style="flex:1"></div>')); n.appendChild(next);
  return n;
}

function refreshNav(){
  const back=document.querySelector('.navbar .back'), next=document.querySelector('.navbar .next');
  if(!next)return;
  back.style.visibility=cur===0?'hidden':'visible';
  const key=currentSteps()[cur].key;
  if(key==='confirm'){ next.style.display='none'; return; }
  next.style.display='';
  if(key==='consent'||key==='editor'||(key==='dups'&&consent.compare)){ next.textContent=key==='editor'?'Review changes →':'Continue →'; return; }
  next.textContent=countTicks()>0?'Confirm selections →':'Skip this section →';
}

function buildRecord(){
  const icons=Object.entries(plan.icons).map(([id,cand])=>{ const e=iconIndex[id]||editorIndex[id]||{}; return {id,name:e.name||null,host:e.host||null,oldIconUrl:e.iconUrl||null,newIconUri:'https://'+cand+'.favico.app',replacesExisting:Boolean(e.iconUrl)}; });
  const renames=Object.entries(plan.renames).map(([id,name])=>{ const e=renameIndex[id]||editorIndex[id]||{}; return {id,oldName:e.current||e.name||null,newName:name}; });
  const urls=Object.entries(plan.urls).map(([id,uris])=>{ const e=editorIndex[id]||{}; return {id,name:plan.renames[id]||e.name||null,oldUris:e.uris||[],newUris:uris}; });
  const deletes=Object.keys(plan.deletes).map(id=>{ const e=dupIndex[id]||{}; return {id,name:e.name||null,host:e.host||null,username:e.username||null}; });
  const merges=Object.values(plan.merges).map(m=>({keep:m.keep,ids:m.ids,toTrash:m.ids.filter(id=>id!==m.keep)}));
  return {tool:'favico × Bitwarden',generatedAt:new Date().toISOString(),note:'For your records — passwords are NOT included.',summary:{icons:icons.length,renames:renames.length,urls:urls.length,merges:merges.length,deletes:deletes.length},icons,renames,urls,merges,deletes,howToRevert:{icons:'Remove the *.favico.app URI from the entry, or use the Revert button in this tool.',renames:'Set the entry name back to oldName.',urls:'Restore oldUris from this record.',merges:'Merged-away copies are in Bitwarden Trash — restore them to undo a merge.',deletes:'Restore from Bitwarden Trash, run "bw restore item <id>", or re-import the encrypted backup.'}};
}

function downloadRecord(){
  const txt=JSON.stringify(buildRecord(),null,2);
  const b=new Blob([txt],{type:'application/json'}), u=URL.createObjectURL(b), a=document.createElement('a');
  a.href=u; a.download='favico-changes-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),1000);
}

async function commit(apply,dl){
  const icons=Object.entries(plan.icons).map(([id,cand])=>({id,cand}));
  const renames=Object.entries(plan.renames).map(([id,name])=>({id,name}));
  const urls=Object.entries(plan.urls).map(([id,uris])=>({id,uris}));
  const deletes=Object.keys(plan.deletes);
  const merges=Object.values(plan.merges);
  const total=icons.length+renames.length+urls.length+deletes.length+merges.length; if(!total)return;
  downloadRecord();
  apply.disabled=true; dl.disabled=true;
  const bg=$('<div class="modal-bg"></div>');
  bg.innerHTML='<div class="modal" style="width:520px"><h3 class="ptitle">Applying your changes…</h3><div class="pbar"><div class="pfill"></div></div><div class="pmeta"><span class="ppct">0%</span><span class="pcur">Starting…</span><button class="pdet">Show details</button></div><ul class="plog" hidden></ul><div class="psummary"></div><div class="phint">Working… please don’t close this window.</div><div class="pactions"></div></div>';
  document.body.appendChild(bg);
  const q=(s)=>bg.querySelector(s);
  const fill=q('.pfill'),pct=q('.ppct'),cur=q('.pcur'),log=q('.plog'),det=q('.pdet'),ptitle=q('.ptitle'),psum=q('.psummary'),phint=q('.phint'),pact=q('.pactions');
  det.onclick=()=>{ log.hidden=!log.hidden; det.textContent=log.hidden?'Show details':'Hide details'; };
  let results=null, finished=false;
  function onEvent(e){
    if(e.type==='doing'){ cur.textContent=e.label; }
    else if(e.type==='done_item'){ const p=e.total?Math.round(e.done/e.total*100):100; fill.style.width=p+'%'; pct.textContent=p+'%';
      const li=document.createElement('li'); li.className=e.ok?'ok':'bad'; li.textContent=(e.ok?'✓ ':'✗ ')+e.label+(e.ok?'':' — '+(e.error||'failed')); log.appendChild(li); log.scrollTop=log.scrollHeight; }
    else if(e.type==='done'){ results=e.results; fill.style.width='100%'; pct.textContent='100%'; cur.textContent='Done'; finishUp(); }
    else if(e.type==='error'){ results=e.results||results; cur.innerHTML='<span class="err">'+esc(e.error||'failed')+'</span>'; finishUp(); }
  }
  function finishUp(){
    if(finished) return; finished=true; committed=true;
    const r=results||{icons:[],renames:[],urls:[],deletes:[],merges:[]};
    const sum=a=>({ok:(a||[]).filter(x=>x.ok).length,n:(a||[]).length});
    const si=sum(r.icons),sr=sum(r.renames),su=sum(r.urls),sd=sum(r.deletes),sm=sum(r.merges);
    const nf=(si.n-si.ok)+(sr.n-sr.ok)+(su.n-su.ok)+(sd.n-sd.ok)+(sm.n-sm.ok);
    ptitle.textContent=nf?'Done — with some errors':'All done ✓';
    psum.innerHTML='<div class="tally"><span>Icons '+si.ok+'/'+si.n+'</span><span>Renames '+sr.ok+'/'+sr.n+'</span><span>URLs '+su.ok+'/'+su.n+'</span><span>Merges '+sm.ok+'/'+sm.n+'</span><span>Trash '+sd.ok+'/'+sd.n+'</span></div>'+(nf?'<p class="err">'+nf+' failed — open “Show details”.</p>':'')+'<p class="hint">Open Bitwarden and <b>Sync</b> to see the changes. Your change record was downloaded.</p><p class="hint">Let us know how it went — <a href="https://github.com/zacaracaz/favico-bitwarden/discussions" target="_blank" rel="noopener">share feedback on GitHub</a> or email <a href="mailto:support@favico.app">support@favico.app</a>.</p>';
    phint.remove();
    if(appMode==='editor'&&!nf){
      psum.insertAdjacentHTML('beforeend','<h3>Would you like to go through the flow now? <span class="done">(recommended)</span></h3><ul class="flowextras"><li>Detailed duplicate comparison and mostly-empty warnings</li><li>Automatic icon matches and rename suggestions</li><li>Missing-icon guidance and low-resolution quality checks</li><li>A guided final review and change record</li></ul>');
      const go=$('<button class="primary pclose">Go through the flow now (recommended)</button>');
      go.onclick=async()=>{ go.disabled=true; close.disabled=true; cur.textContent='Syncing and rescanning your vault…'; try{ const next=await (await fetch('/api/reclassify',{method:'POST'})).json(); indexData(next); plan={icons:{},renames:{},urls:{},deletes:{},merges:{}}; visited={};committed=false;appMode='flow';cur=0;bg.remove();mount(); }catch{ go.disabled=false;close.disabled=false;cur.innerHTML='<span class="err">Rescan failed — you can close and run Favico again.</span>'; } };
      pact.appendChild(go);
    }
    const close=$('<button class="pclose">'+(appMode==='editor'&&!nf?'No thanks — close Favico':'All done — close this window')+'</button>');
    close.onclick=()=>{ fetch('/api/quit',{method:'POST'}).catch(()=>{}); window.close(); setTimeout(()=>{ pact.innerHTML='<p class="hint">The tool has stopped — you can safely close this tab.</p>'; },350); };
    pact.appendChild(close);
  }
  try{
    const resp=await fetch('/api/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({icons,renames,urls,deletes,merges,report:consent.report,synonyms:pendingSynonyms})});
    if(!resp.body){ const r=await resp.json(); results=r.results; finishUp(); return; }
    const reader=resp.body.getReader(),dec=new TextDecoder(); let buf='';
    for(;;){ const {value,done}=await reader.read(); if(done) break; buf+=dec.decode(value,{stream:true});
      let nl; while((nl=buf.indexOf('\\n'))>=0){ const line=buf.slice(0,nl).trim(); buf=buf.slice(nl+1); if(line) onEvent(JSON.parse(line)); } }
    const tail=buf.trim(); if(tail) onEvent(JSON.parse(tail));
    if(!finished) finishUp();
  }catch(e){ cur.innerHTML='<span class="err">Apply failed: '+esc(e.message||'error')+'</span>'; phint.textContent='Check Bitwarden to see what applied.'; const c=$('<button class="pclose">Close</button>'); c.onclick=()=>bg.remove(); pact.appendChild(c); apply.disabled=false; dl.disabled=false; }
}
// Unified icon picker: three clearly-separated ways to choose an icon.
// Resolves { cand } for a library pick (already exists), or { upload:{name,dataUrl} }
// for a web/upload pick that needs storing, or null if cancelled.
function openPicker(opts){
  opts=opts||{};
  return new Promise((resolve)=>{
    const V=256,OUT=256,SIZES=[16,32,48,64],FAVICO='https://www.favico.app';
    const bg=$('<div class="modal-bg"></div>');
    bg.innerHTML=\`<div class="modal picker"><h3>Select an icon</h3>
      <div class="tabs"><button class="tab on" data-m="library">Search library</button><button class="tab" data-m="web">Search web</button><button class="tab" data-m="upload">Upload</button></div>

      <div class="pane" data-pane="library">
        <label class="fld">Search the favico icon library<input type="search" class="lib-q" placeholder="Type a brand name — at least 3 letters"></label>
        <p class="phint">👉 Click an icon below to select it (it highlights), then “Use this icon”.</p>
        <div class="grid lib-results"></div>
      </div>

      <div class="pane" data-pane="web" hidden>
        <label class="fld">Step 1 — Search, paste an image URL, or paste a webpage URL<span class="row-in"><input type="search" class="web-q" placeholder="Brand name, image URL, or website URL"><button class="web-go">Find images</button></span></label>
        <p class="phint">For a webpage URL, Favico shows the images found on that page. Then click one to load it below and crop.</p>
        <div class="grid web-results"></div>
      </div>

      <div class="pane" data-pane="upload" hidden>
        <button class="up-file">Choose an image file…</button>
        <p class="phint">A square-ish image works best. Tip: press <b>Ctrl+V</b> (<b>⌘V</b> on Mac) to paste an image straight from your clipboard.</p>
      </div>

      <div class="crop-wrap" hidden>
        <div class="cropbox"><img></div>
        <div class="zoomrow"><small>Zoom</small><input type="range" class="zoom" min="0.2" max="10" step="0.01" value="1"><button type="button" class="zreset">Reset</button></div>
        <div class="bgrow"><span>Background:</span><div class="seg"><button type="button" class="bgopt on" data-bg="transparent">Transparent</button><button type="button" class="bgopt" data-bg="solid">Solid colour</button></div><input type="color" class="bgcolor" value="#ffffff" title="Background colour" hidden><input type="text" class="hexcolor" value="#FFFFFF" maxlength="7" aria-label="Background hex colour" spellcheck="false" hidden></div>
        <div class="previews">\${SIZES.map(s=>\`<div style="text-align:center"><div class="p" style="width:\${s}px;height:\${s}px"><img></div><div style="font-size:10px;opacity:.6">\${s}px</div></div>\`).join('')}</div>
        <label class="fld">Save as <small>(library name — how it’s stored &amp; searchable by others)</small><input type="text" class="cname" placeholder="e.g. bunnings"></label>
      </div>

      <div class="cerr err"></div>
      <div class="row2"><button class="cgo primary" style="flex:1">Use this icon</button><button class="ccancel">Cancel</button></div></div>\`;
    document.body.appendChild(bg);
    const q1=(s)=>bg.querySelector(s);
    const cropWrap=q1('.crop-wrap'),box=q1('.cropbox'),img=q1('.cropbox img'),zoom=q1('.zoom'),nameI=q1('.cname'),err=q1('.cerr'),pimgs=[...bg.querySelectorAll('.previews .p img')];
    const bgOpts=[...bg.querySelectorAll('.bgopt')],bgColor=q1('.bgcolor'),hexColor=q1('.hexcolor'),pPanels=[...bg.querySelectorAll('.previews .p')];
    let bgMode='transparent';
    const libQ=q1('.lib-q'),libRes=q1('.lib-results'),webQ=q1('.web-q'),webGo=q1('.web-go'),webRes=q1('.web-results'),upFile=q1('.up-file');
    let mode='library', libPick=null, iw=0,ih=0,z=1,ox=0,oy=0,drag=null,objUrl=null;
    webQ.value=opts.search||''; let nameTouched=false; nameI.oninput=()=>{nameTouched=true;};

    // crop engine (shared by web + upload)
    const base=()=>Math.min(V/iw,V/ih);
    const dims=()=>{const ds=base()*z;return {dw:iw*ds,dh:ih*ds};};
    // Allow dragging past the edges (logos often need centring/padding); just keep
    // ~20% of the image on-canvas so it can't be lost. Gaps fill with the background.
    const clampOff=(o,d)=>{ const keep=Math.min(d,V)*0.2; return Math.min(V-keep, Math.max(keep-d, o)); };
    function draw(){ let {dw,dh}=dims(); ox=clampOff(ox,dw); oy=clampOff(oy,dh);
      img.style.left=ox+'px';img.style.top=oy+'px';img.style.width=dw+'px';img.style.height=dh+'px';
      pimgs.forEach((pi,i)=>{const k=SIZES[i]/V;pi.style.left=(ox*k)+'px';pi.style.top=(oy*k)+'px';pi.style.width=(dw*k)+'px';pi.style.height=(dh*k)+'px';}); }
    img.onload=()=>{ iw=img.naturalWidth;ih=img.naturalHeight; z=1; zoom.value=1; const {dw,dh}=dims(); ox=(V-dw)/2;oy=(V-dh)/2; pimgs.forEach(pi=>pi.src=img.src); cropWrap.hidden=false; draw(); };
    function loadFile(f){ if(objUrl)URL.revokeObjectURL(objUrl); objUrl=URL.createObjectURL(f); img.crossOrigin=null; img.src=objUrl; }
    function loadUrl(u){ const tryL=(src,viaProxy)=>{ img.crossOrigin='anonymous'; img.onerror=()=>{ if(viaProxy){ err.textContent="Couldn't load that image — try another"; } else tryL(FAVICO+'/api/imageproxy?url='+encodeURIComponent(u), true); }; img.src=src; }; tryL(u,false); }
    zoom.oninput=()=>{ if(!iw)return; const nz=+zoom.value, oldS=base()*z, cx=(V/2-ox)/oldS, cy=(V/2-oy)/oldS; z=nz; const ns=base()*z; ox=V/2-cx*ns; oy=V/2-cy*ns; draw(); };
    function resetView(){ if(!iw)return; z=1; zoom.value=1; const {dw,dh}=dims(); ox=(V-dw)/2; oy=(V-dh)/2; draw(); }
    bg.querySelector('.zreset').onclick=resetView;
    box.onpointerdown=(ev)=>{ if(!iw)return; drag={x:ev.clientX,y:ev.clientY,ox,oy};box.setPointerCapture(ev.pointerId);};
    box.onpointermove=(ev)=>{ if(!drag)return; ox=drag.ox+(ev.clientX-drag.x); oy=drag.oy+(ev.clientY-drag.y); draw(); };
    box.onpointerup=()=>{drag=null;};
    function applyBg(el){ if(bgMode==='transparent'){ el.classList.add('checker'); el.style.backgroundColor=''; } else { el.classList.remove('checker'); el.style.backgroundColor=bgColor.value; } }
    function updateBg(){ applyBg(box); pPanels.forEach(applyBg); }
    function selectBg(m){ bgMode=m; bgOpts.forEach(b=>b.classList.toggle('on',b.dataset.bg===m)); bgColor.hidden=(m!=='solid'); hexColor.hidden=(m!=='solid'); updateBg(); }
    bgOpts.forEach(b=>b.onclick=()=>selectBg(b.dataset.bg));
    bgColor.oninput=()=>{ hexColor.value=bgColor.value.toUpperCase(); selectBg('solid'); };
    function applyHex(){ let value=hexColor.value.trim(); if(/^[0-9a-f]{3}$/i.test(value))value='#'+value; if(/^#[0-9a-f]{3}$/i.test(value))value='#'+value.slice(1).split('').map(c=>c+c).join(''); if(!/^#[0-9a-f]{6}$/i.test(value)){ hexColor.setCustomValidity('Enter #RGB or #RRGGBB'); return; } hexColor.setCustomValidity(''); value=value.toUpperCase(); hexColor.value=value; bgColor.value=value; selectBg('solid'); }
    hexColor.oninput=()=>{ hexColor.setCustomValidity(''); if(/^#?[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(hexColor.value.trim()))applyHex(); };
    hexColor.onchange=applyHex;
    selectBg('transparent');

    // tabs
    function setMode(m){
      // carry the typed query across the two search tabs so it isn't lost on switch
      if(m==='web' && mode==='library' && libQ.value) webQ.value=libQ.value;
      else if(m==='library' && mode==='web' && webQ.value) libQ.value=webQ.value;
      mode=m; err.textContent='';
      bg.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.m===m));
      bg.querySelectorAll('.pane').forEach(p=>p.hidden=p.dataset.pane!==m);
      cropWrap.hidden=(m==='library')||!iw;
      if(m==='library') libSearch();
      else if(m==='web' && webQ.value.trim()) webSearch();
    }
    bg.querySelectorAll('.tab').forEach(t=>t.onclick=()=>setMode(t.dataset.m));

    // library search
    let lt; function libSearch(){ clearTimeout(lt); const q=libQ.value.trim(); if(q.length<3){libRes.innerHTML='';return;} lt=setTimeout(async()=>{
      libRes.innerHTML='<small>searching…</small>';
      try{ const d=await (await fetch('/api/search?q='+encodeURIComponent(q))).json();
        libRes.innerHTML=(d.results||[]).map(r=>\`<button class="ic" data-cand="\${r.name}" title="\${esc(r.name)}"><img src="\${r.iconUrl}" onerror="this.parentNode.remove()"><span>\${esc(r.name)}</span></button>\`).join('')||'<small>no matches</small>';
        libRes.querySelectorAll('.ic').forEach(b=>b.onclick=()=>{ libPick=b.dataset.cand; libRes.querySelectorAll('.ic').forEach(x=>x.classList.remove('sel')); b.classList.add('sel'); });
      }catch{ libRes.innerHTML='<small class="err">search failed</small>'; } },300); }
    libQ.oninput=libSearch;

    // web search, direct image URL, or webpage image discovery
    async function webSearch(){ const q=webQ.value.trim(); if(q.length<2){err.textContent='Enter a search term, image URL, or webpage URL first.';return;} err.textContent=''; webRes.innerHTML='<small>finding images…</small>';
      const isUrl=/^(?:https:\\/\\/|www\\.)/i.test(q);
      const endpoint=isUrl?FAVICO+'/api/pageimages?url='+encodeURIComponent(q):FAVICO+'/api/imagesearch?q='+encodeURIComponent(q);
      try{ const response=await fetch(endpoint); const d=await response.json(); webRes.innerHTML='';
        if(!response.ok){ webRes.innerHTML='<small class="err">'+esc(d.error||'could not read that URL')+'</small>'; return; }
        let suggested=q;
        if(isUrl){ try{ suggested=new URL(/^https:\\/\\//i.test(q)?q:'https://'+q).hostname.replace(/^www\\./,'').split('.')[0]; }catch{} }
        (d.results||[]).forEach(r=>{ const b=$('<button class="ic" title="'+esc(r.title||r.source||'')+'"><img></button>'); const im=b.querySelector('img'); im.onerror=()=>b.remove(); im.src=FAVICO+'/api/imageproxy?url='+encodeURIComponent(r.url);
          b.onclick=()=>{ webRes.querySelectorAll('.ic').forEach(x=>x.classList.remove('sel')); b.classList.add('sel'); if(!nameTouched) nameI.value=suggested.toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,63); loadUrl(r.url); }; webRes.appendChild(b); });
        if(!webRes.children.length) webRes.innerHTML='<small>no usable images found</small>';
      }catch{ webRes.innerHTML='<small class="err">image lookup failed</small>'; } }
    webGo.onclick=webSearch; webQ.onkeydown=(e)=>{ if(e.key==='Enter'){e.preventDefault();webSearch();} };

    // upload
    const fileInput=$('<input type="file" accept="image/*" style="display:none">'); bg.appendChild(fileInput);
    upFile.onclick=()=>fileInput.click();
    fileInput.onchange=()=>{ const f=fileInput.files[0]; fileInput.value=''; if(!f)return; if(!nameTouched) nameI.value=f.name.replace(/\\.[^.]*$/,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,63); loadFile(f); };
    // Ctrl/⌘+V: grab an image off the clipboard (from any tab), jump to Upload, load it.
    function onPaste(ev){ const items=(ev.clipboardData&&ev.clipboardData.items)||[]; for(const it of items){ if(it.type&&it.type.indexOf('image')===0){ const f=it.getAsFile(); if(f){ ev.preventDefault(); setMode('upload'); err.textContent=''; loadFile(f); return; } } } }
    document.addEventListener('paste',onPaste);

    // finish
    function close(r){ if(objUrl)URL.revokeObjectURL(objUrl); document.removeEventListener('paste',onPaste); bg.remove(); resolve(r); }
    bg.querySelector('.ccancel').onclick=()=>close(null);
    let downOnBg=false;
    bg.addEventListener('mousedown',(ev)=>{ downOnBg=(ev.target===bg); });
    bg.onclick=(ev)=>{ if(ev.target===bg && downOnBg) close(null); };
    bg.querySelector('.cgo').onclick=()=>{
      if(mode==='library'){ if(!libPick){err.textContent='Click an icon in the results to select it first.';return;} const qy=(libQ.value||'').trim().toLowerCase().replace(/[^a-z0-9-]/g,''); if(qy && qy!==libPick) pendingSynonyms.push({query:qy,cand:libPick}); close({cand:libPick}); return; }
      const name=nameI.value.trim();
      if(!iw){ err.textContent=(mode==='web')?'Search, then click a result to select it.':'Choose an image file first.'; return; }
      if(!name){ err.textContent='Enter a library name to save it as.'; return; }
      const c=document.createElement('canvas');c.width=OUT;c.height=OUT;const ctx=c.getContext('2d');const {dw,dh}=dims();const sf=OUT/V;
      if(bgMode==='solid'){ ctx.fillStyle=bgColor.value; ctx.fillRect(0,0,OUT,OUT); }
      try{ ctx.drawImage(img, ox*sf, oy*sf, dw*sf, dh*sf); close({upload:{name, dataUrl:c.toDataURL('image/png')}}); }catch{ err.textContent='That image blocked cropping — try another.'; } };

    // prefill the library tab with the suggested term so matches show immediately
    if(opts.search){ libQ.value=opts.search; libSearch(); }
    setMode('library'); setTimeout(()=>libQ.focus(),0);
  });
}

function iconRow(e, opts){
  opts=opts||{};
  const hasInitial=opts.cand||(opts.current&&e.iconUrl);
  const label=hasInitial?'Select a different icon…':'Choose an icon…';
  const detail=opts.showResolution&&e.width&&e.height?\`\${e.host||'no web URL'} · \${e.width}×\${e.height}px\`:(e.host||'no web URL');
  const row=$(\`<div class="row" data-id="\${e.id}"><input type="checkbox" class="cpick"><span class="iconcell"></span><div class="grow"><div class="name">\${esc(e.name)}</div><div class="host">\${esc(detail)}</div></div><button class="change">\${label}</button><span class="state"></span></div>\`);
  const cb=row.querySelector('.cpick'), cell=row.querySelector('.iconcell'), state=row.querySelector('.state');
  // No brand-name guessing: prefill the picker only when this row already has a
  // confirmed favico name (e.g. a Section 1 match). Otherwise leave the fields blank.
  function showIcon(url,title){ cell.innerHTML=\`<img src="\${url}" title="\${title||''}" onerror="this.style.visibility='hidden'">\`; }
  function setChosen(cand){ row.dataset.cand=cand; showIcon('https://'+cand+'.favico.app/favicon.ico', cand+'.favico.app'); cb.checked=true; row.querySelector('.change').textContent='Select a different icon…'; refreshNav(); }
  // initial icon shown in the left cell
  if(opts.cand) setChosen(opts.cand);
  else if(opts.current&&e.iconUrl) showIcon(e.iconUrl,'current icon');
  else cell.innerHTML='<span class="noicon">?</span>';
  row.querySelector('.change').onclick=async()=>{
    const known=row.dataset.cand||''; const picked=await openPicker({ search:known, name:known });
    if(!picked)return;
    if(picked.cand){ setChosen(picked.cand); return; }
    if(picked.upload){ state.textContent='Uploading…';
      try{ const res=await (await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:picked.upload.name,dataUrl:picked.upload.dataUrl})})).json();
        if(res.ok){ setChosen(res.cand); state.textContent=''; } else state.innerHTML='<span class="err">'+esc(res.error||'upload failed')+'</span>';
      }catch{ state.innerHTML='<span class="err">upload failed</span>'; } }
  };
  return row;
}

load();
</script></body></html>`;

// Bind the server, hopping to the next port if one is already in use (e.g. an
// earlier instance is still running). Exits with a clear message if none free.
function listenOn(port, triesLeft) {
  const onListening = () => {
    server.removeListener("error", onError);
    const p = server.address().port;
    const link = `http://localhost:${p}`;
    if (p !== PORT) console.error(`  ✓ Using port ${p} instead.`);
    console.error(`\n  ▶  Open  ${link}  in your browser\n     (Ctrl+C here when you're done.)`);
    if (!process.argv.includes("--no-open")) openBrowser(link);
  };
  const onError = (e) => {
    server.removeListener("listening", onListening); // drop this attempt's success handler
    if (e.code === "EADDRINUSE" && triesLeft > 0) {
      console.error(`  • Port ${port} is busy, trying ${port + 1}…`);
      listenOn(port + 1, triesLeft - 1);
    } else if (e.code === "EADDRINUSE") {
      console.error(`\n  ✗ Ports ${PORT}–${port} are all in use. Close the other instance (Ctrl+C in its window),`);
      console.error(`    or pick one yourself:  PORT=9000 node scripts/bw-favico-ui.mjs`);
      process.exit(1);
    } else {
      console.error(`\n  ✗ Server error: ${e.message}`);
      process.exit(1);
    }
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, "127.0.0.1");
}

async function main() {
  if (!SESSION) { console.error("Set BW_SESSION first:  export BW_SESSION=$(bw unlock --raw)"); process.exit(1); }
  assertWorkingSpace();
  try { bw(["--version"]); } catch { console.error("Bitwarden CLI not found. Install: npm i -g @bitwarden/cli"); process.exit(1); }

  // confirm the session actually unlocked (a wrong master password leaves it locked / the var empty)
  let st;
  try {
    const out = bw(["status"]);
    st = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  } catch { /* st stays undefined */ }
  if (!st || st.status !== "unlocked") {
    console.error(`\n  ✗ Vault is ${st?.status ?? "not accessible"} — wrong master password, or the session expired.`);
    console.error("    Re-run:  $env:BW_SESSION = bw unlock --raw   (then start this again)\n");
    process.exit(1);
  }
  VAULT_WEB = vaultWebUrl(st.serverUrl);
  console.error(`  ✓ favico v${VERSION} — vault unlocked for ${st.userEmail} on ${serverLabel(st.serverUrl)}`);

  if (process.argv.includes("--no-backup")) {
    console.error("Skipping backup (--no-backup).");
  } else {
    try {
      console.error("Backing up your vault first (encrypted)…");
      const file = backupVault();
      console.error(`  ✓ encrypted backup saved: ${path.resolve(file)}`);
      console.error("    restore via Bitwarden → Tools → Import → format \"Bitwarden (json)\" (same account)");
    } catch (e) {
      console.error(`  ✗ backup FAILED: ${e.message}`);
      console.error("  Aborting so you're not editing without a backup. (Use --no-backup to override.)");
      process.exit(1);
    }
  }

  const willOpen = !process.argv.includes("--no-open");
  console.error("\nReading & classifying your vault. Each login is checked against the icon");
  console.error("services, so this can take a few minutes for a large vault — please wait.");
  console.error(willOpen
    ? "Your browser will open automatically when it's done.\n"
    : "Open the link printed below when it's done.\n");

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const tty = process.stderr.isTTY;
  let fi = 0, pdone = 0, ptotal = 0, spin = null;
  const draw = () => {
    const f = frames[fi = (fi + 1) % frames.length];
    const frac = ptotal ? ` — ${pdone}/${ptotal} entries (${Math.round((pdone / ptotal) * 100)}%)` : "…";
    process.stderr.write(`\r\x1b[2K  ${f} Scanning your vault${frac}`);
  };
  if (tty) spin = setInterval(draw, 120);
  await classify((d, t) => {
    pdone = d; ptotal = t;
    if (!tty && (d === t || d % 25 === 0)) console.error(`  …${d}/${t} entries`);
  });
  if (spin) clearInterval(spin);
  if (tty) process.stderr.write("\r\x1b[2K");

  console.error(`  ✓ Scanned ${ptotal} login${ptotal === 1 ? "" : "s"}.`);
  console.error(`     Section 1 (no icon, matched): ${SECTIONS.s1.length}`);
  console.error(`     Section 2 (no icon, no match): ${SECTIONS.s2.length}`);
  console.error(`     Section 3 (has icon): ${SECTIONS.s3.length}`);
  console.error(`     Low-resolution icons (47×47 or smaller): ${SECTIONS.quality.length}`);
  console.error(`     Suggested renames: ${SECTIONS.renames.length}   Duplicate groups: ${SECTIONS.dups.length}`);
  listenOn(PORT, 20);
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`\n  ✗ ${e.message}\n`);
    process.exitCode = 1;
  });
}

export { duplicateComparison, HTML, imageDimensions, inspectIcon, needsQualityImprovement, probeBitwardenIconService, safeBwError, validLoginUri };

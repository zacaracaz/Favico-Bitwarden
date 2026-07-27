import assert from "node:assert/strict";
import test from "node:test";
import {
  duplicateComparison,
  HTML,
  imageDimensions,
  inspectIcon,
  needsQualityImprovement,
  probeBitwardenIconService,
  safeBwError,
  validLoginUri,
} from "./bw-favico-ui.mjs";

test("imageDimensions reads common favicon formats", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(32, 16);
  png.writeUInt32BE(47, 20);
  assert.deepEqual(imageDimensions(png), { width: 32, height: 47 });

  const gif = Buffer.alloc(10);
  gif.write("GIF89a", 0, "ascii");
  gif.writeUInt16LE(16, 6);
  gif.writeUInt16LE(24, 8);
  assert.deepEqual(imageDimensions(gif), { width: 16, height: 24 });

  const ico = Buffer.from([0, 0, 1, 0, 1, 0, 0, 0]);
  assert.deepEqual(imageDimensions(ico), { width: 256, height: 256 });
});

test("quality review includes only icons measuring 47x47 or less", () => {
  assert.equal(needsQualityImprovement({ kind: "icon", width: 47, height: 47 }), true);
  assert.equal(needsQualityImprovement({ kind: "icon", width: 48, height: 47 }), false);
  assert.equal(needsQualityImprovement({ kind: "icon", width: 32, height: 64 }), false);
  assert.equal(needsQualityImprovement({ kind: "missing", width: 16, height: 16 }), false);
});

test("inline browser script compiles", () => {
  const script = HTML.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("Bitwarden CLI errors never expose command arguments or vault data", () => {
  const secret = "session-and-encoded-vault-data";
  const error = safeBwError(
    { message: `Command failed: bw edit item ${secret}\nENOSPC: no space left on device` },
    "edit",
  );
  assert.equal(error.code, "ENOSPC");
  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.match(error.message, /free at least 250 MB/i);
});

test("Editor Mode accepts normal and app-specific Bitwarden URLs", () => {
  assert.equal(validLoginUri("https://example.com/login"), true);
  assert.equal(validLoginUri("example.com"), true);
  assert.equal(validLoginUri("androidapp://com.example.app"), true);
  assert.equal(validLoginUri("not a url"), false);
});

test("inspectIcon accepts real icon bytes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  try {
    const result = await inspectIcon("https://icons.bitwarden.net/google.com/icon.png");
    assert.equal(result.kind, "icon");
    assert.match(result.hash, /^[a-f0-9]{40}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inspectIcon recognises Bitwarden missing-icon responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [404, 503]) {
      globalThis.fetch = async () => new Response("", { status });
      assert.equal((await inspectIcon("https://icons.bitwarden.net/missing/icon.png")).kind, "missing");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probe accepts 503 only after a known icon proves service health", async () => {
  const requestIcon = async (url) => url.includes("google.com")
    ? { kind: "icon", hash: "known", status: 200 }
    : { kind: "missing", hash: null, status: 503 };
  const hashes = await probeBitwardenIconService(requestIcon);
  assert.equal(hashes.size, 0);
});

test("probe rejects a real icon-service outage", async () => {
  const requestIcon = async () => ({ kind: "missing", hash: null, status: 503 });
  await assert.rejects(
    probeBitwardenIconService(requestIcon),
    /icon service is unavailable/i,
  );
});

test("probe retains legacy placeholder hashes", async () => {
  const requestIcon = async (url) => url.includes("google.com")
    ? { kind: "icon", hash: "known", status: 200 }
    : { kind: "icon", hash: "placeholder", status: 200 };
  const hashes = await probeBitwardenIconService(requestIcon);
  assert.deepEqual([...hashes], ["placeholder"]);
});

test("duplicate comparison flags a mostly-empty entry without exposing secrets", () => {
  const result = duplicateComparison([
    {
      id: "full",
      name: "GitHub",
      login: { username: "zac@example.com", password: "do-not-display", uris: [{ uri: "https://github.com/login" }] },
      notes: "recovery details",
      fields: [{ name: "Recovery code", value: "also-secret" }],
      revisionDate: "2026-07-28T00:00:00.000Z",
    },
    {
      id: "empty",
      name: "Github",
      login: { username: "zac@example.com", password: "", uris: [{ uri: "https://github.com" }] },
      revisionDate: "2025-01-01T00:00:00.000Z",
    },
  ], true);
  assert.equal(result.entries[0].mostlyEmpty, false);
  assert.equal(result.entries[1].mostlyEmpty, true);
  assert.deepEqual(result.differences.map((d) => d.label), [
    "Name", "Web addresses", "Password", "Notes", "Custom fields", "Last updated",
  ]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /do-not-display|recovery details|also-secret/);
  assert.match(serialized, /No password/);
});

test("duplicate comparison honours disabled password comparison", () => {
  const result = duplicateComparison([
    { id: "1", name: "GitHub", login: { username: "zac", password: "one", uris: [{ uri: "https://github.com" }] } },
    { id: "2", name: "GitHub", login: { username: "zac", password: "two", uris: [{ uri: "https://github.com" }] } },
  ], false);
  assert.equal(result.passwordCompared, false);
  assert.equal(result.differences.some((d) => d.label === "Password"), false);
});

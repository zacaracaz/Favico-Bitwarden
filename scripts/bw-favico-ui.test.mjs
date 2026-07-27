import assert from "node:assert/strict";
import test from "node:test";
import { inspectIcon, probeBitwardenIconService } from "./bw-favico-ui.mjs";

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

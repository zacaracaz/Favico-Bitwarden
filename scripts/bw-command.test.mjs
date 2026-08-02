import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  BITWARDEN_SERVERS,
  bitwardenDownloadUrl,
  bundledBwPath,
  bwInvocation,
  loginArgs,
  validServerUrl,
} from "./bw-command.mjs";

test("uses Favico's private Bitwarden executable when configured", () => {
  const result = bwInvocation(["status"], {
    platform: "linux",
    configuredPath: "/tmp/favico/bw",
  });
  assert.deepEqual(result, { file: "/tmp/favico/bw", args: ["status"] });
});

test("falls back to the platform Bitwarden command", () => {
  assert.deepEqual(bwInvocation(["--version"], { platform: "linux" }), {
    file: "bw",
    args: ["--version"],
  });
  assert.deepEqual(bwInvocation(["--version"], { platform: "win32" }), {
    file: "cmd",
    args: ["/d", "/s", "/c", "bw", "--version"],
  });
});

test("selects only Bitwarden's dependency-free x64 downloads", () => {
  assert.match(bitwardenDownloadUrl("linux", "x64"), /bitwarden\.com\/download/);
  assert.match(bitwardenDownloadUrl("darwin", "x64"), /platform=macos/);
  assert.equal(bitwardenDownloadUrl("linux", "arm64"), null);
  assert.equal(bundledBwPath("/opt/favico", "linux"), path.join("/opt/favico", ".favico-runtime", "bw"));
});

test("maps safe interactive login choices without collecting credentials", () => {
  assert.deepEqual(loginArgs("password"), ["login"]);
  assert.deepEqual(loginArgs("sso"), ["login", "--sso"]);
  assert.deepEqual(loginArgs("apikey"), ["login", "--apikey"]);
  assert.equal(BITWARDEN_SERVERS.eu, "https://vault.bitwarden.eu");
  assert.equal(validServerUrl("https://vault.example.test"), true);
  assert.equal(validServerUrl("file:///tmp/vault"), false);
  assert.equal(validServerUrl("not a server"), false);
});

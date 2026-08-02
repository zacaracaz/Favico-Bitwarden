import { existsSync } from "fs";
import path from "path";

export const BW_DOWNLOAD_URLS = Object.freeze({
  win32: "https://bitwarden.com/download/?app=cli&platform=windows",
  darwin: "https://bitwarden.com/download/?app=cli&platform=macos",
  linux: "https://bitwarden.com/download/?app=cli&platform=linux",
});

export const BITWARDEN_SERVERS = Object.freeze({
  us: "https://vault.bitwarden.com",
  eu: "https://vault.bitwarden.eu",
});

export function loginArgs(method) {
  if (method === "sso") return ["login", "--sso"];
  if (method === "apikey") return ["login", "--apikey"];
  return ["login"];
}

export function validServerUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function bundledBwPath(root, platform = process.platform) {
  return path.join(root, ".favico-runtime", platform === "win32" ? "bw.exe" : "bw");
}

export function bitwardenDownloadUrl(platform = process.platform, arch = process.arch) {
  if (arch !== "x64") return null;
  return BW_DOWNLOAD_URLS[platform] || null;
}

export function bwInvocation(args, options = {}) {
  const platform = options.platform || process.platform;
  const configuredPath = options.configuredPath || process.env.FAVICO_BW_PATH;
  const localPath = options.localPath;
  const executable = configuredPath || (localPath && existsSync(localPath) ? localPath : "");

  if (executable) return { file: executable, args };
  if (platform === "win32") return { file: "cmd", args: ["/d", "/s", "/c", "bw", ...args] };
  return { file: "bw", args };
}

import { existsSync } from "node:fs";
import { join } from "node:path";

export const isWindows = process.platform === "win32";

const chromeCandidates = (env) => [
  env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  env.LOCALAPPDATA &&
    join(env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  env.PROGRAMFILES &&
    join(env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
  env["PROGRAMFILES(X86)"] &&
    join(env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
];

/** Find a Chrome binary without silently accepting a broken CHROME_PATH. */
export function discoverChrome(env = process.env) {
  if (env.CHROME_PATH && !existsSync(env.CHROME_PATH)) {
    throw new Error(`CHROME_PATH does not exist: ${env.CHROME_PATH}`);
  }
  const candidates = chromeCandidates(env).filter(Boolean);
  const chrome = candidates.find((candidate) => existsSync(candidate));
  if (!chrome) throw new Error("Chrome not found; set CHROME_PATH");
  return chrome;
}

function isPrivateHost(hostname) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host.startsWith("::ffff:") ||
    /^(?:127|10)\./u.test(host) ||
    /^192\.168\./u.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host) ||
    /^169\.254\./u.test(host) ||
    /^f[cd][0-9a-f]{2}:/iu.test(host) ||
    /^fe80:/iu.test(host)
  );
}

/** Parse the target; throw coded errors so the CLI can keep credentials out of logs. */
export function parseTarget(raw, env = process.env) {
  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("target must be an http(s) URL");
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("target must be an http(s) URL");
  }
  if (target.username || target.password) {
    throw new Error("target URL must not contain credentials");
  }
  if (target.search && env.WEB_SCORE_ALLOW_QUERY !== "1") {
    throw new Error(
      "target must not include a query string; set WEB_SCORE_ALLOW_QUERY=1 to override",
    );
  }
  if (isPrivateHost(target.hostname) && env.WEB_SCORE_ALLOW_PRIVATE !== "1") {
    throw new Error(
      "target must be a public host; set WEB_SCORE_ALLOW_PRIVATE=1 to override",
    );
  }
  target.hash = "";
  return target;
}

export function samePage(actualUrl, expectedUrl) {
  try {
    const actual = new URL(actualUrl);
    const wanted = new URL(expectedUrl);
    const normalize = (path) => path.replace(/\/+$/u, "") || "/";
    return (
      actual.origin === wanted.origin &&
      normalize(actual.pathname) === normalize(wanted.pathname) &&
      actual.search === wanted.search
    );
  } catch {
    return false;
  }
}

export function reportAgeMs(report) {
  const scannedAt = Date.parse(report.scanned_at ?? report.scannedAt ?? "");
  if (!Number.isFinite(scannedAt)) return Number.POSITIVE_INFINITY;
  const age = Date.now() - scannedAt;
  // Small clock skew is harmless; a scan from the future is not fresh evidence.
  return age >= -5 * 60 * 1000 ? Math.max(age, 0) : Number.POSITIVE_INFINITY;
}

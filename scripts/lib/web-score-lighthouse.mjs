import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { signalTree } from "./web-score-browser.mjs";
import { samePage } from "./web-score-common.mjs";

const requiredCategories = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
];

function windowsArg(value) {
  return /^[A-Za-z0-9_./:@=+\\-]+$/u.test(value)
    ? value
    : `"${value.replaceAll('"', '""')}"`;
}

function lighthouseCommand(args) {
  if (process.platform !== "win32") return { command: "pnpm", args };
  const line = ["pnpm", ...args].map(windowsArg).join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", line],
  };
}

function runChild(args, { timeout, children }) {
  const { command, args: commandArgs } = lighthouseCommand(args);
  const child = spawn(command, commandArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
    detached: true,
    windowsHide: true,
    env: { ...process.env, CI: process.env.CI ?? "1" },
  });
  children.add(child);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signalTree(child.pid, "SIGTERM");
      setTimeout(() => signalTree(child.pid, "SIGKILL"), 2_000).unref();
      reject(new Error(`${command} timed out after ${timeout} ms`));
    }, timeout);
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(code);
    };
    child.once("error", (error) => {
      children.delete(child);
      finish(error);
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      finish(null, code ?? signal);
    });
  });
}

function readReport(reportPath) {
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
}

function hasFreshFetchTime(report, startedAt) {
  const fetchedAt = Date.parse(report.fetchTime ?? "");
  return Number.isFinite(fetchedAt) && fetchedAt >= startedAt - 5_000;
}

function inspectReport(report, { exitCode, targetUrl, startedAt }) {
  const problems = [];
  if (exitCode !== 0) problems.push(`Lighthouse exited ${exitCode}`);
  if (report.configSettings?.formFactor !== "desktop") {
    problems.push(
      `form factor is ${report.configSettings?.formFactor ?? "unknown"}, not desktop`,
    );
  }
  if (!samePage(report.finalUrl, targetUrl.href)) {
    problems.push(
      `ended at ${report.finalUrl ?? "an unknown URL"}, not ${targetUrl.href}`,
    );
  }
  if (report.runtimeError) {
    problems.push(
      `runtime error: ${report.runtimeError.message ?? report.runtimeError.code}`,
    );
  }
  if (!hasFreshFetchTime(report, startedAt)) {
    problems.push(`stale or missing fetchTime (${report.fetchTime ?? "none"})`);
  }
  const categories = Object.fromEntries(
    Object.entries(report.categories ?? {}).map(([id, category]) => [
      id,
      category.score,
    ]),
  );
  const below = requiredCategories.filter((id) => categories[id] !== 1);
  if (below.length > 0) {
    problems.push(`categories below 1.0: ${below.join(", ")}`);
  }
  return { categories, problems };
}

async function auditLighthouse({
  attempt,
  targetUrl,
  port,
  reportPath,
  timeout,
  children,
}) {
  const startedAt = Date.now();
  rmSync(reportPath, { force: true });
  let exitCode;
  try {
    exitCode = await runChild(
      [
        "dlx",
        "lighthouse@12.8.2",
        targetUrl.href,
        `--port=${port}`,
        "--preset=desktop",
        "--quiet",
        "--no-enable-error-reporting",
        "--output=json",
        `--output-path=${reportPath}`,
      ],
      { timeout, children },
    );
  } catch (error) {
    return {
      categories: {},
      problems: [`could not run Lighthouse: ${error.message}`],
    };
  }
  const report = readReport(reportPath);
  if (!report) {
    return {
      categories: {},
      problems: [`Lighthouse exited ${exitCode} without a report`],
    };
  }
  const result = inspectReport(report, { exitCode, targetUrl, startedAt });
  console.log(
    `Lighthouse desktop attempt ${attempt}: ${JSON.stringify(result.categories)}`,
  );
  return result;
}

export async function runLighthouse({
  targetUrl,
  port,
  reportPath,
  timeout,
  attempts,
  children,
}) {
  let categories = {};
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await auditLighthouse({
      attempt,
      targetUrl,
      port,
      reportPath,
      timeout,
      children,
    });
    categories = result.categories;
    if (result.problems.length === 0) {
      return { passed: true, categories };
    }
    for (const problem of result.problems) {
      console.error(`FAIL: Lighthouse: ${problem}`);
    }
  }
  console.error(
    `FAIL: Lighthouse desktop did not reach 1.0 in ${attempts} attempt(s)`,
  );
  return { passed: false, categories };
}

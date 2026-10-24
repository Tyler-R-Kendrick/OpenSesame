import { writeFileSync } from "node:fs";
import { reportAgeMs, samePage } from "./web-score-common.mjs";

async function getReport(origin, target) {
  const endpoint = new URL("/api/v1/report", origin);
  endpoint.searchParams.set("url", target);
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
      "User-Agent": "opensesame-web-score/1",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Is Agentic report returned HTTP ${response.status}`);
  }
  const report = await response.json();
  const score = Number(report?.score);
  if (!report || !Number.isFinite(score)) {
    throw new Error("Is Agentic report has no score");
  }
  report.score = score;
  return report;
}

async function refreshReport(origin, target) {
  const endpoint = new URL("/api/scan/stream", origin);
  endpoint.searchParams.set("target", target);
  const response = await fetch(endpoint, {
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-store",
      "User-Agent": "opensesame-web-score/1",
    },
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Is Agentic scan returned HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const handleFrame = (frame) => {
    const data = frame
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.type === "scan_failed") {
      throw new Error(event.message ?? "Is Agentic scan failed");
    }
    if (event.type === "scan_complete") completed = true;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = frames.pop() ?? "";
      for (const frame of frames) handleFrame(frame);
      if (completed) break;
    }
    if (!completed && buffer.trim()) handleFrame(buffer);
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!completed) {
    throw new Error("Is Agentic stream ended without scan_complete");
  }
}

async function currentReport(origin, target, maxAgeMs) {
  try {
    const report = await getReport(origin, target);
    if (reportAgeMs(report) <= maxAgeMs) return report;
    console.log(
      "Is Agentic report is older than the allowed age; starting a scan",
    );
  } catch (error) {
    console.log(
      `Is Agentic report unavailable (${error.message}); starting a scan`,
    );
  }
  return null;
}

/** Return the public report only when it is fresh and describes this origin. */
export async function checkAgentic({ origin, target, maxAgeMs, reportPath }) {
  let report = await currentReport(origin, target, maxAgeMs);
  if (!report) {
    await refreshReport(origin, target);
    report = await getReport(origin, target);
  }
  if (reportAgeMs(report) > maxAgeMs) {
    throw new Error("Is Agentic report is still stale after a scan");
  }
  if (!report.target || !samePage(report.target, target)) {
    throw new Error(
      `Is Agentic report targets ${report.target ?? "nothing"}, not ${target}`,
    );
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

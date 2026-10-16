import fs from "node:fs";

const SUMMARY_PATH = "/tmp/deepsec-wave2-grok-depth-summary.json";

export type GrokDepthSummary = {
  shallowCapOrTimeout: number;
  deepRetries: number;
  deepCompleted: number;
  lastUpdatedAt: string;
};

function emptySummary(): GrokDepthSummary {
  return {
    shallowCapOrTimeout: 0,
    deepRetries: 0,
    deepCompleted: 0,
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function readGrokDepthSummary(): GrokDepthSummary {
  if (!fs.existsSync(SUMMARY_PATH)) {
    return emptySummary();
  }
  try {
    const raw = JSON.parse(
      fs.readFileSync(SUMMARY_PATH, "utf8"),
    ) as GrokDepthSummary;
    return { ...emptySummary(), ...raw };
  } catch {
    return emptySummary();
  }
}

export function bumpGrokDepthSummary(
  patch: Partial<
    Pick<
      GrokDepthSummary,
      "shallowCapOrTimeout" | "deepRetries" | "deepCompleted"
    >
  >,
): GrokDepthSummary {
  const cur = readGrokDepthSummary();
  const next: GrokDepthSummary = {
    shallowCapOrTimeout:
      cur.shallowCapOrTimeout + (patch.shallowCapOrTimeout ?? 0),
    deepRetries: cur.deepRetries + (patch.deepRetries ?? 0),
    deepCompleted: cur.deepCompleted + (patch.deepCompleted ?? 0),
    lastUpdatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

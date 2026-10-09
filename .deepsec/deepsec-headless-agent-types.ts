export const DEEPSEC_SYSTEM_NOTE =
  "You are running inside the deepsec harness for OpenSesame. Use read-only inspection (read/grep files). " +
  "Do not run the target application, send network requests, or attempt exploitation.";

export const JSON_ONLY_SUFFIX =
  "\n\n## CRITICAL — output format\n" +
  "Your **entire** final reply must be **only** a JSON array (you may wrap it in a ```json fence). " +
  'Do **not** write prose before or after the JSON. Do **not** write "I\'ll review", summaries, or markdown outside the fence. ' +
  "The first non-whitespace character must be `[` or a backtick starting a json code fence.";

export const DEFAULT_GROK_MODEL = "grok-4.7";
export const DEFAULT_KIMI_MODEL = "kimi-code/k3";
export const MAX_ATTEMPTS = 3;

export type FileRecord = {
  filePath: string;
  candidates: Array<{
    vulnSlug: string;
    lineNumbers: number[];
    matchedPattern: string;
  }>;
  findings?: Finding[];
};

export type Finding = {
  findingId?: string;
  severity: string;
  vulnSlug: string;
  title: string;
  description: string;
  lineNumbers: number[];
  recommendation: string;
  confidence: string;
};

export type InvestigateParams = {
  batch: FileRecord[];
  projectRoot: string;
  promptTemplate: string;
  projectInfo: string;
  config: Record<string, unknown>;
  signal?: AbortSignal;
  projectId?: string;
};

export type RevalidateParams = {
  batch: FileRecord[];
  projectRoot: string;
  projectInfo: string;
  config: Record<string, unknown>;
  force?: boolean;
  onlyFindingIds?: string[];
  signal?: AbortSignal;
  projectId?: string;
};

export type TriageFindingRef = {
  filePath: string;
  title: string;
  severity: string;
  vulnSlug: string;
  lineNumbers: number[];
  confidence: string;
  description: string;
};

export type TriageParams = {
  batch: TriageFindingRef[];
  projectRoot: string;
  projectInfo: string;
  config: Record<string, unknown>;
  signal?: AbortSignal;
  projectId?: string;
};

export type TriageVerdict = {
  title: string;
  priority: "P0" | "P1" | "P2" | "skip";
  exploitability: "trivial" | "moderate" | "difficult";
  impact: "critical" | "high" | "medium" | "low";
  reasoning: string;
};

export type RunPromptParams = {
  cwd: string;
  prompt: string;
  model: string;
  signal?: AbortSignal;
  maxTurns?: number;
};

export function modelFromConfig(
  config: Record<string, unknown>,
  defaultModel: string,
): string {
  const m = config.model;
  return typeof m === "string" && m.length > 0 ? m : defaultModel;
}

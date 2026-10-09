import {
  DEEPSEC_SYSTEM_NOTE,
  type FileRecord,
  type Finding,
  JSON_ONLY_SUFFIX,
  type TriageFindingRef,
  type TriageVerdict,
} from "./deepsec-headless-agent-types.js";

function parseJsonArrayFromAgent(text: string): unknown[] {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = fence ? fence[1].trim() : text.trim();
  const parsed = JSON.parse(jsonStr) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array from agent");
  }
  return parsed;
}

export function parseInvestigateResults(
  resultText: string,
  batch: FileRecord[],
) {
  const parsed = parseJsonArrayFromAgent(resultText) as Array<{
    filePath: string;
    findings?: Finding[];
  }>;
  const batchPaths = new Set(batch.map((r) => r.filePath));
  const results: Array<{ filePath: string; findings: Finding[] }> = [];
  for (const entry of parsed) {
    if (!batchPaths.has(entry.filePath)) continue;
    results.push({ filePath: entry.filePath, findings: entry.findings ?? [] });
    batchPaths.delete(entry.filePath);
  }
  for (const filePath of batchPaths) {
    results.push({ filePath, findings: [] });
  }
  return { results, invalid: [] as unknown[] };
}

export function buildRevalidatePrompt(
  batch: FileRecord[],
  projectInfo: string,
): { prompt: string; total: number } {
  const sections: string[] = [];
  let total = 0;
  for (const file of batch) {
    const findings = file.findings ?? [];
    if (findings.length === 0) continue;
    total += findings.length;
    const list = findings
      .map(
        (f, i) =>
          `### Finding F${i + 1}: ${f.title}\n- **Finding ID:** F${i + 1}\n- **Severity:** ${f.severity}\n- **Slug:** ${f.vulnSlug}\n- **Lines:** ${f.lineNumbers.join(", ")}\n- **Description:** ${f.description}\n- **Recommendation:** ${f.recommendation}`,
      )
      .join("\n\n");
    sections.push(`## File: ${file.filePath}\n\n${list}`);
  }
  const ctx = projectInfo ? `## Project Context\n\n${projectInfo}\n\n` : "";
  const prompt = `You are a security researcher revalidating vulnerability findings (static analysis only).

${ctx}${sections.join("\n---\n\n")}

For each finding ID (F1, F2, …), output a verdict JSON array:

\`\`\`json
[
  { "findingId": "F1", "verdict": "true-positive|false-positive|fixed|uncertain|duplicate", "reasoning": "...", "adjustedSeverity": "HIGH" }
]
\`\`\`${JSON_ONLY_SUFFIX}`;
  return { prompt, total };
}

export function parseRevalidateVerdicts(text: string) {
  return parseJsonArrayFromAgent(text) as Array<{
    findingId: string;
    verdict: string;
    reasoning: string;
    adjustedSeverity?: string;
    duplicateOf?: string;
  }>;
}

export function buildTriagePrompt(
  batch: TriageFindingRef[],
  projectInfo: string,
): string {
  const findingsList = batch
    .map(
      (item, idx) =>
        `### ${idx + 1}. ${item.title}
- **File:** \`${item.filePath}\`
- **Severity:** ${item.severity}
- **Slug:** ${item.vulnSlug}
- **Lines:** ${item.lineNumbers.join(", ")}
- **Confidence:** ${item.confidence}
- **Description:** ${item.description}`,
    )
    .join("\n\n");
  const ctx = projectInfo
    ? `## Project Context (summary only)\n\n${projectInfo.slice(0, 2000)}\n\n`
    : "";
  return `${DEEPSEC_SYSTEM_NOTE}

You are a security triage expert with **no tools** and **no file access**. Classify from the finding text only; do not say you will read or verify code.

You are a security triage expert. Given a list of vulnerability findings, classify each by priority for remediation.

${ctx}## Findings to Triage

${findingsList}

## Classification Criteria

**P0 — Fix immediately:** Exploitable by external attackers with trivial effort. Direct impact on user data, auth bypass, or code execution. No mitigations in place.

**P1 — Fix soon:** Real vulnerability but requires specific conditions (internal access, feature flag enabled, race condition). Moderate impact.

**P2 — Fix eventually:** Low-impact or difficult to exploit. Defense-in-depth improvements. Code quality issues with security implications.

**skip — Not actionable:** False positive, already mitigated, test-only code, or too vague to act on.

## Exploitability scale
- **trivial**: Can be exploited with a single crafted HTTP request or URL
- **moderate**: Requires some setup (valid auth, specific timing, internal network)
- **difficult**: Requires deep knowledge, chained exploits, or unlikely conditions

## Impact scale
- **critical**: Full auth bypass, RCE, data exfiltration across tenants
- **high**: Single-tenant data access, privilege escalation, secret exposure
- **medium**: Information disclosure, DoS, weak crypto
- **low**: Cosmetic, theoretical, or minimal real-world impact

## Output

\`\`\`json
[
  {
    "title": "exact title",
    "priority": "P0" | "P1" | "P2" | "skip",
    "exploitability": "trivial" | "moderate" | "difficult",
    "impact": "critical" | "high" | "medium" | "low",
    "reasoning": "1-2 sentences"
  }
]
\`\`\`${JSON_ONLY_SUFFIX}`;
}

export function parseTriageVerdicts(text: string): TriageVerdict[] {
  const parsed = parseJsonArrayFromAgent(text) as TriageVerdict[];
  for (const v of parsed) {
    if (
      !v.title ||
      !v.priority ||
      !v.exploitability ||
      !v.impact ||
      !v.reasoning
    ) {
      throw new Error("Triage verdict missing required fields");
    }
  }
  return parsed;
}

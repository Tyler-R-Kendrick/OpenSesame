/**
 * Shared deepsec headless agent (investigate / revalidate / triage) for external CLIs.
 */

export { extractTextFromAgentStdout } from "./deepsec-agent-stdout.js";
export {
  DEEPSEC_SYSTEM_NOTE,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_KIMI_MODEL,
  JSON_ONLY_SUFFIX,
  MAX_ATTEMPTS,
  modelFromConfig,
} from "./deepsec-headless-agent-types.js";
export type {
  FileRecord,
  Finding,
  InvestigateParams,
  RevalidateParams,
  RunPromptParams,
  TriageFindingRef,
  TriageParams,
  TriageVerdict,
} from "./deepsec-headless-agent-types.js";

export { createHeadlessDeepsecAgent } from "./deepsec-headless-agent-impl.js";

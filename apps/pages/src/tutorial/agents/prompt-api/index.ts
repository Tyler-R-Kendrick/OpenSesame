/**
 * The on-device support agent: a `SupportAgentPort` backed by the browser's
 * built-in Prompt API, with no vendor SDK and no network egress.
 */

export {
  type LocalLanguageModelApi,
  type LocalModelAvailabilityState,
  type LocalModelCreateOptions,
  type LocalModelProgressListener,
  type LocalModelPrompt,
  type LocalModelPromptOptions,
  type LocalModelPromptRole,
  type LocalModelSession,
  detectLocalLanguageModel,
} from "./detect.js";
export {
  type PromptApiAgentOptions,
  acquireLocalModel,
  acquirePromptApiModel,
  createPromptApiAgent,
  createPromptApiSupportAgent,
  readLocalModelDownloadProgress,
  resetLocalModelDownloadProgressForTest,
} from "./prompt-api-agent.js";

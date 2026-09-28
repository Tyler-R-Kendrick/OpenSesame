export {
  createLogger,
  redactDeep,
  LOG_REDACT_PATHS,
  type CreateLoggerOptions,
  type Logger,
} from "./logger.js";
export {
  REDACTED,
  isSensitiveKey,
  scrubText,
  scrubValue,
} from "@opensesame/log-scrub";
export {
  AgentPayloadRefused,
  forAgent,
  looksLikeCredential,
  registerAgentSecret,
  scrubLocalSecrets,
} from "./agent-payload.js";

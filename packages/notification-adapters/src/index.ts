/**
 * `@opensesame/notification-adapters` — one contract, seven providers.
 *
 * The vocabulary is `@opensesame/os-domain`'s: channel kinds, capability
 * records, confidentiality levels and the settlement evaluator all live
 * there, and nothing here redeclares any of them. This package is the layer
 * that turns those declarations into requests on a wire and provider
 * callbacks into checked facts — and it is deliberately incapable of
 * deciding anything with them.
 */

export * from "./contract.js";
export * from "./templates.js";
export * from "./registry.js";
export * from "./adapters/slack.js";
export * from "./adapters/telegram.js";
export * from "./adapters/teams.js";
export * from "./adapters/wechat.js";
export * from "./adapters/sms.js";
export * from "./adapters/web-push.js";
export * from "./adapters/generic-webhook.js";
export {
  bytesEqual,
  callbackDigest,
  secretsEqual,
  base64UrlDecode,
  base64UrlEncode,
} from "./bytes.js";
export {
  classifyHttpStatus,
  DELIVERY_TIMEOUT_MS,
  isHttpsUrl,
} from "./http.js";

/**
 * Duress runtime surface. Prefer deep imports in app code; this barrel stays
 * collision-free for build typecheck.
 */
export * from "./access/context.js";
export * from "./access/iam.js";
export * from "./access/protect.js";
export * from "./access/capability-narrow.js";
export * from "./access/operations.js";
export * from "./session/fence.js";
export * from "./session/durable.js";
export * from "./crypto/slots.js";
export * from "./crypto/age-activation.js";
export * from "./trigger/enrollment.js";
export * from "./alert/outbox.js";
export * from "./recovery/custody.js";
export * from "./removal/local-remove.js";
export * from "./peer/envelope.js";
export * from "./store/compartment-guard.js";
export * from "./incident/activate.js";
export * from "./feature/mode.js";
export * from "./feature/format.js";

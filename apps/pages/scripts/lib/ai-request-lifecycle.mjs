/** Native Request identity is the terminal authority; URL/error classes grant no exception. */
import { expect } from "@playwright/test";

export const AI_EXCHANGE_HEADER = "x-opensesame-ai-exchange";
const REASONS = new Set(["support-cancel", "route-unmount", "vault-lock"]);
function reject(state, reason) {
  state.failures.add(reason);
  throw new Error(reason);
}
function currentHold(state, hold) {
  const record = state.holds.get(hold);
  if (!record) reject(state, "unknown-hold");
  return record;
}
function nativeRow(state, request) {
  const row = state.requests.get(request);
  if (!row) reject(state, "unknown-native-event");
  return row;
}
function observeRequest(state, context, label, request) {
  if (state.requests.has(request)) reject(state, "duplicate-native-request");
  state.requests.set(request, {
    id: `native-${state.requests.size + 1}`,
    context,
    label,
    method: request.method(),
    resourceType: request.resourceType(),
    terminal: null,
    terminalSeq: null,
    hold: null,
  });
}
function connect(state, hold, request) {
  const row = nativeRow(state, request);
  if (hold.row || row.hold || row.terminal)
    reject(state, "invalid-hold-binding");
  hold.row = row;
  row.hold = hold;
  hold.resolve();
}
function observeResponse(state, response) {
  const request = response.request();
  nativeRow(state, request);
  const correlation = response.headers()[AI_EXCHANGE_HEADER];
  if (!correlation) return;
  if (new URL(request.url()).origin !== state.fixtureOrigin)
    reject(state, "foreign-response-correlation");
  const binding = state.correlations.get(correlation) ?? {
    request: null,
    hold: null,
  };
  if (binding.request) reject(state, "duplicate-response-correlation");
  binding.request = request;
  state.correlations.set(correlation, binding);
  if (binding.hold) connect(state, binding.hold, request);
}
function observeTerminal(state, request, terminal) {
  const row = nativeRow(state, request);
  if (row.terminal) reject(state, `duplicate-native-terminal:${row.id}`);
  row.terminal = terminal;
  row.terminalSeq = ++state.sequence;
  if (terminal === "failed" && !row.hold?.armedSeq)
    state.failures.add(`ordinary-native-failure:${row.id}`);
  if (terminal === "finished" && row.hold)
    state.failures.add(`held-native-finished:${row.id}`);
}
function attach(state, context, label) {
  if (state.contexts.has(context)) reject(state, "duplicate-context-observer");
  state.contexts.add(context);
  const protect = (operation) => (value) => {
    try {
      operation(value);
    } catch {
      state.failures.add("native-observer-error");
    }
  };
  context.on(
    "request",
    protect((request) => observeRequest(state, context, label, request)),
  );
  context.on(
    "response",
    protect((response) => observeResponse(state, response)),
  );
  context.on(
    "requestfinished",
    protect((request) => observeTerminal(state, request, "finished")),
  );
  context.on(
    "requestfailed",
    protect((request) => observeTerminal(state, request, "failed")),
  );
}
function reserve(state, hold) {
  const overlapping = [...state.holds.values()].some(
    (entry) => !entry.closedSeq && !entry.releaseSeq,
  );
  if (
    state.holds.has(hold) ||
    overlapping ||
    hold.started ||
    hold.closed ||
    hold.released
  )
    reject(state, "invalid-hold-reservation");
  let resolve;
  const bound = new Promise((done) => {
    resolve = done;
  });
  state.holds.set(hold, {
    id: `hold-${state.holds.size + 1}`,
    hold,
    bound,
    resolve,
    correlation: null,
    row: null,
    armedSeq: null,
    reason: null,
    closedSeq: null,
    premature: false,
    releaseSeq: null,
  });
}
function bindHold(state, hold, correlation) {
  const record = currentHold(state, hold);
  if (record.correlation || record.closedSeq || record.releaseSeq)
    reject(state, "invalid-hold-registration");
  const binding = state.correlations.get(correlation) ?? {
    request: null,
    hold: null,
  };
  if (!correlation || binding.hold) reject(state, "reused-hold-correlation");
  record.correlation = correlation;
  binding.hold = record;
  state.correlations.set(correlation, binding);
  if (binding.request) connect(state, record, binding.request);
  return record.bound;
}
function arm(state, hold, reason) {
  const record = currentHold(state, hold);
  if (
    !REASONS.has(reason) ||
    !record.row ||
    record.armedSeq ||
    record.row.terminal
  )
    reject(state, "invalid-cancellation-arm");
  if (
    !hold.started ||
    hold.closed ||
    hold.released ||
    record.closedSeq ||
    record.releaseSeq
  )
    reject(state, "late-cancellation-arm");
  record.armedSeq = ++state.sequence;
  record.reason = reason;
}
function closed(state, hold, premature) {
  const record = state.holds.get(hold);
  if (!record || record.closedSeq) {
    state.failures.add("unknown-or-duplicate-server-close");
    return;
  }
  record.closedSeq = ++state.sequence;
  record.premature = premature === true;
}
function release(state, hold) {
  const record = state.holds.get(hold);
  if (!record) {
    state.failures.add("unknown-hold-release");
    return;
  }
  if (record.releaseSeq) return;
  record.releaseSeq = ++state.sequence;
  if (!record.closedSeq)
    state.failures.add(`premature-hold-release:${record.id}`);
}
function proven(record) {
  return Boolean(
    record.armedSeq &&
      record.row?.terminal === "failed" &&
      record.row.terminalSeq > record.armedSeq &&
      record.premature &&
      record.closedSeq > record.armedSeq &&
      (!record.releaseSeq || record.releaseSeq > record.closedSeq),
  );
}
function rowsFor(state, context) {
  return [...state.requests.values()].filter(
    (row) => !context || row.context === context,
  );
}
function finalize(state, context) {
  for (const row of rowsFor(state, context)) {
    if (!row.terminal)
      state.failures.add(
        `${row.hold ? "unfinished-held" : "unfinished-ordinary"}:${row.id}`,
      );
    else if (!row.hold && row.terminal !== "finished")
      state.failures.add(`ordinary-native-failure:${row.id}`);
  }
  for (const hold of state.holds.values()) {
    if (context && hold.row && hold.row.context !== context) continue;
    if (!proven(hold))
      state.failures.add(`unproven-held-cancellation:${hold.id}`);
  }
}
async function checkpoint(state, context) {
  try {
    await expect
      .poll(() => rowsFor(state, context).filter((row) => !row.terminal).length)
      .toBe(0);
  } catch {
    state.failures.add("native-terminal-checkpoint-timeout");
  }
  finalize(state, context);
}
function snapshot(state) {
  const requests = [...state.requests.values()].map((row) => ({
    id: row.id,
    context: row.label,
    method: row.method,
    resourceType: row.resourceType,
    terminal: row.terminal,
    disposition:
      row.hold && proven(row.hold) ? "proven-cancellation" : row.terminal,
    hold: row.hold?.id ?? null,
  }));
  return {
    failures: [...state.failures],
    requests,
    ordinaryFinished: requests.filter(
      (row) => !row.hold && row.terminal === "finished",
    ).length,
    nativeFailed: requests.filter((row) => row.terminal === "failed").length,
    exposedOptions: requests.filter((row) => row.method === "OPTIONS").length,
    cancellations: [...state.holds.values()].map((hold) => ({
      id: hold.id,
      request: hold.row?.id ?? null,
      reason: hold.reason,
      proven: proven(hold),
      armedSeq: hold.armedSeq,
      failedSeq: hold.row?.terminalSeq ?? null,
      closedSeq: hold.closedSeq,
      releaseSeq: hold.releaseSeq,
    })),
    qualification:
      "Tracks every Request exposed by Playwright; server OPTIONS records do not imply native OPTIONS exposure. No credentials/body/URLs are exported here.",
  };
}
/** Fixture calls reserve/bindHold/closed/release; UI intent calls arm via its exact hold. */
export function createAiRequestLifecycle({ fixtureOrigin }) {
  const state = {
    fixtureOrigin,
    requests: new Map(),
    contexts: new Set(),
    holds: new Map(),
    correlations: new Map(),
    failures: new Set(),
    sequence: 0,
  };
  return {
    attach: (context, label) => attach(state, context, label),
    reserve: (hold) => reserve(state, hold),
    bindHold: (hold, correlation) => bindHold(state, hold, correlation),
    arm: (hold, reason) => arm(state, hold, reason),
    closed: (hold, premature) => closed(state, hold, premature),
    release: (hold) => release(state, hold),
    checkpoint: (context) => checkpoint(state, context),
    finalize: (context) => finalize(state, context),
    snapshot: () => snapshot(state),
  };
}

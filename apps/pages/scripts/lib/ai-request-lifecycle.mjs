/** Native Request identity is the terminal authority; URL/error classes grant no exception. */
import { expect } from "@playwright/test";
import { z } from "zod";

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
function requestLocation(request) {
  try {
    const url = new URL(request.url());
    const http = url.protocol === "http:" || url.protocol === "https:";
    return {
      scheme: url.protocol.slice(0, 32),
      origin: url.origin.slice(0, 512),
      originTruncated: url.origin.length > 512,
      pathname: http ? url.pathname.slice(0, 512) : null,
      pathnameTruncated: http && url.pathname.length > 512,
    };
  } catch {
    return { scheme: null, origin: null, pathname: null };
  }
}
async function readDocument(frame) {
  const epoch = await frame.evaluate(
    () =>
      Object.getOwnPropertyDescriptor(
        globalThis,
        "__opensesameAiCompletion",
      )?.value.snapshot().epoch ?? null,
  );
  return `document-${z.string().uuid().parse(epoch)}`;
}
function bindDocument(state, request, row) {
  const binding = Promise.resolve()
    .then(() => {
      const frame = request.frame();
      if (frame !== frame.page().mainFrame())
        throw new Error("Foreign operation frame");
      return readDocument(frame);
    })
    .then((document) => {
      row.document = document;
    })
    .catch(() => {
      state.failures.add("native-document-binding-failed");
    });
  state.bindings.add(binding);
  void binding.then(() => state.bindings.delete(binding));
}
function observeRequest(state, context, label, request) {
  if (state.requests.has(request)) reject(state, "duplicate-native-request");
  const row = {
    id: `native-${state.requests.size + 1}`,
    context,
    label,
    document: null,
    method: request.method(),
    resourceType: request.resourceType(),
    ...requestLocation(request),
    startedAt: Date.now(),
    responseAt: null,
    terminalAt: null,
    status: null,
    correlation: null,
    terminal: null,
    terminalSeq: null,
    hold: null,
  };
  state.requests.set(request, row);
  if (row.origin === state.fixtureOrigin && row.method === "POST")
    bindDocument(state, request, row);
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
  const row = nativeRow(state, request);
  row.responseAt = Date.now();
  row.status = response.status();
  const correlation = response.headers()[AI_EXCHANGE_HEADER];
  if (!correlation) return;
  if (new URL(request.url()).origin !== state.fixtureOrigin)
    reject(state, "foreign-response-correlation");
  row.correlation = correlation.slice(0, 128);
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
  row.terminalAt = Date.now();
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
async function quiesce(state, context) {
  let signature = null;
  let changedAt = performance.now();
  await expect
    .poll(
      () => {
        const requests = rowsFor(state, context);
        const next = JSON.stringify(
          requests.map(({ id, terminal }) => [id, terminal]),
        );
        const now = performance.now();
        if (next !== signature) {
          signature = next;
          changedAt = now;
        }
        return (
          state.bindings.size === 0 &&
          requests.every((request) => request.terminal !== null) &&
          now - changedAt >= 500
        );
      },
      { timeout: 5000 },
    )
    .toBe(true);
}
async function checkpoint(state, context) {
  try {
    await expect
      .poll(
        () =>
          rowsFor(state, context).filter((row) => !row.terminal).length +
          state.bindings.size,
      )
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
    document: row.document,
    method: row.method,
    resourceType: row.resourceType,
    scheme: row.scheme,
    origin: row.origin,
    originTruncated: row.originTruncated,
    pathname: row.pathname,
    pathnameTruncated: row.pathnameTruncated,
    startedAt: row.startedAt,
    responseAt: row.responseAt,
    terminalAt: row.terminalAt,
    status: row.status,
    correlation: row.correlation,
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
      "Tracks every Request exposed by Playwright; server OPTIONS records do not imply native OPTIONS exposure. Node timestamps are epoch milliseconds. Bounded scheme/origin and HTTP(S) pathname metadata excludes query, fragment, userinfo and non-HTTP payload/path. Only the owned fixture origin exports opaque exchange correlation (128 characters maximum). No credentials, body or other headers are exported.",
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
    bindings: new Set(),
  };
  return {
    attach: (context, label) => attach(state, context, label),
    document: (page) => readDocument(page),
    reserve: (hold) => reserve(state, hold),
    bindHold: (hold, correlation) => bindHold(state, hold, correlation),
    arm: (hold, reason) => arm(state, hold, reason),
    closed: (hold, premature) => closed(state, hold, premature),
    release: (hold) => release(state, hold),
    quiesce: (context) => quiesce(state, context),
    checkpoint: (context) => checkpoint(state, context),
    finalize: (context) => finalize(state, context),
    snapshot: () => snapshot(state),
  };
}

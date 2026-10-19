import { removeDeviceConfigurationDurable } from "../device-connector-records.js";
import type { HostedModelRuntime } from "../hosted-inference.js";
import type { HostedModelInput } from "../hosted-model-protocol.js";
import { assertNativeApiEditable } from "../native-api-authority.js";
import { loadNativeConnectorRecord } from "../native-connector-store.js";
import { requireNativeKey } from "../native-key-state.js";
import {
  assertVaultCredentials,
  discardVaultCredentials,
  stageVaultCredentials,
} from "../vault-credential-custody.js";
import { aiConnectionBinding, validateAiConnection } from "./configuration.js";
import { capturedAiCredentials, resolvedAiConnection } from "./credentials.js";
import { aiCompletionSeams } from "./http.js";
import { inferAiConnection, probeAiConnection } from "./inference.js";
import { aiConnectionRuntimePreset } from "./presets.js";
import type { ReplicateInput } from "./replicate-types.js";
import {
  AI_CONNECTION_CLASSIFICATION,
  aiConnectionRecord,
  commitAiConnection,
} from "./store.js";
import { captureAiConnectionTransport } from "./transport.js";
import {
  type AiConnectionDraft,
  AiConnectionError,
  type AiConnectionTransport,
} from "./types.js";
import { aiVaultSeams } from "./vault-guard.js";

async function reviewedDraft(
  supplied: AiConnectionDraft,
  tomb: string,
  id?: string,
) {
  const draft = validateAiConnection(supplied, false);
  const previous = id ? loadNativeConnectorRecord(id) : null;
  if (id && !previous)
    throw new AiConnectionError(
      "configuration",
      "Saved AI connection not found.",
    );
  if (previous) {
    if (
      previous.configuration.providerId !== draft.providerId ||
      previous.configuration.method !== "api-key"
    )
      throw new AiConnectionError(
        "configuration",
        "This connection belongs to another provider or authentication method.",
      );
    assertNativeApiEditable(previous);
    if (
      !aiConnectionRecord(previous.connectionId) &&
      draft.authentication === "api-key" &&
      !draft.apiKey
    )
      throw new AiConnectionError(
        "configuration",
        "Enter an API key to move this connection into the current vault.",
      );
  }
  if (previous && draft.authentication === "api-key" && !draft.apiKey) {
    const retained = await resolvedAiConnection(previous, tomb);
    if (aiConnectionBinding(retained) !== aiConnectionBinding(draft))
      throw new AiConnectionError(
        "configuration",
        "Enter a new API key when changing the endpoint, protocol or model.",
      );
    draft.apiKey = retained.apiKey;
  }
  return { draft: validateAiConnection(draft), previous };
}

function savedGuard(id: string, revision: number, fingerprint: string) {
  return () => {
    const current = loadNativeConnectorRecord(id);
    if (
      !current ||
      current.revision !== revision ||
      current.configuration.fingerprint !== fingerprint
    )
      throw new AiConnectionError(
        "stale",
        "This AI connection changed. Reload before continuing.",
      );
  };
}

function assertCurrentOperation(
  guard: Awaited<ReturnType<typeof aiVaultSeams.capture>>,
  transport: AiConnectionTransport,
  unchanged: () => void,
  runtime?: Pick<HostedModelRuntime, "signal" | "assertCurrent">,
) {
  guard.check();
  unchanged();
  transport.assertCurrent();
  runtime?.assertCurrent();
  transport.signal.throwIfAborted();
}

/** A real inference probe saves nothing and releases its vault session. */
export async function testAiConnection(
  supplied: AiConnectionDraft,
  id?: string,
  predictionInput?: ReplicateInput,
): Promise<string> {
  const port = captureAiConnectionTransport();
  const guard = await aiVaultSeams.capture();
  let completed = false;
  let owner: (() => void) | undefined;
  try {
    port.assertCurrent();
    guard.check();
    const transport = {
      ...port,
      signal: AbortSignal.any([port.signal, guard.signal]),
    };
    const { draft, previous } = await reviewedDraft(supplied, guard.tomb, id);
    const unchanged = previous
      ? savedGuard(
          previous.connectionId,
          previous.revision,
          previous.configuration.fingerprint,
        )
      : () => guard.check();
    const check = () => assertCurrentOperation(guard, transport, unchanged);
    owner = check;
    await probeAiConnection(draft, transport, check, predictionInput);
    check();
    completed = true;
    return "Model inference verified";
  } finally {
    guard.close(completed);
    if (completed && owner)
      aiCompletionSeams.observe?.({ phase: "operation", owner });
  }
}

/** Save through the existing native connector record with actual-vault token custody. */
export async function saveAiConnection(
  supplied: AiConnectionDraft,
  id?: string,
  predictionInput?: ReplicateInput,
) {
  const port = captureAiConnectionTransport();
  const guard = await aiVaultSeams.capture();
  let completed = false;
  let owner: (() => void) | undefined;
  try {
    port.assertCurrent();
    guard.check();
    const transport = {
      ...port,
      signal: AbortSignal.any([port.signal, guard.signal]),
    };
    const { draft, previous } = await reviewedDraft(supplied, guard.tomb, id);
    const oldCapture =
      previous && aiConnectionRecord(previous.connectionId)
        ? await capturedAiCredentials(previous, guard.tomb)
        : null;
    const unchanged = previous
      ? savedGuard(
          previous.connectionId,
          previous.revision,
          previous.configuration.fingerprint,
        )
      : () => guard.check();
    const check = () => assertCurrentOperation(guard, transport, unchanged);
    owner = check;
    await probeAiConnection(draft, transport, check, predictionInput);
    const capture = await stageVaultCredentials(
      {
        name: draft.name,
        targetBinding: aiConnectionBinding(draft),
        fields: draft.apiKey
          ? [{ field: "apiKey", label: "AI API key", value: draft.apiKey }]
          : [],
      },
      guard.tomb,
      check,
    );
    const view = await commitAiConnection(
      draft,
      guard.tomb,
      capture.reference,
      () => assertVaultCredentials(capture, guard.tomb, check),
      previous ?? undefined,
    ).catch(async (error) => {
      await discardVaultCredentials(capture, guard.tomb, () =>
        guard.check(),
      ).catch(() => undefined);
      throw error;
    });
    if (oldCapture)
      await discardVaultCredentials(oldCapture, guard.tomb, () =>
        guard.check(),
      ).catch(() => undefined);
    const committed = savedGuard(
      view.connectionId,
      view.revision,
      view.fingerprint,
    );
    assertVaultCredentials(capture, guard.tomb, () =>
      assertCurrentOperation(guard, transport, committed),
    );
    completed = true;
    return view;
  } finally {
    guard.close(completed);
    if (completed && owner)
      aiCompletionSeams.observe?.({ phase: "operation", owner });
  }
}

/** Called by the existing hosted-inference road and the explicit model workspace. */
export async function performSavedAiInference(
  id: string,
  input: HostedModelInput,
  runtime?: Pick<HostedModelRuntime, "signal" | "assertCurrent">,
  onText?: (text: string) => void,
) {
  const port = captureAiConnectionTransport();
  const guard = await aiVaultSeams.capture();
  let completed = false;
  let owner: (() => void) | undefined;
  try {
    port.assertCurrent();
    guard.check();
    const signals = [port.signal, guard.signal];
    if (runtime) signals.push(runtime.signal);
    const transport = { ...port, signal: AbortSignal.any(signals) };
    const record = aiConnectionRecord(id);
    if (!record || !record.privateState.verification)
      throw new AiConnectionError(
        "authentication",
        "Verify the AI connection before inference.",
      );
    requireNativeKey(
      {
        family: "AI",
        // Saved protocol support is independent from the public form catalog.
        accepts: (providerId) => aiConnectionRuntimePreset(providerId) !== null,
        classification: AI_CONNECTION_CLASSIFICATION,
      },
      id,
      true,
    );
    const unchanged = savedGuard(
      id,
      record.revision,
      record.configuration.fingerprint,
    );
    const check = () =>
      assertCurrentOperation(guard, transport, unchanged, runtime);
    owner = check;
    const draft = await resolvedAiConnection(record, guard.tomb);
    check();
    const result = await inferAiConnection(
      draft,
      input,
      transport,
      check,
      onText,
    );
    check();
    completed = true;
    return result;
  } finally {
    guard.close(completed);
    if (completed && owner)
      aiCompletionSeams.observe?.({ phase: "operation", owner });
  }
}

export async function deleteAiConnection(id: string): Promise<void> {
  const guard = await aiVaultSeams.capture();
  try {
    const record = aiConnectionRecord(id);
    if (!record)
      throw new AiConnectionError(
        "configuration",
        "Saved AI connection not found.",
      );
    if (record.configuration.parameters.vault_tomb !== guard.tomb)
      throw new AiConnectionError(
        "authentication",
        "Unlock the vault that saved this AI connection.",
      );
    const check = () => {
      guard.check();
      savedGuard(id, record.revision, record.configuration.fingerprint)();
    };
    let capture: Awaited<ReturnType<typeof capturedAiCredentials>> | null =
      null;
    try {
      const held = await capturedAiCredentials(record, guard.tomb);
      await resolvedAiConnection(record, guard.tomb);
      assertVaultCredentials(held, guard.tomb, check);
      capture = held;
    } catch {
      // A missing or edited token must not prevent removing its metadata.
      check();
    }
    await removeDeviceConfigurationDurable(id, check, check);
    if (capture)
      await discardVaultCredentials(capture, guard.tomb, () =>
        guard.check(),
      ).catch(() => undefined);
  } finally {
    guard.close();
  }
}

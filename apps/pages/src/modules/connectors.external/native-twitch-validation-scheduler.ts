/** One captured, unlocked runtime validates Twitch on startup and at least hourly. */
import { subscribeDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import type { NativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import {
  type NativeTwitchValidationTarget,
  nativeTwitchValidationTargets,
  validateNativeTwitchSession,
} from "@opensesame/app-core/lib/native-twitch-session-validation.js";

const HOUR = 60 * 60_000;
const RETRY = 60_000;
export type TwitchValidationSession = {
  isUnlocked: () => boolean;
  subscribeUnlock: (listener: () => void) => () => void;
  subscribeVisible: (listener: () => void) => () => void;
};
type ValidationState = {
  transport: NativeProviderTransport;
  session: TwitchValidationSession;
  checked: Map<string, { revision: number; nextAt: number }>;
  timer: ReturnType<typeof setTimeout> | null;
  running: AbortController | null;
  stopped: boolean;
};
function pause(state: ValidationState): void {
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
  state.running?.abort();
}
function schedule(
  state: ValidationState,
  targets: NativeTwitchValidationTarget[],
): void {
  if (!targets.length) return;
  const nextAt = Math.min(
    ...targets.map((target) =>
      Math.min(
        target.expiresAt,
        state.checked.get(target.connectionId)?.nextAt ?? Date.now(),
      ),
    ),
  );
  state.timer = setTimeout(() => wake(state), Math.max(1, nextAt - Date.now()));
}
async function validateTargets(
  state: ValidationState,
  targets: NativeTwitchValidationTarget[],
  controller: AbortController,
): Promise<void> {
  for (const target of targets) {
    if (
      controller.signal.aborted ||
      state.stopped ||
      !state.session.isUnlocked()
    )
      return;
    try {
      const valid = await validateNativeTwitchSession(
        target.connectionId,
        state.transport,
        controller.signal,
      );
      if (controller.signal.aborted || state.stopped) return;
      state.checked.set(target.connectionId, {
        revision: target.revision,
        nextAt: valid
          ? Math.min(Date.now() + HOUR, valid.expiresAt)
          : Date.now() + HOUR,
      });
    } catch {
      if (controller.signal.aborted || state.stopped) return;
      // Transient network/rate-limit failures do not revoke a valid saved grant.
      state.checked.set(target.connectionId, {
        revision: target.revision,
        nextAt: Date.now() + RETRY,
      });
    }
  }
}
function currentTargets(
  state: ValidationState,
): NativeTwitchValidationTarget[] {
  const targets = nativeTwitchValidationTargets();
  const present = new Set(targets.map((target) => target.connectionId));
  for (const id of state.checked.keys())
    if (!present.has(id)) state.checked.delete(id);
  return targets;
}
function wake(state: ValidationState): void {
  if (state.stopped) return;
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
  if (!state.session.isUnlocked()) {
    pause(state);
    return;
  }
  try {
    state.transport.assertCurrent();
  } catch {
    state.stopped = true;
    pause(state);
    return;
  }
  if (state.running) return;
  const targets = currentTargets(state);
  const due = targets.filter((target) => {
    const checked = state.checked.get(target.connectionId);
    return (
      !checked ||
      checked.revision !== target.revision ||
      checked.nextAt <= Date.now()
    );
  });
  if (!due.length) {
    schedule(state, targets);
    return;
  }
  const controller = new AbortController();
  state.running = controller;
  void validateTargets(state, due, controller).finally(() => {
    if (state.running === controller) state.running = null;
    wake(state);
  });
}
export function startNativeTwitchValidation(
  transport: NativeProviderTransport,
  session: TwitchValidationSession,
): () => void {
  const state: ValidationState = {
    transport,
    session,
    checked: new Map(),
    timer: null,
    running: null,
    stopped: false,
  };
  const notify = () => wake(state);
  const releases = [
    subscribeDeviceRows(notify),
    session.subscribeUnlock(notify),
    session.subscribeVisible(notify),
  ];
  wake(state);
  return () => {
    state.stopped = true;
    pause(state);
    for (const release of releases) release();
    state.checked.clear();
  };
}

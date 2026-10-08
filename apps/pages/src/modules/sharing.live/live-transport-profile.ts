/** Sealed-profile readiness and original-owner ceilings; UI state grants no authority. */
import { captureHostAuthority } from "@opensesame/app-core/lib/live/host-authority.js";
import { transportReadiness } from "@opensesame/app-core/lib/live/transport-readiness.js";
import { TransportRefused } from "@opensesame/app-core/lib/live/transport-store.js";
import {
  type LiveTransport,
  readTransport,
  transportFileText,
} from "@opensesame/app-core/lib/live/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";

type ProfileAdmission = { epoch: number; revision: number; check: () => void };
export type ProfileReadState = {
  epoch: number;
  alive: boolean;
  admitted: ProfileAdmission | null;
};
export type TransportEdit = {
  edit: (current: LiveTransport) => LiveTransport;
  tomb: string;
  check: () => void;
  finish: () => void;
};
type ProfilePorts = {
  tomb: () => string;
  read: (tomb: string) => Promise<LiveTransport>;
  write: (
    tomb: string,
    next: LiveTransport,
    check: () => void,
  ) => Promise<void>;
};
const NOT_READ = "This vault's routes could not be read";

/** Draw the pending edits in queue order without admitting the profile for Start. */
export function pendingTransport(
  kept: LiveTransport,
  pending: readonly TransportEdit[],
): LiveTransport {
  return pending.reduce((shown, { edit }) => {
    const checked = readTransport(JSON.parse(transportFileText(edit(shown))));
    return checked.ok ? checked.transport : shown;
  }, kept);
}

export function loadTransportProfile(input: {
  state: ProfileReadState;
  pending: number;
  ports: ProfilePorts;
  waiting: () => void;
  accept: (next: LiveTransport) => void;
  refuse: (message: string) => void;
}): void {
  const { state, ports } = input;
  state.epoch += 1;
  const at = state.epoch;
  state.admitted = null;
  input.waiting();
  const readiness = transportReadiness();
  if (readiness.pending > 0 || input.pending > 0) return;
  let owner: () => void;
  let tomb: string;
  try {
    owner = captureHostAuthority(vaultStore.pinContinuation());
    tomb = ports.tomb();
  } catch {
    input.refuse(
      vaultStore.getSnapshot().status === "locked"
        ? "Unlock this vault to read its routes"
        : NOT_READ,
    );
    return;
  }
  void Promise.resolve()
    .then(() => {
      owner();
      return ports.read(tomb);
    })
    .then((next) => {
      owner();
      const now = transportReadiness();
      if (
        !state.alive ||
        at !== state.epoch ||
        now.pending > 0 ||
        now.revision !== readiness.revision
      )
        return;
      state.admitted = { epoch: at, revision: now.revision, check: owner };
      input.accept(next);
    })
    .catch((error) => {
      if (!state.alive || at !== state.epoch) return;
      input.refuse(
        error instanceof TransportRefused ? error.message : NOT_READ,
      );
    });
}

export function captureProfileConfiguration(
  state: ProfileReadState,
): () => void {
  const pinned = state.admitted;
  const verify = () => {
    const now = transportReadiness();
    if (
      !pinned ||
      !state.alive ||
      state.admitted !== pinned ||
      state.epoch !== pinned.epoch ||
      now.pending > 0 ||
      now.revision !== pinned.revision
    )
      throw new TransportRefused("Wait for this vault's configured routes");
    pinned.check();
  };
  verify();
  return verify;
}

export async function commitTransportEdit(input: {
  entry: TransportEdit;
  ports: ProfilePorts;
  accept: (next: LiveTransport) => void;
  done: () => void;
}): Promise<string | null> {
  const { entry, ports } = input;
  try {
    entry.check();
    const current = await ports.read(entry.tomb);
    entry.check();
    const checked = readTransport(
      JSON.parse(transportFileText(entry.edit(current))),
    );
    if (!checked.ok) return checked.errors[0] ?? "Refused";
    await ports.write(entry.tomb, checked.transport, entry.check);
    entry.check();
    input.accept(checked.transport);
    return null;
  } catch (error) {
    return error instanceof TransportRefused
      ? error.message
      : "This vault could not keep the change";
  } finally {
    input.done();
    entry.finish();
  }
}

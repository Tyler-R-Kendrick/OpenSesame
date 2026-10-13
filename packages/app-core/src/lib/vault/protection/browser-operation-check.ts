import type { VaultHeader } from "@opensesame/vault-core";
/** Captured browser operation identity and cancellation, never an owner issuer. */
import { originalVfsCheck } from "../../vfs-operation-check.js";
import type { TombWriteTurn } from "../../vfs-write-order.js";
import { operationHeader } from "../store-operation-check.js";
import { assertNotCanceled, assertSessionGeneration } from "./adapter.js";
import { ProtectionError } from "./errors.js";
import type { ProtectionSessionGuard } from "./session-guard.js";
export type ProtectionBrowserHost = {
  isGuestOrEphemeral(): boolean;
  getHeader(): VaultHeader | null;
  requireRawRoot(): Uint8Array;
  isUnlocked(): boolean;
  persistHeader(
    next: VaultHeader,
    check?: () => void,
    turn?: TombWriteTurn,
  ): Promise<void>;
  replaceRawVaultKey(
    next: Uint8Array,
    check?: () => void,
    turn?: TombWriteTurn,
  ): Promise<void>;
  withRootWriteTurn(
    work: (turn: TombWriteTurn) => Promise<void>,
    check?: () => void,
  ): Promise<void>;
  session: ProtectionSessionGuard;
};
function stale(message: string): never {
  throw new ProtectionError("stale_operation", message);
}
function sameRoot(actual: Uint8Array, expected: Uint8Array): boolean {
  return (
    actual.length === expected.length &&
    actual.every((byte, i) => byte === expected[i])
  );
}
function assertOriginalHost(
  original: ProtectionBrowserHost,
  current: ProtectionBrowserHost,
  captured: ProtectionBrowserHost,
): void {
  if (
    current !== original ||
    original.session !== captured.session ||
    original.getHeader !== captured.getHeader ||
    original.requireRawRoot !== captured.requireRawRoot ||
    original.persistHeader !== captured.persistHeader ||
    original.replaceRawVaultKey !== captured.replaceRawVaultKey ||
    original.withRootWriteTurn !== captured.withRootWriteTurn
  )
    stale("Original protection host changed.");
}
function captureSessionFrame(session: ProtectionSessionGuard) {
  return Object.freeze({
    generation: session.generation,
    signal: session.signal,
  });
}
function assertOriginalFrame(
  original: ProtectionBrowserHost,
  captured: ProtectionBrowserHost,
  current: ProtectionBrowserHost,
  frame: Readonly<{ generation: number; signal: AbortSignal }>,
): void {
  assertSessionGeneration(frame.generation, captured.session.generation);
  assertNotCanceled(frame.signal);
  if (captured.session.signal !== frame.signal)
    stale("Original protection signal changed.");
  assertOriginalHost(original, current, captured);
}
type RootTurnState = {
  current: TombWriteTurn | undefined;
  check: () => void;
  scope: () => void;
};
async function withOriginalRootTurn(
  original: ProtectionBrowserHost,
  withTurn: ProtectionBrowserHost["withRootWriteTurn"],
  state: RootTurnState,
  work: () => Promise<void>,
): Promise<void> {
  state.check();
  await withTurn.call(
    original,
    async (turn) => {
      state.check();
      state.current = turn;
      try {
        await work();
      } finally {
        state.current = undefined;
      }
    },
    state.scope,
  );
  state.check();
}
type HeaderEffect = Readonly<{
  original: ProtectionBrowserHost;
  persistHeader: ProtectionBrowserHost["persistHeader"];
  next: VaultHeader;
  scope: () => void;
  check: () => void;
  readHeader: () => VaultHeader | null;
  readRoot: () => Uint8Array;
  identity: { root: Uint8Array; header: string };
  turn: TombWriteTurn | undefined;
}>;
async function persistOriginalHeader(effect: HeaderEffect): Promise<void> {
  const {
    original,
    persistHeader,
    next,
    scope,
    check,
    readHeader,
    readRoot,
    identity,
    turn,
  } = effect;
  check();
  const before = identity.header;
  const writing = () => {
    scope();
    const value = operationHeader(readHeader());
    if (
      readRoot() !== identity.root ||
      (value !== before && value !== operationHeader(next))
    )
      stale("Protection header transition changed.");
  };
  try {
    await persistHeader.call(original, next, writing, turn);
  } catch (error) {
    scope();
    if (
      readRoot() === identity.root &&
      operationHeader(readHeader()) === operationHeader(next)
    )
      identity.header = operationHeader(next);
    throw error;
  }
  scope();
  identity.header = operationHeader(next);
  check();
}

export function captureBrowserOperation(
  original: ProtectionBrowserHost,
  current: () => ProtectionBrowserHost,
  canMutate: () => void,
  purpose: "mutation" | "projection" | "projection-queued",
) {
  const captured = Object.freeze({ ...original });
  const transport = originalVfsCheck();
  const frame = captureSessionFrame(captured.session);
  const { persistHeader, replaceRawVaultKey, withRootWriteTurn } = captured;
  const readRoot = captured.requireRawRoot.bind(original);
  const readHeader = captured.getHeader.bind(original);
  const identity = { root: readRoot(), header: operationHeader(readHeader()) };
  const scope = () => {
    transport();
    assertOriginalFrame(original, captured, current(), frame);
    if (purpose === "mutation") canMutate();
  };
  const check = () => {
    scope();
    if (
      readRoot() !== identity.root ||
      (purpose !== "projection-queued" &&
        operationHeader(readHeader()) !== identity.header)
    )
      stale("Original protection root or header changed.");
  };
  check();
  const rotation: RootTurnState = { check, scope, current: undefined };
  return Object.freeze({
    check,
    withRootWriteTurn: (work: () => Promise<void>) =>
      withOriginalRootTurn(original, withRootWriteTurn, rotation, work),
    getHeader: () => {
      check();
      return readHeader();
    },
    requireRawRoot: () => {
      check();
      return readRoot();
    },
    persistHeader: (next: VaultHeader) =>
      persistOriginalHeader({
        original,
        persistHeader,
        next,
        scope,
        check,
        readHeader,
        readRoot,
        identity,
        turn: rotation.current,
      }),
    replaceRawVaultKey: async (next: Uint8Array) => {
      check();
      // Store owns the exact root transition and pins it through all effect awaits.
      const replacing = () => {
        scope();
        if (
          purpose !== "projection-queued" &&
          operationHeader(readHeader()) !== identity.header
        )
          stale("Protection header changed during rotation.");
      };
      try {
        await replaceRawVaultKey.call(
          original,
          next,
          replacing,
          rotation.current,
        );
      } catch (error) {
        scope();
        const partial = readRoot();
        if (sameRoot(partial, next)) identity.root = partial;
        check();
        throw error;
      }
      scope();
      const adopted = readRoot();
      if (!sameRoot(adopted, next))
        stale("A different root replaced this operation.");
      identity.root = adopted;
      check();
    },
  });
}

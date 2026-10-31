/** Genuine code+PRF AES slots; only cleanup methods and hostile argument accessors inject faults. */
import { ownBytes } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { disposeOriginalCommandData } from "../../vault/original-command-retirement-data.js";
import { b64 } from "../crypto/slot-bytes.js";
import {
  beginEnrollmentDraft,
  commitEnrollmentDraft,
  enrollTrigger,
  runIsolatedRehearsal,
  stageTriggerInDraft,
} from "./enrollment-draft.js";
import { openTriggerSlot } from "./enrollment-seal.js";
import {
  type EnrollmentDraft,
  createEmptyEnrollmentState,
  expectFrom,
} from "./enrollment-state.js";

const nativeFill = Uint8Array.prototype.fill;
type Fixture = {
  key: Uint8Array;
  action: Uint8Array;
  payload: Uint8Array;
  prf: Uint8Array<ArrayBuffer>;
  evaluationSalt: Uint8Array<ArrayBuffer>;
  draft: EnrollmentDraft | undefined;
  observed: Uint8Array[];
  expectedFailure: ErrorOptions | undefined;
};
function baseState() {
  return {
    ...createEmptyEnrollmentState({
      vaultRef: "rehearsal-vault",
      deviceBindingRef: "rehearsal-device",
      policyRevision: 3,
      keyEpoch: 7,
      capabilities: {
        durableLocalStorage: true,
        offlineReady: true,
        userVerificationAvailable: true,
        prfAvailable: true,
      },
    }),
    ownerConsent: true,
  };
}
function request(f: Fixture) {
  return {
    code: "87461352",
    profileId: "owned-prf-profile",
    triggerKind: "prf_and_code" as const,
    credentialIdB64: "cmVoZWFyc2FsLWNyZWRlbnRpYWw=",
    expectedOrigin: "https://rehearsal.example",
    prfSaltB64: b64(f.evaluationSalt),
    prfOutput: f.prf,
    plaintext: {
      compartmentKey: f.key,
      actionCapability: f.action,
      payload: f.payload,
      presentation: "decoy",
    },
  };
}
function requiredDraft(f: Fixture): EnrollmentDraft {
  if (!f.draft) throw new Error("Actual staged slot is missing.");
  return f.draft;
}
async function cleanBytes(bytes: Uint8Array | null | undefined) {
  if (bytes) nativeFill.call(bytes, 0);
}
async function owned(work: (f: Fixture) => Promise<void>) {
  const f: Fixture = {
    key: new Uint8Array(32).fill(17),
    action: new Uint8Array([61, 62]),
    payload: new Uint8Array([71, 72, 73]),
    prf: new Uint8Array(32),
    evaluationSalt: new Uint8Array(32),
    draft: undefined,
    observed: [],
    expectedFailure: undefined,
  };
  let failure: ErrorOptions | undefined;
  try {
    const prf = ownBytes(f.prf);
    crypto.getRandomValues(prf);
    f.prf.set(prf);
    const evaluationSalt = ownBytes(f.evaluationSalt);
    crypto.getRandomValues(evaluationSalt);
    f.evaluationSalt.set(evaluationSalt);
    f.draft = await stageTriggerInDraft({
      ...request(f),
      draft: beginEnrollmentDraft(baseState()),
    });
    await work(f);
  } catch (cause) {
    failure = { cause };
  }
  const observed = f.observed.map((bytes) => () => cleanBytes(bytes));
  await disposeOriginalCommandData(failure, undefined, [
    async () => {
      vi.restoreAllMocks();
    },
    async () => {
      if (f.expectedFailure) throw f.expectedFailure.cause;
    },
    () => cleanBytes(f.key),
    () => cleanBytes(f.action),
    () => cleanBytes(f.payload),
    () => cleanBytes(f.prf),
    () => cleanBytes(f.evaluationSalt),
    () => cleanBytes(f.draft?.rehearsalPrfOutput),
    ...observed,
  ]);
}
function equalBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.length === right.length && left.every((byte, i) => byte === right[i])
  );
}
function wipeTarget(f: Fixture, bytes: Uint8Array): number {
  if (bytes === requiredDraft(f).rehearsalPrfOutput) return 3;
  if (equalBytes(bytes, f.key)) return 0;
  if (equalBytes(bytes, f.action)) return 1;
  if (equalBytes(bytes, f.payload)) return 2;
  return -1;
}
function installCleanupFaults<T>(f: Fixture, causes: readonly T[]) {
  vi.spyOn(Uint8Array.prototype, "fill").mockImplementation(function (
    this: Uint8Array,
    value: number,
    start?: number,
    end?: number,
  ) {
    const target = value === 0 ? wipeTarget(f, this) : -1;
    const result = nativeFill.call(this, value, start, end);
    if (target >= 0) {
      f.observed.push(this);
      throw causes[target];
    }
    return result;
  });
}
async function rejectedRehearsal(f: Fixture, draft: EnrollmentDraft) {
  const [settled] = await Promise.allSettled([runIsolatedRehearsal(draft)]);
  if (!settled || settled.status !== "rejected")
    throw new Error("Rehearsal unexpectedly delivered.");
  f.expectedFailure = { cause: settled.reason };
  return { cause: settled.reason };
}
async function independentCleanupRefusals(f: Fixture) {
  const opaque = Promise.resolve("opaque original cleanup refusal");
  const causes: readonly unknown[] = [undefined, opaque, -0, Number.NaN];
  installCleanupFaults(f, causes);
  const observed = await rejectedRehearsal(f, requiredDraft(f));
  const failure: unknown = observed.cause;
  if (!(failure instanceof AggregateError))
    throw new Error("Cleanup causes were not retained.");
  expect(failure.errors).toHaveLength(4);
  for (let i = 0; i < causes.length; ++i)
    expect(Object.is(failure.errors[i], causes[i])).toBe(true);
  expect(f.observed).toHaveLength(4);
  for (const bytes of f.observed)
    expect([...bytes]).toEqual(new Array(bytes.length).fill(0));
  expect(f.observed[0]).not.toBe(f.key);
  expect(f.observed[1]).not.toBe(f.action);
  expect(f.observed[2]).not.toBe(f.payload);
  expect(f.observed[3]).toBe(requiredDraft(f).rehearsalPrfOutput);
  expect(requiredDraft(f).rehearsalPassed).toBe(false);
  expect(() => commitEnrollmentDraft(requiredDraft(f))).toThrow(/rehearsal/);
  f.expectedFailure = undefined;
}
it("genuine two-input decrypted buffers attempt every cleanup and retain undefined, Promise, signed zero and NaN", () =>
  owned(independentCleanupRefusals));

function hostileOriginalState(draft: EnrollmentDraft, cause: unknown) {
  return Object.defineProperty({ ...draft }, "stateSnapshot", {
    get() {
      throw cause;
    },
  });
}
async function originalOpenerRefusal(f: Fixture, cause: unknown) {
  const draft = requiredDraft(f);
  const observed = await rejectedRehearsal(
    f,
    hostileOriginalState(draft, cause),
  );
  const failure: unknown = observed.cause;
  expect(Object.is(failure, cause)).toBe(true);
  expect(draft.rehearsalPrfOutput).toEqual(new Uint8Array(32));
  expect(f.prf).not.toEqual(new Uint8Array(32));
  expect(draft.rehearsalPassed).toBe(false);
  f.expectedFailure = undefined;
}
const originalRefusals: readonly { label: string; cause: unknown }[] = [
  { label: "undefined", cause: undefined },
  { label: "Promise", cause: Promise.resolve("original argument refusal") },
  { label: "signed zero", cause: -0 },
  { label: "NaN", cause: Number.NaN },
];
it.each(originalRefusals)(
  "preserves original %s argument refusal while wiping its actual staged PRF",
  ({ cause }) => owned((f) => originalOpenerRefusal(f, cause)),
);

async function saltRoundtrip(f: Fixture) {
  const input = request(f);
  const draft = requiredDraft(f);
  expect(draft.pending?.prfSaltB64).toBe(input.prfSaltB64);
  expect(draft.pending?.prfEnvelope?.saltB64).not.toBe(input.prfSaltB64);
  const passed = await runIsolatedRehearsal(draft);
  expect(passed.rehearsalPrfOutput).toEqual(new Uint8Array(32));
  const committed = commitEnrollmentDraft(passed);
  const staged = committed.triggers[0];
  if (!staged) throw new Error("Original commit is missing.");
  expect(staged.prfSaltB64).toBe(input.prfSaltB64);
  const automated = await enrollTrigger({ ...input, state: baseState() });
  const deferred = await enrollTrigger({
    ...input,
    code: "17328465",
    state: committed,
    profileId: "second-owned-profile",
    autoRehearse: false,
  });
  expect(automated.triggers[0]?.prfSaltB64).toBe(input.prfSaltB64);
  expect(deferred.triggers[1]?.prfSaltB64).toBe(input.prfSaltB64);
  const restored = structuredClone(automated);
  const enrolled = restored.triggers[0];
  if (!enrolled) throw new Error("Copied original slot missing.");
  expect(enrolled.prfSaltB64).toBe(input.prfSaltB64);
  const opened = await openTriggerSlot({
    enrolled,
    code: input.code,
    expect: expectFrom(restored),
    prfOutput: f.prf,
  });
  if (!opened) throw new Error("Copied two-input ciphertext did not decrypt.");
  f.observed.push(opened.compartmentKey);
  if (opened.actionCapability) f.observed.push(opened.actionCapability);
  if (opened.payload) f.observed.push(opened.payload);
  expect(opened.compartmentKey).toEqual(f.key);
  expect(opened.actionCapability).toEqual(f.action);
  expect(opened.payload).toEqual(f.payload);
}
it("retains explicit PRF evaluation salt through genuine draft, both enrollment branches and copied ciphertext", () =>
  owned(saltRoundtrip));

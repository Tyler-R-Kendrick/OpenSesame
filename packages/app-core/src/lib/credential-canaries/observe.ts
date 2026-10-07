/** Exact bounded local metadata; canary recognition never returns real authority. */
import { exclusive } from "../retired-credentials/credential-lock.js";
import {
  type ArtifactContext,
  type CanaryArtifact,
  controlledIdentifierDigest,
  parseControlledCanaryReference,
} from "./protocol.js";
import {
  type CanaryEvent,
  type CanaryPhase,
  type CanaryRegistry,
  MAX_CANARY_EVENTS,
  phaseSchema,
} from "./records.js";
import { readCanaryRegistry, writeCanaryRegistry } from "./storage.js";
export type CanaryDecision =
  | {
      kind: "canary";
      artifactId: string;
      response: "reject" | "synthetic_readonly";
    }
  | { kind: "unrecognized" };
let sink: (tomb: string, event: CanaryEvent) => Promise<void> = async (
  tomb,
  event,
) => {
  const { queueCredentialObservation } = await import(
    "../credential-observation/queue.js"
  );
  await queueCredentialObservation(tomb, event);
};
export function configureCanaryObservationSink(
  observer: (tomb: string, event: CanaryEvent) => Promise<void>,
): void {
  sink = observer;
}
async function record(
  records: CanaryRegistry,
  artifactId: string,
  context: ArtifactContext,
  phase: CanaryPhase,
  assertAuthorized: () => void = () => {},
): Promise<void> {
  const now = Date.now();
  const recent = records.events.filter(
    (e) => e.artifactId === artifactId && now - Date.parse(e.at) < 3600000,
  );
  if (
    records.events.length >= MAX_CANARY_EVENTS ||
    recent.length >= 8 ||
    recent.some((e) => e.phase === phase && now - Date.parse(e.at) < 60000)
  )
    return;
  const event: CanaryEvent = {
    v: 1,
    eventId: crypto.randomUUID(),
    vaultIdentity: context.vaultIdentity,
    artifactId,
    kind: context.kind,
    generation: context.generation,
    phase,
    at: new Date(now).toISOString(),
  };
  records.events = [...records.events, event].slice(-MAX_CANARY_EVENTS);
  await writeCanaryRegistry(records, assertAuthorized);
  try {
    await sink(records.tomb, event);
  } catch {
    /* Local evidence remains durable when optional delivery fails. */
  }
}
export function observeControlledIdentifier(input: {
  tomb: string;
  presentedId: string;
  context: ArtifactContext;
  phase: CanaryPhase;
}): Promise<CanaryDecision> {
  return exclusive(async () => {
    const phase = phaseSchema.parse(input.phase);
    const records = await readCanaryRegistry(input.tomb);
    if (input.context.vaultIdentity !== records.vaultIdentity)
      return { kind: "unrecognized" };
    const digest = await controlledIdentifierDigest(
      input.context,
      input.presentedId,
    );
    const artifact = records.artifacts.find((a) => a.digestB64 === digest);
    if (!artifact) return { kind: "unrecognized" };
    if (phase === "retired_generation_observed" && artifact.state !== "retired")
      throw new Error("This identifier has never held production authority.");
    await record(records, artifact.id, artifact.context, phase);
    return {
      kind: "canary",
      artifactId: artifact.id,
      response: artifact.state === "retired" ? "reject" : "synthetic_readonly",
    };
  });
}
export async function verifyControlledArtifact(
  tomb: string,
  artifact: CanaryArtifact,
  dispatched = false,
  assertAuthorized: () => void = () => {},
): Promise<void> {
  const records = await readCanaryRegistry(tomb, undefined, assertAuthorized);
  const digest = await controlledIdentifierDigest(
    artifact.context,
    artifact.presentedId,
  );
  assertAuthorized();
  if (
    !records.artifacts.some(
      (a) =>
        a.id === artifact.id && a.state === "bait" && a.digestB64 === digest,
    )
  )
    throw new Error("Controlled artifact unavailable.");
  if (dispatched)
    await record(
      records,
      artifact.id,
      artifact.context,
      "artifact_dispatched",
      assertAuthorized,
    );
}

/** Dispatch supplies only its trusted tomb; client context cannot select production authority. */
export function observeControlledReference(input: {
  tomb: string;
  reference: string;
  phase: CanaryPhase;
}): Promise<CanaryDecision> {
  return exclusive(async () => {
    const records = await readCanaryRegistry(input.tomb);
    const presentedId = parseControlledCanaryReference(input.reference);
    if (!presentedId) return { kind: "unrecognized" };
    const phase = phaseSchema.parse(input.phase);
    for (const artifact of records.artifacts) {
      if (
        (await controlledIdentifierDigest(artifact.context, presentedId)) !==
        artifact.digestB64
      )
        continue;
      if (
        phase === "retired_generation_observed" &&
        artifact.state !== "retired"
      )
        throw new Error("This identifier has never held production authority.");
      await record(records, artifact.id, artifact.context, phase);
      return {
        kind: "canary",
        artifactId: artifact.id,
        response:
          artifact.state === "retired" ? "reject" : "synthetic_readonly",
      };
    }
    throw new Error("Unknown controlled canary reference.");
  });
}

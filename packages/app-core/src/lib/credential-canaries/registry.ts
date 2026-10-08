/** Owner-selected controlled artifacts, separate from production authorization. */
import { kvDurability } from "../kv.js";
import { exclusive } from "../retired-credentials/credential-lock.js";
import {
  type CredentialCanaryIssuerResponse,
  validateCredentialCanaryIssuerResponse,
} from "./issuer-response.js";
import { withCredentialObservationOwner } from "./owner.js";
import {
  type ArtifactKind,
  type CanaryArtifact,
  type OwnerProof,
  artifactKindSchema,
  contextSchema,
  controlledIdentifierDigest,
  encodePresentedId,
} from "./protocol.js";
import { MAX_CONTROLLED_CANARIES } from "./records.js";
import { readCanaryRegistry, writeCanaryRegistry } from "./storage.js";
export async function createControlledCanary(
  input: OwnerProof & { kind: ArtifactKind },
): Promise<CanaryArtifact> {
  const kind = artifactKindSchema.parse(input.kind);
  return withCredentialObservationOwner(
    input,
    async (identity, assertAuthorized) => {
      const records = await readCanaryRegistry(
        input.tomb,
        identity,
        assertAuthorized,
      );
      if (records.artifacts.length >= MAX_CONTROLLED_CANARIES)
        throw new Error("Controlled canary limit reached.");
      const generation =
        Math.max(
          0,
          ...records.artifacts
            .filter((a) => a.context.kind === kind)
            .map((a) => a.context.generation),
        ) + 1;
      const context = contextSchema.parse({
        vaultIdentity: identity,
        kind,
        generation,
      });
      const presentedId = encodePresentedId(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const id = crypto.randomUUID();
      const digestB64 = await controlledIdentifierDigest(context, presentedId);
      assertAuthorized();
      records.artifacts.push({
        id,
        context,
        digestB64,
        state: "bait",
        createdAt: new Date().toISOString(),
      });
      await writeCanaryRegistry(records, assertAuthorized);
      return { id, context, presentedId };
    },
  );
}
export function listControlledCanaries(tomb: string) {
  return exclusive(async () => {
    const records = await readCanaryRegistry(tomb);
    return {
      vaultIdentity: records.vaultIdentity,
      artifacts: records.artifacts.map(
        ({ digestB64: _digest, ...artifact }) => artifact,
      ),
      events: records.events,
      durable: kvDurability() === "persistent",
    };
  });
}
export function removeControlledCanary(
  input: OwnerProof & { artifactId: string },
): Promise<void> {
  return withCredentialObservationOwner(
    input,
    async (identity, assertAuthorized) => {
      const records = await readCanaryRegistry(
        input.tomb,
        identity,
        assertAuthorized,
      );
      if (!records.artifacts.some((a) => a.id === input.artifactId))
        throw new Error("Unknown controlled canary.");
      records.artifacts = records.artifacts.filter(
        (a) => a.id !== input.artifactId,
      );
      await writeCanaryRegistry(records, assertAuthorized);
    },
  );
}
export function clearControlledCanaryEvents(input: OwnerProof): Promise<void> {
  return withCredentialObservationOwner(
    input,
    async (identity, assertAuthorized) => {
      const records = await readCanaryRegistry(
        input.tomb,
        identity,
        assertAuthorized,
      );
      records.events = [];
      await writeCanaryRegistry(records, assertAuthorized);
    },
  );
}
export interface CredentialCanaryIssuerPort {
  resolveRetiredIdentifier(
    ref: string,
    tomb: string,
  ): Promise<CredentialCanaryIssuerResponse>;
}
let issuerPort: CredentialCanaryIssuerPort | undefined;
/** Runtime installation only; the authoritative issuer verifies prior issuance/revocation. */
export function configureCredentialCanaryIssuer(
  port: CredentialCanaryIssuerPort,
): void {
  issuerPort = port;
}
export function retireIssuedIdentifier(
  input: OwnerProof & { issuerRecordRef: string },
): Promise<void> {
  return withCredentialObservationOwner(
    input,
    async (identity, assertAuthorized) => {
      if (!issuerPort)
        throw new Error("No authoritative credential issuer is configured.");
      const issued = await issuerPort.resolveRetiredIdentifier(
        input.issuerRecordRef,
        input.tomb,
      );
      assertAuthorized();
      const verified = validateCredentialCanaryIssuerResponse(
        issued,
        input.tomb,
        identity,
      );
      if (
        verified.kind === "authenticated_retired_artifact" &&
        verified.artifact.id !== input.issuerRecordRef
      )
        throw new Error("Issuer artifact reference mismatch.");
      const records = await readCanaryRegistry(
        input.tomb,
        identity,
        assertAuthorized,
      );
      const artifact = await retiredIssuerArtifact(verified);
      assertAuthorized();
      const { digestB64 } = artifact;
      if (records.artifacts.some((a) => a.digestB64 === digestB64))
        throw new Error("Identifier already enrolled.");
      if (records.artifacts.length >= MAX_CONTROLLED_CANARIES)
        throw new Error("Controlled canary limit reached.");
      if (records.artifacts.some((a) => a.id === artifact.id))
        throw new Error("Issuer artifact already enrolled.");
      assertAuthorized();
      records.artifacts.push(artifact);
      await writeCanaryRegistry(records, assertAuthorized);
    },
  );
}

async function retiredIssuerArtifact(issued: CredentialCanaryIssuerResponse) {
  if (issued.kind === "authenticated_retired_artifact") return issued.artifact;
  const digestB64 = await controlledIdentifierDigest(
    issued.context,
    issued.presentedId,
  );
  const at = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    context: issued.context,
    digestB64,
    state: "retired" as const,
    createdAt: at,
    retiredAt: at,
  };
}

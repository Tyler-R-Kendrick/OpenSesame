/**
 * Shared createControlPlane helpers for factory settlement tests.
 */

import {
  type InteractionKind,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { expect } from "vitest";
import type { ControlPlaneConfig } from "../config.js";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import {
  activateInteraction,
  enrolPasskey,
} from "./interaction-webauthn-fixture.js";
import { seedOwnedCeremony } from "./seed-ceremony-subject.js";

export type FactoryPlane = ReturnType<typeof createControlPlane>;

export function factoryPlane(
  config: Partial<ControlPlaneConfig> = {},
): FactoryPlane {
  resetInteractionLinkBudget();
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      ...config,
    },
  });
}

export async function factoryPrincipal(cp: FactoryPlane) {
  const res = await cp.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast<{ accessToken: string; principalId: string }>(
    await res.json(),
  );
}

export async function factoryInboxRef(cp: FactoryPlane, token: string) {
  const res = await cp.app.request("/v1/authorization-requests/inbox-ref", {
    headers: { authorization: `Bearer ${token}` },
  });
  return overlapCast<{ approverRef: string }>(await res.json()).approverRef;
}

export const FACTORY_DELEGATION: JsonObject = {
  type: "connection_delegation",
  actions: ["repository.read"],
  locations: ["repo:acme/catalog"],
};

let seq = 0;

export async function factoryRaise(
  cp: FactoryPlane,
  requester: { accessToken: string; principalId: string },
  approverRef: string,
  kind: InteractionKind,
  subjectId: string,
) {
  seedOwnedCeremony(cp, kind, subjectId, requester.principalId);
  return cp.app.request("/v1/interactions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requester.accessToken}`,
      "content-type": "application/json",
      "idempotency-key": `factory-${++seq}`,
    },
    body: JSON.stringify({
      kind,
      subject: { kind, subjectId },
      approverRef,
      authorizationDetails: [FACTORY_DELEGATION],
      ttlSeconds: 300,
    }),
  });
}

export async function factoryWebauthnApprove(
  cp: FactoryPlane,
  approver: { accessToken: string; principalId: string },
  ref: string,
  requestDigest: string,
) {
  await cp.app.request(`/v1/interactions/${ref}`, {
    headers: { authorization: `Bearer ${approver.accessToken}` },
  });
  const credentialId = await enrolPasskey(cp, approver.principalId);
  const activationId = await activateInteraction(
    cp,
    approver.accessToken,
    ref,
    requestDigest,
    credentialId,
  );
  return cp.app.request(`/v1/interactions/${ref}/approve`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${approver.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestDigest, activationId }),
  });
}

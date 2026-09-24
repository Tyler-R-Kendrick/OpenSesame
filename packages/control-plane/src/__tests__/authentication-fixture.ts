import { overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import type { createControlPlane } from "../create-app.js";
export async function verifiedPrincipal(
  app: ReturnType<typeof createControlPlane>["app"],
) {
  const created = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const session = overlapCast(await created.json());
  const auth = { authorization: `Bearer ${session.accessToken}` };
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": "authentication-service-principal",
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject: "authentication-service-owner",
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  const principalId: string = overlapCast(session.principalId);
  return { auth, principalId };
}

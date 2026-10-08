import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import { createControlPlane } from "../create-app.js";
import { verifiedPrincipal } from "./authentication-fixture.js";

export type Plane = ReturnType<typeof createControlPlane>;
export const ORIGIN = "http://localhost:5180";
export function request(
  plane: Plane,
  path: string,
  headers: Record<string, string>,
  method = "POST",
  body?: JsonObject,
) {
  const init: RequestInit = {
    method,
    headers: { ...headers, "content-type": "application/json" },
  };
  if (method !== "GET") init.body = JSON.stringify(body ?? {});
  return plane.app.request(path, init);
}

export async function fixture(clock?: () => Date) {
  const plane = createControlPlane({
    processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
    ...(clock ? { clock } : {}),
  });
  const owner = await verifiedPrincipal(plane.app);
  const created = await request(
    plane,
    "/v1/authentication/applications",
    owner.auth,
    "POST",
    {
      displayName: "Configured fixture",
      rpId: "localhost",
      origins: [ORIGIN],
    },
  );
  expect(created.status).toBe(201);
  const result: { application: { id: string }; apiSecret: string } =
    overlapCast(await created.json());
  const id = result.application.id;
  return {
    plane,
    owner: owner.auth,
    id,
    secret: result.apiSecret,
    backend: { authorization: `Bearer ${result.apiSecret}` },
    root: `/v1/authentication/applications/${id}`,
  };
}

// Generated integrating-backend fixture data, not a mocked registration or
// authentication verdict. These tests do not claim passkey enrollment coverage.
export async function seedUser(plane: Plane, applicationId: string) {
  const now = plane.ctx.clock();
  await plane.ctx.authenticationStores.users.put(
    {
      applicationId,
      userId: "fixture-user",
      userName: "Fixture",
      displayName: "Fixture User",
      createdAt: now,
      updatedAt: now,
    },
    [],
  );
}

export async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: code });
}

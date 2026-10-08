import { randomUUID } from "node:crypto";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import {
  type Fixture,
  headers,
} from "./authorization-signed-outcomes.test-support.js";

export type PendingRequest = {
  authReqId: string;
  requestDigest: string;
  status: string;
};
export type Owner = Fixture["approver"];
export function post(
  f: Fixture,
  suffix: string,
  body: JsonObject,
  owner: Owner = f.approver,
  id = f.request.authReqId,
) {
  return f.cp.app.request(`/v1/authorization-requests/${id}/${suffix}`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify(body),
  });
}
export async function ask(
  f: Fixture,
  overrides: JsonObject = {},
  owner: Owner = f.approver,
  requester: Owner = f.requester,
) {
  const inbox = await f.cp.app.request("/v1/authorization-requests/inbox-ref", {
    headers: headers(owner),
  });
  expect(inbox.status).toBe(200);
  const address: { approverRef: string } = overlapCast(await inbox.json());
  return f.cp.app.request("/v1/authorization-requests", {
    method: "POST",
    headers: { ...headers(requester), "idempotency-key": randomUUID() },
    body: JSON.stringify({
      approverRef: address.approverRef,
      bindingMessage: "Write to repository",
      ttlSeconds: 3600,
      authorizationDetails: [
        {
          type: "connection_delegation",
          actions: ["repository.write"],
          locations: ["repo:outcomes/catalog"],
        },
      ],
      ...overrides,
    }),
  });
}
export async function created(response: Response): Promise<PendingRequest> {
  expect(response.status).toBe(201);
  return overlapCast(await response.json());
}
export async function remainsPending(f: Fixture, request: PendingRequest) {
  expect(
    await f.cp.ctx.repos.authorizationRequests.getById(request.authReqId),
  ).toMatchObject({ status: "pending", requestDigest: request.requestDigest });
  expect(
    await f.cp.ctx.repos.approvalReceipts.getForRequest(request.authReqId),
  ).toBeNull();
}

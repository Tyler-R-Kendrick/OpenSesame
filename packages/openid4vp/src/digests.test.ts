/**
 * The three digests, at construction (finding F08).
 *
 * These assert the *shape* of the split — that the operation digest is stable
 * across the transport, that the approval digest is the caller's when it gives
 * one and the protocol digest when it does not, and that the binding entry
 * carries the approval digest so a holder can sign over it. The end-to-end
 * consequence — `boundDigest` returning the approval digest through a full
 * verification — is in `routes.test.ts`, where a real presentation exists.
 */

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { OPERATION_DIGEST_PURPOSE, operationDigest } from "./digests.js";
import {
  type AuthorizationRequestInput,
  REQUEST_BINDING_TRANSACTION_DATA_TYPE,
  buildAuthorizationRequest,
} from "./request.js";

const VCT = "https://credentials.example/pid";
const NOW = new Date("2026-08-31T12:00:00.000Z");

function directPost(
  overrides: Partial<AuthorizationRequestInput> = {},
): AuthorizationRequestInput {
  return {
    clientId: "x509_san_dns:verifier.example",
    responseMode: "direct_post",
    responseUri: "https://verifier.example/openid4vp/response",
    dcqlQuery: {
      credentials: [{ id: "pid", format: "dc+sd-jwt", vctValues: [VCT] }],
    },
    now: NOW,
    ...overrides,
  };
}

function bindingParameters(
  request: ReturnType<typeof buildAuthorizationRequest>,
): JsonObject {
  const binding = request.transactionData.find(
    (entry) => entry.type === REQUEST_BINDING_TRANSACTION_DATA_TYPE,
  );
  if (binding === undefined) throw new Error("no binding entry");
  const decoded: JsonValue = JSON.parse(
    Buffer.from(binding.encoded, "base64url").toString("utf8"),
  );
  if (!isJsonObject(decoded)) throw new Error("binding entry is not an object");
  return decoded;
}

describe("operationDigest", () => {
  it("is transport-independent: two requests for one operation share it (T-18)", () => {
    // Fresh nonce and state each time, so the protocol digests differ — but the
    // operation is the same ask, so its digest must not move.
    const first = buildAuthorizationRequest(directPost());
    const second = buildAuthorizationRequest(directPost());

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.state).not.toBe(second.state);
    expect(first.digests.protocol).not.toBe(second.digests.protocol);

    expect(first.digests.operation).toBe(second.digests.operation);
    expect(first.digests.operation).toMatch(/^sha256:[0-9a-f]{64}$/);
    // And it is not the protocol digest wearing a different name.
    expect(first.digests.operation).not.toBe(first.digests.protocol);
  });

  it("moves when the ask moves", () => {
    const base = buildAuthorizationRequest(directPost());
    const different = buildAuthorizationRequest(
      directPost({
        dcqlQuery: {
          credentials: [
            {
              id: "pid",
              format: "dc+sd-jwt",
              vctValues: ["https://credentials.example/other"],
            },
          ],
        },
      }),
    );
    expect(different.digests.operation).not.toBe(base.digests.operation);
  });

  it("digests under a stable purpose tag", () => {
    const request = buildAuthorizationRequest(directPost());
    const recomputed = operationDigest({
      dcqlQuery: {
        credentials: [
          {
            id: "pid",
            format: "dc+sd-jwt",
            meta: { vct_values: [VCT] },
          },
        ],
      },
      transactionData: [],
    });
    expect(request.digests.operation).toBe(recomputed);
    expect(OPERATION_DIGEST_PURPOSE).toBe("opensesame:openid4vp:operation:v1");
  });
});

describe("approvalDigest", () => {
  it("degrades to the protocol digest with no interaction (T-19)", () => {
    const request = buildAuthorizationRequest(directPost());
    expect(request.digests.approval).toBe(request.digests.protocol);
    // Back-compat: the top-level alias is the protocol digest.
    expect(request.requestDigest).toBe(request.digests.protocol);
    // And the binding entry echoes both.
    const parameters = bindingParameters(request);
    expect(parameters.request_digest).toBe(request.digests.protocol);
    expect(parameters.approval_binding_digest).toBe(request.digests.approval);
  });

  it("is the caller's interaction digest when one is supplied", () => {
    const approvalBindingDigest = `sha256:${"a".repeat(64)}`;
    const request = buildAuthorizationRequest(
      directPost({ approvalBindingDigest }),
    );
    expect(request.digests.approval).toBe(approvalBindingDigest);
    // Now the three are genuinely distinct: this is the case the split is for.
    expect(request.digests.approval).not.toBe(request.digests.protocol);
    expect(request.digests.approval).not.toBe(request.digests.operation);

    const parameters = bindingParameters(request);
    expect(parameters.approval_binding_digest).toBe(approvalBindingDigest);
    // The protocol digest is still bound too, so the wire request stays tied.
    expect(parameters.request_digest).toBe(request.digests.protocol);
  });

  it("leaves the operation digest untouched by the approval digest", () => {
    const withApproval = buildAuthorizationRequest(
      directPost({ approvalBindingDigest: `sha256:${"b".repeat(64)}` }),
    );
    const without = buildAuthorizationRequest(directPost());
    expect(withApproval.digests.operation).toBe(without.digests.operation);
  });
});

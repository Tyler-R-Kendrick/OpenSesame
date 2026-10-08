/** PRIVATE UNEXECUTED controls; fixtures do not claim server authentication. */
import { expect, it, vi } from "vitest";
import { approvalReview, identityApprovalTransport } from "./approvals.js";
import { identitySeams } from "./identity.js";
import {
  identityInteractionTransport,
  interactionApproval,
} from "./interactions.js";
import {
  heldResponse,
  json,
  observe,
  transition,
} from "./member-response-authority.test-support.js";
const REF = "i_AbCdEfGhIjKlMnOpQr.0123456789abcdef";
const DIGEST = "generated_original_request_digest";
const POLICY = "generated_original_policy_digest";
const ACTIVATION = "generated_bound_activation";
const ASSERTION = {
  credentialId: "generated",
  clientDataJSON: "generated",
  authenticatorData: "generated",
  signature: "generated",
};
const DETAIL = {
  id: "int_generated",
  kind: "device_authorization",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2030-01-01T00:00:00.000Z",
  requiresApprover: true,
  requestDigest: DIGEST,
  authorizationDetails: [],
};
const REQUEST = {
  authReqId: "areq_generated",
  status: "pending",
  bindingMessage: "Generated request",
  requestDigest: DIGEST,
  authorizationDetails: [],
  expiresAt: "2030-01-01T00:00:00.000Z",
  approval: {
    riskClass: "high",
    requireTransactionBoundActivation: true,
    requireComparison: false,
    required: [],
  },
};
const REQUIREMENT = {
  riskClass: "high",
  requireTransactionBoundActivation: true,
  requireComparison: false,
  required: [],
  policyDigest: POLICY,
  maximumApprovalAgeSeconds: 300,
};
type Prepared = {
  run: () => Promise<unknown>;
  phase: () => { kind: string };
  fetch: ReturnType<typeof vi.fn>;
};
async function prepare(
  kind: "interaction" | "approval",
  complete: Response,
  assert: () => Promise<typeof ASSERTION>,
): Promise<Prepared> {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => {
    if (path.endsWith("/activation/complete")) return complete;
    if (path.endsWith("/activation"))
      return json({
        activationId: ACTIVATION,
        options: { challenge: "Z2VuZXJhdGVk" },
        expiresAt: "2030-01-01T00:00:00.000Z",
        policyDigest: POLICY,
      });
    if (path.endsWith("/requirement")) return json(REQUIREMENT);
    if (path.endsWith("/approve"))
      return json(
        kind === "interaction"
          ? { ...DETAIL, status: "approved" }
          : { ...REQUEST, status: "approved" },
      );
    return json(kind === "interaction" ? DETAIL : REQUEST);
  });
  identitySeams.identityFetch = fetch;
  const authenticator = { available: () => true, assert };
  if (kind === "interaction") {
    const model = interactionApproval(REF, {
      transport: identityInteractionTransport,
      authenticator,
    });
    await model.read();
    expect(model.phase().kind).toBe("review");
    return { run: () => model.approve(), phase: model.phase, fetch };
  }
  const model = approvalReview("areq_generated", {
    transport: identityApprovalTransport,
    authenticator,
  });
  await model.load();
  expect(model.phase().kind).toBe("review");
  return {
    run: () => model.approve({ confirmed: true }),
    phase: model.phase,
    fetch,
  };
}
for (const kind of ["interaction", "approval"] as const) {
  it(`${kind} withholds held complete body and sends no successor approval after fresh recovery`, async () => {
    const body = heldResponse(
      JSON.stringify(
        kind === "interaction"
          ? { activationId: ACTIVATION, state: "activated" }
          : { activationId: ACTIVATION },
      ),
    );
    const model = await prepare(kind, body.response, async () => ASSERTION);
    const pending = observe(model.run());
    try {
      await vi.waitFor(() => expect(body.readStarted()).toBe(true), {
        timeout: 1000,
        interval: 10,
      });
      await transition("fresh");
    } finally {
      body.release();
    }
    await pending;
    expect(
      model.fetch.mock.calls.filter(([path]) => path.endsWith("/approve")),
    ).toHaveLength(0);
    expect(model.phase().kind).toBe("review");
  });
  it(`${kind} does not send an old held assertion into fresh owner activation or settlement`, async () => {
    let release = () => {};
    let started = false;
    const assertion = new Promise<typeof ASSERTION>((resolve) => {
      release = () => resolve(ASSERTION);
    });
    const model = await prepare(
      kind,
      json(
        kind === "interaction"
          ? { activationId: ACTIVATION, state: "activated" }
          : { activationId: ACTIVATION },
      ),
      () => {
        started = true;
        return assertion;
      },
    );
    const pending = observe(model.run());
    try {
      await vi.waitFor(() => expect(started).toBe(true), {
        timeout: 1000,
        interval: 10,
      });
      await transition("fresh");
    } finally {
      release();
    }
    await pending;
    expect(
      model.fetch.mock.calls.filter(([path]) =>
        path.endsWith("/activation/complete"),
      ),
    ).toHaveLength(0);
    expect(
      model.fetch.mock.calls.filter(([path]) => path.endsWith("/approve")),
    ).toHaveLength(0);
    expect(model.phase().kind).toBe("review");
  });
  it(`${kind} preserves original-owner activation and exact decision binding`, async () => {
    const model = await prepare(
      kind,
      json(
        kind === "interaction"
          ? { activationId: ACTIVATION, state: "activated" }
          : { activationId: ACTIVATION },
      ),
      async () => ASSERTION,
    );
    const result = await model.run();
    expect(result).toMatchObject({ phase: { kind: "done" } });
    const calls = model.fetch.mock.calls.filter(([path]) =>
      path.endsWith("/approve"),
    );
    expect(calls).toHaveLength(1);
    // Check the actual RPC body rather than merely a done-state label.
    const init = model.fetch.mock.calls.find(([path]) =>
      path.endsWith("/approve"),
    )?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      requestDigest: DIGEST,
      activationId: ACTIVATION,
    });
  });
}

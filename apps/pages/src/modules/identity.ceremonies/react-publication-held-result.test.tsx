import {
  type Host,
  composeHost,
  configureHost,
  host,
} from "@opensesame/app-core/host.js";
import type { ApprovalStep } from "@opensesame/app-core/lib/approvals-route.js";
import {
  APPROVAL_NOTICE,
  reportApproval,
} from "@opensesame/app-core/lib/approvals-route.js";
import * as approvalApi from "@opensesame/app-core/lib/approvals.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import type { InteractionStep } from "@opensesame/app-core/lib/interactions-route.js";
import {
  INTERACTION_NOTICE,
  reportInteraction,
} from "@opensesame/app-core/lib/interactions-route.js";
import * as interactionApi from "@opensesame/app-core/lib/interactions.js";
import { transition } from "@opensesame/app-core/lib/member-response-authority.test-support.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { overlapCast } from "@opensesame/os-domain";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
/** @vitest-environment jsdom */
/** Actual default models, generated HTTP/assertion ports,
 * real encrypted retired-credential transitions. No hosted/WebAuthn hardware claim. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AREQ,
  DIGEST,
  REF,
  ceremonyServer,
} from "./ceremony-server.test-support.js";
import { approvalHookSeams, useApprovalReview } from "./useApprovalReview.js";
import { interactionHookSeams, useInteraction } from "./useInteraction.js";

/** A barrier around a REAL returned model step, never a replacement step. */
function holdReturnedResult<T>() {
  let value: T | undefined;
  let reached = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending: Promise<T> | undefined;
  return {
    capture(work: () => Promise<T>): Promise<T> {
      pending = (async () => {
        const result = await work();
        value = result;
        reached = true;
        await gate;
        return result;
      })();
      return pending;
    },
    reached: () => reached,
    value: () => value,
    release,
    async drain(): Promise<void> {
      if (pending) await pending;
    },
  };
}

/** The normal host authenticator still parses/options-shapes this port reply. */
function credential(): Credential {
  return overlapCast({
    id: "generated_assertion",
    type: "public-key",
    rawId: new Uint8Array([1]).buffer,
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      authenticatorData: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
    },
    getClientExtensionResults: () => ({}),
  });
}
let originalHost: Host;
beforeEach(() => {
  originalHost = host();
  configureHost(
    composeHost(originalHost, {
      env: originalHost.env,
      authenticator: {
        credentials: {
          get: vi.fn(async () => credential()),
          create: vi.fn(async () => null),
        },
        publicKeyCredential: overlapCast(
          function GeneratedPublicKeyCredential() {},
        ),
      },
    }),
  );
  clearNotices();
});
afterEach(() => {
  cleanup();
  clearNotices();
  configureHost(originalHost);
  vi.restoreAllMocks();
});
const SENTINEL = "Generated current-owner status";

for (const mode of ["fresh", "current"] as const) {
  it(`interaction hook ${mode === "fresh" ? "withholds retired" : "accepts original"} actual completed model step`, async () => {
    const held = holdReturnedResult<InteractionStep | null>();
    const server = ceremonyServer();
    identitySeams.identityFetch = server.fetch;
    vi.spyOn(
      interactionApi.identityInteractionTransport,
      "anonymous",
    ).mockImplementation((path, init) => server.fetch(path, init));
    const defaultFactory = interactionHookSeams.approval;
    const actualFactory = interactionApi.interactionApproval;
    vi.spyOn(interactionApi, "interactionApproval").mockImplementation(
      (ref, binding) => {
        const model = actualFactory(ref, binding);
        const actualApprove = model.approve;
        return { ...model, approve: () => held.capture(actualApprove) };
      },
    );
    // Do NOT replace the hook factory seam: originalDefault must remain true.
    expect(interactionHookSeams.approval).toBe(defaultFactory);
    const view = renderHook(() => useInteraction(REF));
    try {
      await waitFor(() =>
        expect(view.result.current.step.phase.kind).toBe("review"),
      );
      const shown = view.result.current.step;
      act(() => view.result.current.approve());
      await waitFor(() => expect(held.reached()).toBe(true));
      expect(held.value()).toMatchObject({
        phase: { kind: "done", outcome: "approved" },
      });
      expect(
        server.calls.find((call) => call.path.endsWith("/approve"))?.body,
      ).toEqual({ requestDigest: DIGEST, activationId: "act_1" });
      await act(async () => {
        if (mode === "fresh") await transition("fresh");
        reportInteraction(SENTINEL);
        held.release();
        await held.drain();
      });
      if (mode === "fresh") {
        expect(view.result.current.step).toBe(shown);
        expect(view.result.current.step.phase.kind).toBe("review");
        expect(
          listNotices().some(
            (notice) =>
              notice.id === INTERACTION_NOTICE && notice.body === SENTINEL,
          ),
        ).toBe(true);
      } else {
        expect(view.result.current.step).toBe(held.value());
        expect(view.result.current.step.phase.kind).toBe("done");
        expect(
          listNotices().some((notice) => notice.id === INTERACTION_NOTICE),
        ).toBe(false);
      }
      expect(interactionHookSeams.approval).toBe(defaultFactory);
    } finally {
      held.release();
      await act(async () => {
        await held.drain();
      });
      view.unmount();
    }
  });
  it(`approval hook ${mode === "fresh" ? "withholds retired" : "accepts original"} actual completed model step`, async () => {
    const held = holdReturnedResult<ApprovalStep | null>();
    const server = ceremonyServer();
    identitySeams.identityFetch = server.fetch;
    const defaultFactory = approvalHookSeams.review;
    const actualFactory = approvalApi.approvalReview;
    vi.spyOn(approvalApi, "approvalReview").mockImplementation(
      (ref, binding) => {
        const model = actualFactory(ref, binding);
        const actualApprove = model.approve;
        return {
          ...model,
          approve: (input) => held.capture(() => actualApprove(input)),
        };
      },
    );
    expect(approvalHookSeams.review).toBe(defaultFactory);
    const view = renderHook(() => useApprovalReview(AREQ));
    try {
      await waitFor(() =>
        expect(view.result.current.step.phase.kind).toBe("review"),
      );
      const shown = view.result.current.step;
      act(() =>
        view.result.current.approve({ confirmed: true, comparison: "123456" }),
      );
      await waitFor(() => expect(held.reached()).toBe(true));
      expect(held.value()).toMatchObject({
        phase: { kind: "done", ending: { kind: "approved" } },
      });
      expect(
        server.calls.find((call) => call.path.endsWith("/approve"))?.body,
      ).toEqual({
        requestDigest: DIGEST,
        activationId: "act_1",
        comparisonValue: "123456",
      });
      await act(async () => {
        if (mode === "fresh") await transition("fresh");
        reportApproval(SENTINEL);
        held.release();
        await held.drain();
      });
      if (mode === "fresh") {
        expect(view.result.current.step).toBe(shown);
        expect(view.result.current.step.phase.kind).toBe("review");
        expect(
          listNotices().some(
            (notice) =>
              notice.id === APPROVAL_NOTICE && notice.body === SENTINEL,
          ),
        ).toBe(true);
      } else {
        expect(view.result.current.step).toBe(held.value());
        expect(view.result.current.step.phase.kind).toBe("done");
        expect(
          listNotices().some((notice) => notice.id === APPROVAL_NOTICE),
        ).toBe(false);
      }
      expect(approvalHookSeams.review).toBe(defaultFactory);
    } finally {
      held.release();
      await act(async () => {
        await held.drain();
      });
      view.unmount();
    }
  });
}

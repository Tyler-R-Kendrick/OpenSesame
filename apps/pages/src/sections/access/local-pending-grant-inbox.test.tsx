import type { PendingShare } from "@opensesame/app-core/lib/local-share-grants-approvals.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingGrantDecision } from "./local-pending-grant-inbox.js";

const pending: PendingShare = {
  id: "pending_1",
  principalId: "prn_1",
  resourceKind: "vault",
  resourceId: "personal",
  resourceLabel: "Personal vault",
  policy: "open",
  durationSeconds: 3600,
  requestedAt: Date.now(),
};

describe("PendingGrantDecision controls", () => {
  afterEach(() => cleanup());

  it("uses distinct icons for deny and close", () => {
    render(
      <PendingGrantDecision
        tomb="tomb.test"
        pending={pending}
        directory={{ version: 2, revision: 1, entries: [], memberships: [] }}
        busy={false}
        run={async () => true}
        close={vi.fn()}
      />,
    );
    const deny = screen.getByRole("button", { name: "Deny prn_1" });
    const close = screen.getByRole("button", { name: "Close grant request" });
    expect(deny.querySelector("svg")).not.toEqual(close.querySelector("svg"));
  });
});

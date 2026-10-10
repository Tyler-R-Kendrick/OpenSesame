/** @vitest-environment jsdom */
import type { LocalShare } from "@opensesame/app-core/lib/local-share-grants.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareRow } from "./ShareDetail.js";

const share: LocalShare = {
  id: "share_1",
  principalId: "prn_1",
  resourceKind: "vault",
  resourceId: "personal",
  resourceLabel: "Personal vault",
  policy: "open",
  expiresAt: "2099-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};

describe("ShareRow revoke", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("arms on first press, disarms on blur, revokes on second press", async () => {
    const onRevoke = vi.fn();
    render(
      <ShareRow
        share={share}
        name="Ada"
        role="member"
        busy={false}
        canRevoke
        onRevoke={onRevoke}
      />,
    );
    const key = screen.getByRole("button", { name: "Revoke" });
    await userEvent.click(key);
    expect(key.className).toContain("is-armed");
    expect(onRevoke).not.toHaveBeenCalled();
    fireEvent.blur(key);
    expect(key.className).not.toContain("is-armed");
    await userEvent.click(key);
    await userEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(onRevoke).toHaveBeenCalledOnce();
  });
});

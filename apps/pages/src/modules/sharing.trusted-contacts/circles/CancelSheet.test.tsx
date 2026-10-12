/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  armedCircle,
  who,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  approveRequest,
  askStatus,
  askToShare,
  noteCancellation,
  readRequest,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deskOf,
  fieldValue,
  isDisabled,
} from "../trusted-contacts.test-support.js";
import { CancelSheet } from "./CancelSheet.js";
import { recordCopies, sheetKey } from "./circles.test-support.js";

let restore: () => void = () => undefined;
let copies: string[] = [];

beforeEach(() => {
  const recorded = recordCopies();
  copies = recorded.copies;
  restore = recorded.restore;
});

afterEach(() => {
  cleanup();
  restore();
  clearNotices();
});

const grant = {
  principalId: "local_5f5a5c1e-0000-4000-8000-000000000001",
  resourceKind: "item" as const,
  resourceId: "bank-login",
  resourceLabel: "Bank login",
  policy: "read",
  durationSeconds: 3600,
};

async function open() {
  const armed = await armedCircle(new Clock(), { recovers: false });
  const asked = await askToShare(armed.owner, armed.circleId, grant);
  const user = userEvent.setup();
  render(
    <CancelSheet
      desk={await deskOf(armed.owner)}
      circleId={armed.circleId}
      onClose={() => undefined}
    />,
  );
  return { armed, asked, user };
}

describe("cancelling a request", () => {
  it("signs a cancellation for the request pasted, shows it to hand on, and a contact who hears of it will not approve", async () => {
    const { armed, asked, user } = await open();
    expect(
      screen.getByRole("dialog", { name: "Cancel a request" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(sheetKey("Close"));
    expect(isDisabled(sheetKey("Sign the cancellation"))).toBe(true);

    await user.click(screen.getByLabelText("The request to cancel"));
    await user.paste(asked.packet);
    await user.click(sheetKey("Sign the cancellation"));
    await user.click(
      await screen.findByRole("button", { name: "Copy cancellation" }),
    );
    const cancellation = copies.at(-1) ?? "";
    expect(cancellation.startsWith("osq1.cancellation.")).toBe(true);
    expect(screen.getByText("Cancellation signed")).toBeTruthy();
    expect(fieldValue(screen.getByLabelText("The request to cancel"))).toBe("");

    // The ledger on this device knows, and so does a contact's once they have it.
    expect((await askStatus(armed.owner, asked.digest)).status.state).toBe(
      "cancelled",
    );
    const ada = who(armed, "Ada");
    await noteCancellation(ada, cancellation);
    expect((await readRequest(ada, asked.packet)).phase).toBe("cancelled");
    await expect(approveRequest(ada, asked.packet)).rejects.toBeTruthy();
    expect(listNotices()).toEqual([]);
  });

  it("will not take what is not a request, and says so without a notice", async () => {
    const { armed, asked, user } = await open();
    const approval = await approveRequest(who(armed, "Ada"), asked.packet);
    await user.click(screen.getByLabelText("The request to cancel"));
    await user.paste(approval);
    expect(
      await screen.findByRole("img", {
        name: "This is an approval, not a request.",
      }),
    ).toBeTruthy();
    expect(isDisabled(sheetKey("Sign the cancellation"))).toBe(true);
    expect(listNotices()).toEqual([]);
  });

  it("refuses another circle's request on the field and in the tray, and signs nothing", async () => {
    const { user } = await open();
    const other = await armedCircle(new Clock(), { recovers: false });
    const strange = await askToShare(other.owner, other.circleId, grant);
    await user.click(screen.getByLabelText("The request to cancel"));
    await user.paste(strange.packet);
    await user.click(sheetKey("Sign the cancellation"));
    await waitFor(() =>
      expect(
        listNotices().some((n) => n.id === "trusted-contacts:tcc-cancel"),
      ).toBe(true),
    );
    expect(
      within(screen.getByRole("dialog")).queryByRole("button", {
        name: "Copy cancellation",
      }),
    ).toBeNull();
    expect(fieldValue(screen.getByLabelText("The request to cancel"))).toBe(
      strange.packet,
    );
  });
});

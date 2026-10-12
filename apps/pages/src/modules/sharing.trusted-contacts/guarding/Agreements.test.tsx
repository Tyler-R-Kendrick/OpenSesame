/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  type Device,
  device,
  oneGroup,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  DEFAULT_TIMING,
  DeskError,
  acceptGuardian,
  acceptInvitation,
  beginCircle,
  createFromDraft,
  listAgreements,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { PAYLOAD } from "@opensesame/app-core/lib/quorum/world.test-support.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuardingPanel } from "../GuardingPanel.js";
import { declareTargets, serveDesk } from "../trusted-contacts.test-support.js";
import type { Desk } from "../use-desk.js";
import {
  WAITING,
  agreedGuardian,
  captureCopies,
  invitation,
  liveDesk,
  receivingKeyOf,
  restoreCopies,
} from "./guarding.test-support.js";

let undeclare: () => void;
let unserve: () => void = () => undefined;
let copied: string[];

beforeEach(() => {
  undeclare = declareTargets();
  copied = captureCopies();
});

afterEach(() => {
  cleanup();
  unserve();
  undeclare();
  clearNotices();
  restoreCopies();
});

function serve(desk: Desk) {
  unserve();
  unserve = serveDesk(desk);
}

const SLOW = { timeout: 5000 };

/** A guardian who has agreed to Family's invitation and been answered by nobody, shown to the panel. */
async function waiting() {
  const agreed = await agreedGuardian();
  serve(await liveDesk(agreed.guardian));
  return agreed;
}

describe("an invitation agreed to and not yet answered", () => {
  it("is a row of its own: the circle, the owner's key, a waiting mark and one key to forget it", async () => {
    const { guardian } = await waiting();
    render(<GuardingPanel />);
    const row = (
      await screen.findByRole("heading", { level: 3, name: "Family" })
    ).closest("li");
    if (!row) throw new Error("no row");
    const [agreement] = await listAgreements(guardian);
    expect(row.textContent).toContain(
      `Invited by ${agreement?.ownerFingerprint}`,
    );
    const inside = within(row);
    expect(inside.getByRole("img", { name: WAITING })).toBeTruthy();
    expect(
      inside
        .getAllByRole("button")
        .map((key) => key.getAttribute("aria-label")),
    ).toEqual(["Forget the invitation to Family"]);
    // It is a circle waiting, not one held: no empty mark, no keys for a request or to leave.
    expect(
      screen.queryByRole("img", { name: "Nothing held for anyone yet." }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Answer a request for/ }),
    ).toBeNull();
    // The receiving key stays in the sealed store.
    const secret = await receivingKeyOf(guardian);
    expect(document.body.innerHTML).not.toContain(secret);
  });

  it("appears when the invitation is accepted in the sheet, and goes when the welcome is taken", async () => {
    const clock = new Clock();
    const owner = device(clock);
    const { draft, invite } = await beginCircle(owner, {
      label: "Family",
      collection: "Emergency",
      recovers: true,
    });
    const ada = device(clock);
    serve(await liveDesk(ada));
    render(<GuardingPanel />);
    const user = userEvent.setup();
    expect(
      screen.getByRole("img", { name: "Nothing held for anyone yet." }),
    ).toBeTruthy();

    // Accept: paste, read, name, Enter.
    await user.click(
      screen.getByRole("button", { name: "Accept an invitation" }),
    );
    await user.click(await screen.findByLabelText("An invitation"));
    await user.paste(invite);
    await user.click(
      screen.getByRole("button", { name: "Read this invitation" }),
    );
    await user.click(await screen.findByLabelText("Your name"));
    await user.keyboard("Ada{Enter}");
    await user.click(
      await screen.findByRole("button", { name: "Copy your answer" }, SLOW),
    );
    await waitFor(() => expect(copied).toHaveLength(1));
    // The row is already there behind the sheet, and the empty mark is gone.
    expect(await screen.findByRole("img", { name: WAITING })).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: "Nothing held for anyone yet." }),
    ).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The owner answers: two others agree, the circle is made, a welcome goes to Ada.
    const enrollments: [string, string][] = [["Ada", copied[0] ?? ""]];
    for (const name of ["Ben", "Cy"]) {
      const { enrollment } = await acceptInvitation(device(clock), {
        packet: invite,
        name,
        keyLabels: ["Security key"],
      });
      enrollments.push([name, enrollment]);
    }
    const ids: string[] = [];
    for (const [name, packet] of enrollments) {
      const guardian = await acceptGuardian(owner, draft.circleId, {
        packet,
        custodyDomain: `home-${name}`,
        contactRef: null,
      });
      ids.push(guardian.id);
    }
    const dealt = await createFromDraft(owner, draft.circleId, {
      rule: oneGroup(ids, 2),
      timing: DEFAULT_TIMING,
      payload: PAYLOAD,
    });
    const welcome = dealt.welcomes.find((one) => one.name === "Ada");
    if (!welcome) throw new Error("no welcome for Ada");

    await user.click(
      screen.getByRole("button", { name: "Take what an owner sent" }),
    );
    await user.click(await screen.findByLabelText("What an owner sent"));
    await user.paste(welcome.packet);
    await user.click(
      screen.getByRole("button", { name: "Take what was sent" }),
    );
    await screen.findByRole("img", { name: "Share taken" }, SLOW);

    // The agreement is answered: its row is gone and the circle is held.
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: WAITING })).toBeNull(),
    );
    expect(
      screen.getAllByRole("heading", { level: 3, name: "Family" }),
    ).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Holds a share" })).toBeTruthy();
    expect(await listAgreements(ada)).toEqual([]);
  });

  it("is read again when the records change, as a taken welcome changes them", async () => {
    const clock = new Clock();
    const { invite } = await invitation(clock);
    const guardian = device(clock);
    const desk = await liveDesk(guardian);
    serve(desk);
    const { rerender } = render(<GuardingPanel />);
    expect(screen.queryByRole("img", { name: WAITING })).toBeNull();

    await acceptInvitation(guardian, {
      packet: invite,
      name: "Ada",
      keyLabels: ["Security key"],
    });
    // Nothing told the panel; the records it lists are a new list.
    serve({ ...desk, held: [...desk.held] });
    rerender(<GuardingPanel />);
    expect(await screen.findByRole("img", { name: WAITING })).toBeTruthy();
  });
});

describe("a list of invitations that cannot be read", () => {
  it("is a mark on the panel and a notice, and the panel does not claim to be empty", async () => {
    const clock = new Clock();
    const guardian = device(clock);
    const broken: Device = {
      ...guardian,
      pending: {
        ...guardian.pending,
        list: async () => {
          throw new DeskError("sealed", "the invitations are sealed");
        },
      },
    };
    serve(await liveDesk(broken));
    render(<GuardingPanel />);
    await screen.findByRole("img", { name: "The invitations are sealed." });
    expect(
      screen.queryByRole("img", { name: "Nothing held for anyone yet." }),
    ).toBeNull();
    const notice = listNotices().find(
      (one) => one.id === "trusted-contacts:agreements",
    );
    expect(notice?.title).toBe("Guarding");
    expect(document.body.textContent).not.toContain("sealed");
  });
});

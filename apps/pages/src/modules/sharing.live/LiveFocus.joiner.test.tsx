/** @vitest-environment jsdom */
import {
  currentGuest,
  currentHost,
  endHosting,
} from "@opensesame/app-core/lib/live/session.js";
import { webRtc } from "@opensesame/app-core/lib/live/webrtc.js";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  asked,
  enter,
  hosted,
  installLiveFocusTests,
  landsOn,
  openJoin,
  pairedJoiner,
  press,
  submit,
  type,
} from "./live-focus-test-support.js";
import { liveUiSeams } from "./live-hooks.js";

installLiveFocusTests();

describe("the keyboard after the joiner's swaps", () => {
  it("lands on the request code's copy key after asking", async () => {
    const { session } = await hosted();
    const joiner = openJoin();
    type(joiner.getByLabelText("Code"), session?.code ?? "");
    type(joiner.getByLabelText("Your name"), "Ada");
    enter(joiner.getByLabelText("Your name"));
    const copy = await joiner.findByRole("button", {
      name: "Copy your request code",
    });
    await landsOn(copy);
  });

  it("does not move a mouse user's focus when asking", async () => {
    const { session } = await hosted();
    const joiner = openJoin();
    type(joiner.getByLabelText("Code"), session?.code ?? "");
    type(joiner.getByLabelText("Your name"), "Ada");
    const close = joiner.getByRole("button", { name: "Close" });
    act(() => close.focus());
    submit(joiner.getByLabelText("Your name"));
    await joiner.findByRole("button", { name: "Copy your request code" });
    await landsOn(close);
  });

  it("lands on the joined status after Connect, so the next Tab is the first shared field", async () => {
    const { panel, session } = await hosted();
    const joiner = openJoin();
    const request = await asked(joiner, session?.code ?? "");
    type(panel.getByLabelText("A request code"), request);
    enter(panel.getByLabelText("A request code"));
    press(await panel.findByRole("button", { name: "Let Ada in" }));
    await panel.findByRole("button", { name: "Copy the reply code for Ada" });
    const reply = currentHost()?.state.guests[0]?.reply ?? "";
    const field = joiner.getByLabelText("The owner's reply code");
    type(field, reply);
    enter(field);
    await joiner.findByRole("img", { name: "Joined Team" });
    const status = joiner.getByRole("img", { name: "Joined Team" });
    await landsOn(status.closest(".live-status"));
    expect(document.body.contains(document.activeElement)).toBe(true);
  });

  it("returns to the reply field, error and all, after a wrong reply", async () => {
    const { session } = await hosted();
    const joiner = openJoin();
    await asked(joiner, session?.code ?? "");
    const guest = currentGuest();
    const accept = guest?.accept.bind(guest);
    if (guest && accept)
      guest.accept = async (reply) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return accept(reply);
      };
    const field = joiner.getByLabelText("The owner's reply code");
    type(field, "osl-reply.nope.nope");
    enter(field);
    await joiner.findByRole("img", {
      name: "That reply is not for this request",
    });
    await landsOn(joiner.getByLabelText("The owner's reply code"));
  });

  it("lands on Start over when the session ends under a removed control, and on the form after it", async () => {
    const joiner = await pairedJoiner("read");
    act(() =>
      joiner.getByRole("button", { name: "Copy GitHub Password" }).focus(),
    );
    act(() => endHosting());
    await joiner.findByRole("img", { name: "The session ended" });
    const again = joiner.getByRole("button", { name: "Start over" });
    await landsOn(again);
    press(again);
    await joiner.findByLabelText("Your name");
    await landsOn(joiner.getByLabelText("Code"));
  });

  it("leaves a focus the person chose when the session ends", async () => {
    const joiner = await pairedJoiner();
    const leave = joiner.getByRole("button", { name: "Leave the session" });
    act(() => leave.focus());
    act(() => endHosting());
    await joiner.findByRole("img", { name: "The session ended" });
    await landsOn(leave);
  });

  it("returns the keyboard to the form when this browser cannot make a request", async () => {
    const { session } = await hosted();
    liveUiSeams.transport = webRtc(() => {
      throw new Error("no WebRTC here");
    });
    const joiner = openJoin();
    type(joiner.getByLabelText("Code"), session?.code ?? "");
    type(joiner.getByLabelText("Your name"), "Ada");
    enter(joiner.getByLabelText("Your name"));
    await joiner.findByRole("img", {
      name: "This browser could not make a request code",
    });
    await waitFor(() => {
      const form = joiner.getByLabelText("Your name").closest("form");
      expect(form?.contains(document.activeElement)).toBe(true);
    });
  });
});

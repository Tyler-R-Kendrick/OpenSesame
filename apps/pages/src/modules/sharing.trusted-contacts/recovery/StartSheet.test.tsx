/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { device } from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  DeskError,
  type DeskPorts,
  type RecoveryView,
  listRecoveries,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { decodePacket } from "@opensesame/app-core/lib/quorum/packets.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  elementById,
  fieldValue,
  isDisabled,
} from "../trusted-contacts.test-support.js";
import type { Desk } from "../use-desk.js";
import { StartSheet } from "./StartSheet.js";
import {
  type Recovering,
  forged,
  recipientSecret,
  recovering,
} from "./recovery.test-support.js";

let env: Recovering;

beforeEach(async () => {
  env = await recovering();
});

afterEach(() => {
  cleanup();
  clearNotices();
});

async function open(ports: DeskPorts = device(env.clock)) {
  const desk: Desk = {
    ports,
    owned: [],
    held: [],
    refresh: async () => undefined,
  };
  const onStarted = vi.fn(async (_view: RecoveryView) => undefined);
  const onClose = vi.fn();
  const view = render(
    <StartSheet desk={desk} onStarted={onStarted} onClose={onClose} />,
  );
  const input = view.container.querySelector("input[type=file]");
  if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
  return { onStarted, onClose, input, ports };
}

const file = (text: string) =>
  new File([text], "family.json", { type: "application/json" });

const sendKey = () => screen.getByRole("button", { name: "Send the request" });

/** Nothing a failure said is drawn in the page: it is a mark's label and a notice. */
function drawnNowhere(sentence: string) {
  expect(document.body.textContent).not.toContain(sentence);
}

describe("Start a recovery", () => {
  it("lands the keyboard on the sheet's close key, with a file key, a name for the device and a key switched off", async () => {
    await open();
    const close = document.querySelector(".sheet__head .icon-btn");
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(
      screen.getByRole("dialog", { name: "Start a recovery" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "The recovery file" }).textContent,
    ).toBe("");
    expect(fieldValue(screen.getByLabelText("Name this device"))).toBe(
      "This device",
    );
    expect(isDisabled(sendKey())).toBe(true);
  });

  it("reads the file, says what it is from the owner's signed policy, and sends the request on Enter", async () => {
    const { input, onStarted, ports } = await open();
    const close = document.querySelector(".sheet__head .icon-btn");
    await waitFor(() => expect(document.activeElement).toBe(close));
    await userEvent.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "The recovery file" }),
    );
    await userEvent.upload(input, file(env.bundleText));
    // Facts, all from the signed policy inside the file.
    expect(await screen.findByText("Family")).toBeTruthy();
    expect(screen.getByText("Emergency")).toBeTruthy();
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getByText("Ada, Ben, Cy")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/)).toBeTruthy();
    expect(isDisabled(sendKey())).toBe(false);
    // Nothing has been kept or sent by choosing the file.
    expect(await listRecoveries(ports)).toEqual([]);

    await userEvent.tab();
    const name = screen.getByLabelText("Name this device");
    expect(document.activeElement).toBe(name);
    await userEvent.clear(name);
    await userEvent.type(name, "Spare laptop{Enter}");

    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    const view = onStarted.mock.calls[0]?.[0];
    if (!view) throw new Error("no recovery");
    expect(view.label).toBe("Family");
    const request = decodePacket(view.request);
    if (request.kind !== "request") throw new Error("not a request");
    expect(request.value.recipient.label).toBe("Spare laptop");
    const kept = await listRecoveries(ports);
    expect(kept.map((one) => one.requestId)).toEqual([view.requestId]);
  });

  it("does not draw the key this device made for the request", async () => {
    const { input, onStarted, ports } = await open();
    await userEvent.upload(input, file(env.bundleText));
    await screen.findByText("Family");
    await userEvent.click(sendKey());
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    const view = onStarted.mock.calls[0]?.[0];
    if (!view) throw new Error("no recovery");
    // The key made for the request is in the sealed store and nowhere on the page.
    const secret = await recipientSecret(ports, view.requestId);
    expect(secret.length).toBeGreaterThan(20);
    expect(document.body.innerHTML).not.toContain(secret);
  });

  it("marks a file that is not a recovery file on its key and in the tray, and takes the facts of the one before it away", async () => {
    const { input, onStarted } = await open();
    await userEvent.upload(input, file(env.bundleText));
    await screen.findByText("Family");
    await userEvent.upload(input, file('{"hello":"world"}'));
    const mark = await screen.findByRole("img", {
      name: "This is not a recovery file.",
    });
    expect(mark).toBeTruthy();
    expect(screen.queryByText("Family")).toBeNull();
    expect(screen.getByText("Recovery file")).toBeTruthy();
    expect(isDisabled(sendKey())).toBe(true);
    const notice = listNotices().find(
      (n) => n.id === "trusted-contacts:recovery-file",
    );
    expect(notice?.body).toBe("This is not a recovery file.");
    drawnNowhere("This is not a recovery file");
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("marks a file whose policy the owner did not sign, and sends nothing", async () => {
    const { input, onStarted, ports } = await open();
    await userEvent.upload(input, file(forged(env.bundleText)));
    await waitFor(() =>
      expect(
        listNotices().some((n) => n.id === "trusted-contacts:recovery-file"),
      ).toBe(true),
    );
    const notice = listNotices().find(
      (n) => n.id === "trusted-contacts:recovery-file",
    );
    expect(
      await screen.findByRole("img", { name: notice?.body ?? "none" }),
    ).toBeTruthy();
    expect(isDisabled(sendKey())).toBe(true);
    expect(await listRecoveries(ports)).toEqual([]);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("shows a request that could not be kept on the key that sent it, in the tray, and lands the keyboard back on it", async () => {
    const base = device(env.clock);
    const ports: DeskPorts = {
      ...base,
      pending: {
        ...base.pending,
        write: async () => {
          throw new DeskError("sealed", "the request could not be kept");
        },
      },
    };
    const { input, onStarted } = await open(ports);
    await userEvent.upload(input, file(env.bundleText));
    await screen.findByText("Family");
    await userEvent.click(sendKey());
    await screen.findByRole("img", { name: "The request could not be kept." });
    const notice = listNotices().find(
      (n) => n.id === "trusted-contacts:recovery-start",
    );
    expect(notice?.title).toBe("Start a recovery");
    await waitFor(() => expect(document.activeElement).toBe(sendKey()));
    drawnNowhere("could not be kept");
    expect(onStarted).not.toHaveBeenCalled();
    // An edit takes the mark and its notice away.
    await userEvent.type(screen.getByLabelText("Name this device"), "!");
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "The request could not be kept." }),
      ).toBeNull(),
    );
  });

  it("marks a name too long for the request on its field, with no notice, and will not send it", async () => {
    const { input } = await open();
    await userEvent.upload(input, file(env.bundleText));
    await screen.findByText("Family");
    const name = screen.getByLabelText("Name this device");
    await userEvent.clear(name);
    await userEvent.click(name);
    await userEvent.paste("x".repeat(121));
    await screen.findByRole("img", { name: "At most 120 characters." });
    expect(isDisabled(sendKey())).toBe(true);
    expect(listNotices()).toEqual([]);
    await userEvent.clear(name);
    expect(isDisabled(sendKey())).toBe(true);
    expect(elementById("recovery-device")).toBe(name);
  });
});

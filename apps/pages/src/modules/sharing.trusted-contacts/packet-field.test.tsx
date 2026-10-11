/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  armedCircle,
  device,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  DeskError,
  beginCircle,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { MAX_PACKET_BYTES } from "@opensesame/app-core/lib/quorum/packets.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import {
  FILE_MAX_BYTES,
  FileIn,
  PACKET_TEXT_MAX,
  PacketIn,
  PacketOut,
  downloadFile,
  fileName,
  glimpse,
} from "./packet-field.js";
import { fieldValue, isDisabled } from "./trusted-contacts.test-support.js";

const original = { ...vaultHooksSeams };
let copied: string[];

async function packets() {
  const clock = new Clock();
  const owner = device(clock);
  const { invite } = await beginCircle(owner, {
    label: "Family",
    collection: "Emergency",
    recovers: true,
  });
  const armed = await armedCircle(clock);
  const welcome = armed.dealt.welcomes[0]?.packet ?? "";
  return { invite, welcome };
}

beforeEach(() => {
  copied = [];
  Object.assign(vaultHooksSeams, {
    useCopySecret: () => async (value: string) => {
      copied.push(value);
      return "copied" as const;
    },
  });
});

afterEach(() => {
  cleanup();
  clearNotices();
  Object.assign(vaultHooksSeams, original);
});

describe("glimpse", () => {
  it("shows the head and the check of a long packet, and a short one whole", () => {
    expect(glimpse("osq1.invite.abc.123456")).toBe("osq1.invite.abc.123456");
    const long = `osq1.enrollment.${"A".repeat(300)}.0a1b2c`;
    const shown = glimpse(long);
    expect(shown.startsWith("osq1.enrollment.")).toBe(true);
    expect(shown.endsWith("…0a1b2c")).toBe(true);
    expect(shown.length).toBeLessThan(40);
  });
});

describe("PacketOut", () => {
  it("draws a single mono line and copies the whole packet, not what is drawn", async () => {
    const { invite } = await packets();
    render(
      <PacketOut
        label="Invitation"
        copyLabel="the invitation"
        packet={invite}
      />,
    );
    const drawn = screen.getByText(glimpse(invite));
    expect(drawn.className).toContain("frow__value--mono");
    expect(document.body.textContent).not.toContain(invite);
    await userEvent.click(
      screen.getByRole("button", { name: "Copy the invitation" }),
    );
    expect(copied).toEqual([invite]);
    expect(
      await screen.findByRole("button", { name: "Copied the invitation" }),
    ).toBeTruthy();
  });
});

describe("PacketIn", () => {
  function field(
    onPacket: (text: string) => Promise<void> = vi.fn(async () => {}),
  ) {
    render(
      <PacketIn
        id="tc-enroll"
        label="A contact's enrollment"
        kind="invite"
        commitLabel="Read this invitation"
        onPacket={onPacket}
        describe={(packet) =>
          packet.kind === "invite" ? `Circle ${packet.value.label}` : null
        }
      />,
    );
    return {
      onPacket,
      box: screen.getByLabelText("A contact's enrollment"),
      key: screen.getByRole("button", { name: "Read this invitation" }),
    };
  }

  it("is a labelled field with a key that waits for a packet it takes", async () => {
    const { box, key } = field();
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.getAttribute("autocomplete")).toBe("off");
    expect(box.getAttribute("autocapitalize")).toBe("off");
    expect(box.getAttribute("spellcheck")).toBe("false");
    expect(box.getAttribute("maxlength")).toBe(String(PACKET_TEXT_MAX));
    expect(isDisabled(key)).toBe(true);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("says what a paste is before anything is done with it, then acts only on the key", async () => {
    const { invite } = await packets();
    const { box, key, onPacket } = field();
    await userEvent.click(box);
    await userEvent.paste(invite);
    expect(onPacket).not.toHaveBeenCalled();
    expect(await screen.findByText("Circle Family")).toBeTruthy();
    expect(isDisabled(key)).toBe(false);
    await userEvent.click(key);
    expect(onPacket).toHaveBeenCalledWith(invite);
    await waitFor(() => expect(fieldValue(box)).toBe(""));
    expect(screen.queryByText("Circle Family")).toBeNull();
    // The keyboard lands back on the field, ready for the next one.
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it("ignores the wrapping a chat or a mail client adds", async () => {
    const { invite } = await packets();
    const { box, key } = field();
    await userEvent.click(box);
    await userEvent.paste(`${invite.slice(0, 40)}\n  ${invite.slice(40)}\n`);
    await waitFor(() => expect(isDisabled(key)).toBe(false));
  });

  it("marks a packet of the wrong kind on the field, with no notice in the tray", async () => {
    const { welcome } = await packets();
    const { box, key, onPacket } = field();
    await userEvent.click(box);
    await userEvent.paste(welcome);
    const mark = await screen.findByRole("img", {
      name: "This is a welcome, not an invite.",
    });
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(mark).toBeTruthy();
    expect(isDisabled(key)).toBe(true);
    expect(onPacket).not.toHaveBeenCalled();
    expect(listNotices()).toEqual([]);
  });

  it("says a cut-off or changed paste is, not a packet, and not text at all", async () => {
    const { invite } = await packets();
    const { box, key } = field();
    await userEvent.click(box);
    // Lost a few characters from the middle: the check no longer matches.
    await userEvent.paste(`${invite.slice(0, 60)}${invite.slice(66)}`);
    await screen.findByRole("img", {
      name: "This packet was cut off or changed on the way.",
    });
    expect(isDisabled(key)).toBe(true);
    await userEvent.clear(box);
    // Lost its tail: no longer shaped like a packet.
    await userEvent.paste(invite.slice(0, -9));
    await screen.findByRole("img", { name: "This is not a packet." });
    await userEvent.clear(box);
    await userEvent.paste("hello there");
    await screen.findByRole("img", { name: "This is not a packet." });
    expect(listNotices()).toEqual([]);
    await userEvent.clear(box);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("takes either of several kinds when asked to", async () => {
    const { invite, welcome } = await packets();
    render(
      <PacketIn
        id="tc-many"
        label="Anything from a guardian"
        kind={["welcome", "receipt"]}
        commitLabel="Use this"
        onPacket={async () => undefined}
      />,
    );
    const box = screen.getByLabelText("Anything from a guardian");
    const key = screen.getByRole("button", { name: "Use this" });
    await userEvent.click(box);
    await userEvent.paste(invite);
    await screen.findByRole("img", {
      name: "This is an invite, not a welcome or a receipt.",
    });
    await userEvent.clear(box);
    await userEvent.paste(welcome);
    await waitFor(() => expect(isDisabled(key)).toBe(false));
  });

  it("words a wrong kind naturally, however many kinds the field takes", async () => {
    const { invite, welcome } = await packets();
    render(
      <PacketIn
        id="tc-three"
        label="An answer"
        kind={["approval", "approvals", "release"]}
        commitLabel="Use this answer"
        onPacket={async () => undefined}
      />,
    );
    const box = screen.getByLabelText("An answer");
    await userEvent.click(box);
    await userEvent.paste(invite);
    await screen.findByRole("img", {
      name: "This is an invite, not an approval, an approvals list or a release.",
    });
    await userEvent.clear(box);
    await userEvent.paste(welcome);
    await screen.findByRole("img", {
      name: "This is a welcome, not an approval, an approvals list or a release.",
    });
    expect(listNotices()).toEqual([]);
  });

  it("shows a step that failed on the field and in the tray, keeps the paste, and clears both on an edit", async () => {
    const { invite } = await packets();
    const onPacket = vi.fn(async () => {
      throw new DeskError("origin", "this page is not one the circle accepts");
    });
    const { box, key } = field(onPacket);
    await userEvent.click(box);
    await userEvent.paste(invite);
    await userEvent.click(key);
    await screen.findByRole("img", {
      name: "This page is not one the circle accepts.",
    });
    expect(fieldValue(box)).toBe(invite);
    const notice = listNotices().find(
      (n) => n.id === "trusted-contacts:tc-enroll",
    );
    expect(notice?.body).toBe("This page is not one the circle accepts.");
    expect(notice?.title).toBe("A contact's enrollment");
    await userEvent.type(box, " ");
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
    expect(
      listNotices().some((n) => n.id === "trusted-contacts:tc-enroll"),
    ).toBe(false);
  });

  it("does not run twice while a step is under way", async () => {
    const { invite } = await packets();
    let release: () => void = () => undefined;
    const onPacket = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { box, key } = field(onPacket);
    await userEvent.click(box);
    await userEvent.paste(invite);
    await userEvent.click(key);
    await userEvent.click(key);
    expect(onPacket).toHaveBeenCalledTimes(1);
    expect(key.getAttribute("aria-busy")).toBe("true");
    release();
    await waitFor(() => expect(fieldValue(box)).toBe(""));
  });

  it("caps what a field will hold at a little over the largest packet", () => {
    expect(PACKET_TEXT_MAX).toBeGreaterThan(
      Math.ceil((MAX_PACKET_BYTES * 4) / 3),
    );
  });
});

describe("FileIn", () => {
  function picker(
    onText: (text: string, name: string) => Promise<void> = vi.fn(
      async () => {},
    ),
    maxBytes?: number,
  ) {
    const { container } = render(
      <FileIn
        id="tc-bundle"
        label="Choose the recovery file"
        maxBytes={maxBytes}
        onText={onText}
      />,
    );
    const input = container.querySelector("input[type=file]");
    if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
    return { onText, input };
  }

  it("is an icon key beside a hidden input that takes text files only", () => {
    const { input } = picker();
    const key = screen.getByRole("button", {
      name: "Choose the recovery file",
    });
    expect(key.className).toContain("icon-btn");
    expect(input.accept).toBe(".json,application/json");
    expect(input.tabIndex).toBe(-1);
    expect(input.className).toContain("visually-hidden");
    expect(FILE_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it("reads a chosen file once and hands on its text and name", async () => {
    const { input, onText } = picker();
    await userEvent.upload(
      input,
      new File(['{"v":1}'], "family.json", { type: "application/json" }),
    );
    await waitFor(() =>
      expect(onText).toHaveBeenCalledWith('{"v":1}', "family.json"),
    );
  });

  it("refuses a file over the cap without reading it", async () => {
    const { input, onText } = picker(undefined, 10);
    await userEvent.upload(
      input,
      new File(["x".repeat(11)], "big.json", { type: "application/json" }),
    );
    await screen.findByRole("img", { name: "That file is too large." });
    expect(onText).not.toHaveBeenCalled();
    expect(
      listNotices().some((n) => n.id === "trusted-contacts:tc-bundle"),
    ).toBe(true);
  });

  it("refuses a file that is not text", async () => {
    const { input, onText } = picker();
    await userEvent.upload(
      input,
      new File(["a\u0000b"], "photo.json", { type: "application/json" }),
    );
    await screen.findByRole("img", { name: "That file is not text." });
    expect(onText).not.toHaveBeenCalled();
  });

  it("shows a refusal from the step that read it, and clears it on the next file", async () => {
    const onText = vi
      .fn<(text: string, name: string) => Promise<void>>()
      .mockRejectedValueOnce(
        new DeskError("bundle", "this is not a recovery file"),
      )
      .mockResolvedValue(undefined);
    const { input } = picker(onText);
    await userEvent.upload(input, new File(["{}"], "a.json"));
    await screen.findByRole("img", { name: "This is not a recovery file." });
    await userEvent.upload(input, new File(["{}"], "b.json"));
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
  });
});

describe("downloadFile", () => {
  it("names the file safely and hands over one blob", () => {
    expect(fileName("Family circle: 2026/10")).toBe("Family-circle-2026-10");
    expect(fileName("../../etc")).toBe("etc");
    expect(fileName("...")).toBe("circle");

    vi.useFakeTimers();
    const url = vi.fn(() => "blob:tc");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: url, revokeObjectURL: revoke });
    const names: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        names.push(this.download);
      });
    downloadFile("Family recovery.json", "{}");
    expect(names).toEqual(["Family-recovery.json"]);
    expect(url).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:tc");
    click.mockRestore();
    vi.useRealTimers();
  });
});

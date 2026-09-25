import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_APPROVAL_NOTICE,
  DEVICE_LINK_REFUSED,
  approveDeviceEntry,
  clearDeviceApprovalNotice,
  reportRefusedDeviceLink,
} from "./device-approval.js";
import { clearNotices, listNotices } from "./notices.js";

const identityFetch = vi.hoisted(() => vi.fn());

import { identitySeams } from "./identity.js";
Object.assign(identitySeams, {
  identityFetch,
  identityBase: () => "http://127.0.0.1:8788",
});

// One view-model for `/device` and Identity › Devices (ADR 0140 plan step 7):
// the request goes through `directory.ts` → ceremony-kit, and a failure's
// words — ceremony-kit's `deviceApprovalWords` — land in the tray.

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sentBody(): string {
  const init: RequestInit = overlapCast(identityFetch.mock.calls.at(-1)?.[1]);
  return String(init.body);
}

function trayed() {
  return listNotices().find((notice) => notice.id === DEVICE_APPROVAL_NOTICE);
}

describe("device approval view-model", () => {
  beforeEach(() => {
    identityFetch.mockReset();
    clearNotices();
  });

  it("approves the entered code, upper-cased, and clears a failure", async () => {
    reportRefusedDeviceLink();
    identityFetch.mockResolvedValue(json({ ok: true, status: 200 }));
    expect(await approveDeviceEntry(" abcd-efgh ")).toEqual({
      tone: "ok",
      userCode: "ABCD-EFGH",
    });
    expect(sentBody()).toBe(JSON.stringify({ user_code: "ABCD-EFGH" }));
    expect(trayed()).toBeUndefined();
  });

  it("sends the code a pasted legacy link carries, never the link", async () => {
    identityFetch.mockResolvedValue(json({ ok: true, status: 200 }));
    await approveDeviceEntry("opensesame-mfa://approve?user_code=wxyz-1234");
    expect(sentBody()).toBe(JSON.stringify({ user_code: "WXYZ-1234" }));
  });

  it("puts the kit's words for a refusal in the tray and hands them back", async () => {
    identityFetch.mockResolvedValue(
      json({ error: "host_approval_failed" }, 404),
    );
    const result = await approveDeviceEntry("NOPE");
    const words =
      "No device is waiting on that code — check the code the device shows and try again.";
    expect(result).toEqual({ tone: "err", words });
    expect(trayed()).toMatchObject({ tone: "err", body: words });
  });

  it("words a proxy answer that says no as the Host's refusal", async () => {
    identityFetch.mockResolvedValue(json({ ok: false, status: 409 }));
    expect(await approveDeviceEntry("ABCD")).toEqual({
      tone: "err",
      words:
        "That code could not be approved — ask the device for a fresh one and try again.",
    });
  });

  it("refuses an empty entry without a request", async () => {
    const result = await approveDeviceEntry(
      "https://x.example/?user_code=ABCD&access_token=t",
    );
    expect(identityFetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      tone: "err",
      words: "Enter the user code shown on the device.",
    });
  });

  it("reports a refused link in the same place, and takes it down on request", () => {
    expect(reportRefusedDeviceLink()).toEqual({
      tone: "err",
      words: DEVICE_LINK_REFUSED,
    });
    expect(trayed()?.body).toBe(DEVICE_LINK_REFUSED);
    clearDeviceApprovalNotice();
    expect(trayed()).toBeUndefined();
  });
});

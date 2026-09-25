/**
 * Approving a device or CLI sign-in in Pages (ADR 0140 plan step 7): the one
 * view-model both the `/device` route and Identity › Devices draw.
 *
 * The request and its words are ceremony-kit's (`approveDevice`,
 * `deviceApprovalWords`), reached through `directory.ts`, which binds them to
 * the Identity transport. This module decides only what a screen shows for
 * an answer — a mark beside the code, and a failure's words in the
 * notifications tray rather than a box on the page — so the two screens
 * cannot drift into two wordings of one refusal.
 *
 * Approving grants the device a short-lived session. It transfers ownership
 * of nothing (ADR 0009): that is the claim ceremony.
 */

import { deviceApprovalWords } from "@opensesame/ceremony-kit";
import { takeDeviceArrival, userCodeFromEntry } from "./device-link.js";
import { approveDevice } from "./directory.js";
import { dismissNotice, setStatusNotice } from "./notices.js";

/** The tray notice a device approval reports through, one at a time. */
export const DEVICE_APPROVAL_NOTICE = "identity.device-approval";

const TITLE = "Device approval";

/** A link that reached the route carrying more than a user code. */
export const DEVICE_LINK_REFUSED =
  "That link carried more than a user code, so it was not used. Enter the code the device shows.";

const SOMETHING_WENT_WRONG = "The approval did not complete. Try again.";

export type DeviceApprovalResult = Readonly<
  { tone: "ok"; userCode: string } | { tone: "err"; words: string }
>;

/** The label the success mark carries. */
export const DEVICE_APPROVED = "Device approved";

function refusal(words: string): DeviceApprovalResult {
  setStatusNotice({
    id: DEVICE_APPROVAL_NOTICE,
    tone: "err",
    title: TITLE,
    body: words,
  });
  return { tone: "err", words };
}

/**
 * Approve what the person entered — a code, or a pasted legacy link that
 * carries one. A failure's words go to the tray and come back for the mark;
 * a success clears any failure still showing there.
 */
export async function approveDeviceEntry(
  entry: string,
): Promise<DeviceApprovalResult> {
  const userCode = userCodeFromEntry(entry);
  try {
    const answer = await approveDevice(userCode);
    if (!answer.ok) {
      return refusal(
        deviceApprovalWords("host_approval_failed", answer.status) ??
          SOMETHING_WENT_WRONG,
      );
    }
    dismissNotice(DEVICE_APPROVAL_NOTICE);
    // The code a link brought is spent: it is not offered again.
    takeDeviceArrival();
    return { tone: "ok", userCode };
  } catch (caught) {
    return refusal(
      caught instanceof Error ? caught.message : SOMETHING_WENT_WRONG,
    );
  }
}

/** Say that an arriving link was refused, in the same place as any failure. */
export function reportRefusedDeviceLink(): DeviceApprovalResult {
  return refusal(DEVICE_LINK_REFUSED);
}

/** Take a failure down when the person starts over. */
export function clearDeviceApprovalNotice(): void {
  dismissNotice(DEVICE_APPROVAL_NOTICE);
}

/**
 * The addresses the owner's reply names (ADR 0150 §6, amended 2026-10-24),
 * shown before this browser checks any of them. The reply is sealed by the
 * owner, which says who named them, not that this browser may probe them:
 * the person allows them, or the join goes on without them.
 */

import type {
  GuestStatus,
  LiveGuest,
} from "@opensesame/app-core/lib/live/guest.js";
import { FieldRow } from "../../components/FieldRow.js";
import { IconCheck, IconSkip } from "../../components/Icons.js";

export const ALLOW_ADDRESSES = "Allow the owner's addresses";
export const JOIN_WITHOUT_ADDRESSES = "Join without them";

export function ReplyAddresses({
  guest,
  status,
}: {
  guest: LiveGuest;
  status: Extract<GuestStatus, { at: "addresses" }>;
}) {
  return (
    <div className="setup__stack" id="live-addresses">
      {status.addresses.map((address) => (
        <FieldRow key={address} label="Owner's address">
          <span className="frow__value frow__value--mono">{address}</span>
        </FieldRow>
      ))}
      <div className="go-row">
        <button
          type="button"
          className="go"
          id="live-addresses-allow"
          aria-label={ALLOW_ADDRESSES}
          title={ALLOW_ADDRESSES}
          onClick={() => void guest.allowAddresses(true)}
        >
          <IconCheck size={18} />
        </button>
        <span className="go-verb" aria-hidden="true">
          {ALLOW_ADDRESSES}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label={JOIN_WITHOUT_ADDRESSES}
          title={JOIN_WITHOUT_ADDRESSES}
          onClick={() => void guest.allowAddresses(false)}
        >
          <IconSkip size={18} />
        </button>
      </div>
    </div>
  );
}

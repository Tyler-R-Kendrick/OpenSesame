/** Link and peer-trust fields for the live join form. */
import type { LiveLink } from "@opensesame/app-core/lib/live/link.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconShare } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export function LiveLinkField({
  pasted,
  link,
  busy,
  setPasted,
}: {
  pasted: string;
  link: LiveLink | null;
  busy: boolean;
  setPasted: (next: string) => void;
}) {
  return (
    <FieldShell
      id="live-link"
      label="Link"
      type="password"
      mono
      autoComplete="off"
      lead={<IconShare size={17} />}
      value={pasted}
      disabled={busy}
      status={
        pasted && !link ? (
          <StatusMark tone="err" label="Not a live-session link" />
        ) : null
      }
      onValueChange={setPasted}
    />
  );
}

export function PeerTrustField({
  peerTrust,
  busy,
  setPeerTrust,
}: {
  peerTrust: string;
  busy: boolean;
  setPeerTrust: (next: string) => void;
}) {
  return (
    <FieldShell
      id="live-peer-trust"
      label="Peer trust signal"
      type="password"
      mono
      autoComplete="off"
      placeholder="Optional"
      value={peerTrust}
      disabled={busy}
      onValueChange={setPeerTrust}
    />
  );
}

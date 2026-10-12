import {
  linearWebhookSecret,
  readLinearConnector,
} from "@opensesame/app-core/lib/linear-connectors.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { IconCopy } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useCopySecret } from "../../../lib/vault/hooks.js";
import { Facts, OutLink } from "./fields.js";

/** The signing secret goes to the owner's clipboard only after their explicit click. */
export function LinearWebhookSummary({
  connectorId,
  onFlash,
}: { connectorId: string; onFlash: (flash: Flash) => void }) {
  const runtime = readLinearConnector(connectorId);
  const webhook = runtime?.webhook;
  const copySecret = useCopySecret();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  if (!webhook) return null;
  if (runtime?.recovery?.phase === "cleanup")
    return (
      <section className="cx-block" aria-label="Linear webhook">
        <StatusMark
          tone="warn"
          label="Previous webhook cleanup pending in its original workspace"
        />
      </section>
    );

  async function copy() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const secret = linearWebhookSecret(connectorId);
      if (!secret || (await copySecret(secret)) !== "copied") throw new Error();
      setMessage({ tone: "ok", text: "Signing secret copied" });
      onFlash({ tone: "ok", text: "Signing secret copied" });
    } catch {
      const text =
        "Could not copy the signing secret. Check clipboard access and try again.";
      setMessage({ tone: "err", text });
      onFlash({ tone: "err", text });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="cx-block cx-form" aria-label="Linear webhook">
      <div className="panel__head">
        <h3>Linear webhook</h3>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Copy webhook signing secret"
          title="Copy webhook signing secret; configure it in your receiver and verify the Linear-Signature header before accepting events."
          disabled={busy}
          onClick={() => void copy()}
        >
          <IconCopy size={16} />
        </button>
        {message ? (
          <StatusMark tone={message.tone} label={message.text} />
        ) : null}
      </div>
      <Facts
        rows={[
          ["Registered webhook", webhook.url],
          ["Resources", webhook.resourceTypes.join(", ")],
        ]}
      />
      <OutLink href="https://linear.app/developers/webhooks">
        Linear webhook signature verification
      </OutLink>
    </section>
  );
}

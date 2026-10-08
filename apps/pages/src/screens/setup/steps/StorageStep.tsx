/**
 * Step — storage. Where the vault lives (ADR 0182): the S3-compatible bucket,
 * configured here as it is in Settings › Capabilities › Local storage — the
 * same catalog row, the same `ConnectForm`, the same device-local save with
 * the secret key sealed apart from the public fields. Nothing is chosen for
 * the person: with no bucket saved the vault stays in this browser.
 */

import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { ConnectForm } from "../../../sections/connections/ConnectForm.js";

/** The catalog row for the bucket; the one id is `spec/connectors/catalog.json`'s. */
const BUCKET_PROVIDER_ID = "s3";

const NOTICE_TONE = { ok: "info", warn: "warn", err: "err" } as const;

function tell(flash: Flash): void {
  setStatusNotice({
    id: "setup:storage",
    tone: NOTICE_TONE[flash.tone],
    title: "S3-compatible bucket",
    body: flash.text,
  });
}

export function StorageStep() {
  const provider = getBundledProviders().find(
    (row) => row.id === BUCKET_PROVIDER_ID,
  );
  if (provider === undefined) return null;
  return (
    <section className="setup__stack" aria-label={provider.displayName}>
      <ConnectForm
        provider={provider}
        online={true}
        onFlash={tell}
        onConnected={() => undefined}
      />
    </section>
  );
}

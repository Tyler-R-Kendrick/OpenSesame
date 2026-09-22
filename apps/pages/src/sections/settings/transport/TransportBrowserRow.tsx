import { useRef, useState, useSyncExternalStore } from "react";
import { IconDownload, IconUpload } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import {
  PublicPemError,
  exportPublicCertificatePem,
  heldBrowserCertificate,
  holdBrowserCertificate,
  importPublicCertificatePem,
  subscribeBrowserCertificate,
} from "../../../lib/transport-browser.js";
import type { BrowserManagedProfile } from "../../../lib/transport-settings.js";

const REFUSAL_LABEL = {
  too_large: "Larger than a certificate",
  private_material: "Carries a private key — refused whole",
  no_certificate: "No certificate in it",
  malformed: "Not a certificate",
} as const;

/**
 * The browser-managed profile row: a certificate the browser holds, custody
 * `browser_external`. Two keys, both on public bytes only — read a PEM in
 * (a private key anywhere in it refuses the whole file) and hand the same
 * public PEM back out. Nothing installs, attaches, or presents a certificate;
 * the thumbprint is what an operator binds.
 */
export function TransportBrowserRow({
  profile,
}: {
  profile: BrowserManagedProfile;
}) {
  const held = useSyncExternalStore(
    subscribeBrowserCertificate,
    heldBrowserCertificate,
    heldBrowserCertificate,
  );
  const file = useRef<HTMLInputElement>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function read(picked: File | undefined) {
    if (!picked) return;
    try {
      holdBrowserCertificate(
        await importPublicCertificatePem(await picked.text()),
      );
      setRefusal(null);
    } catch (error) {
      setRefusal(
        error instanceof PublicPemError
          ? REFUSAL_LABEL[error.reason]
          : REFUSAL_LABEL.malformed,
      );
    }
  }

  function download() {
    if (!held) return;
    const { filename, blob } = exportPublicCertificatePem(held);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className="sw sw--method transport__browser"
      data-custody="browser_external"
    >
      <div>
        <div className="sw__name">
          {profile.displayName}
          <StatusMark
            tone="idle"
            label="Held by the browser, outside this app"
          />
          {refusal ? <StatusMark tone="err" label={refusal} /> : null}
        </div>
        {held ? (
          <p className="sw__sub">
            sha256 {held.thumbprint} · chain {held.chainLength}
          </p>
        ) : null}
      </div>
      <div className="actions">
        <input
          ref={file}
          type="file"
          accept=".pem,.crt,.cer,application/x-pem-file,application/x-x509-ca-cert"
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            void read(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Import public certificate"
          title="Import public certificate"
          onClick={() => file.current?.click()}
        >
          <IconUpload size={16} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Export public certificate"
          title="Export public certificate"
          disabled={held === null}
          onClick={download}
        >
          <IconDownload size={16} />
        </button>
      </div>
    </div>
  );
}

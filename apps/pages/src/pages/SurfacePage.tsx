import { Link } from "react-router";
import { useEffect, useState } from "react";
import { createApiClient } from "@opensesame/api-client";
import { loadSettings } from "../lib/settings.js";

export function SurfacePage({ online }: { online: boolean }) {
  const [hostOk, setHostOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  async function probe() {
    if (!online) {
      setHostOk(null);
      return;
    }
    setBusy(true);
    try {
      const { hostApi } = loadSettings();
      const client = createApiClient({ baseUrl: hostApi });
      const h = await client.health();
      setHostOk(h.ok);
    } catch {
      setHostOk(false);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void probe();
  }, [online]);

  const hostLabel = !online
    ? "Host probe skipped offline"
    : hostOk === null
      ? busy
        ? "Checking Host…"
        : "Host unknown"
      : hostOk
        ? "Host reachable"
        : "Host unreachable";

  return (
    <section className="surface-descent" aria-labelledby="surface-hook">
      <p id="surface-hook" className="surface-hook">
        Descend into sealed authority — vault first, then ceremonies, then
        ceilings that only narrow. Host and Identity stay remote; this page
        never materializes secrets.
      </p>

      <div className="descent-actions">
        <Link className="button primary" to="/vault">
          Open vault
        </Link>
        <Link className="button" to="/authorize">
          Ceremonies
        </Link>
      </div>

      <p className="surface-probe" role="status" aria-live="polite">
        <span className="mono">{hostLabel}</span>
        {online ? (
          <>
            {" "}
            <button
              type="button"
              className="linkish"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void probe()}
            >
              Retry
            </button>
            {" · "}
            <Link to="/settings">Configure APIs</Link>
          </>
        ) : (
          <>
            {" · "}
            <Link to="/queue">Offline queue</Link>
          </>
        )}
      </p>
    </section>
  );
}

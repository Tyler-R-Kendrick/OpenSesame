import { IconRefresh, IconShield } from "../../../components/Icons.js";

/**
 * The panel head's keys: read status again, and — only where an endpoint is
 * set to run it — the endpoint's own probe.
 */
export function TransportHeadKeys({
  busy,
  onRefresh,
  onVerify,
}: {
  busy: boolean;
  onRefresh: () => void;
  onVerify: (() => void) | null;
}) {
  return (
    <div className="actions">
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Refresh transport status"
        title="Refresh transport status"
        disabled={busy}
        onClick={onRefresh}
      >
        <IconRefresh size={16} />
      </button>
      {onVerify ? (
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Run enforcement verification at the endpoint"
          title="Run enforcement verification at the endpoint"
          disabled={busy}
          onClick={onVerify}
        >
          <IconShield size={16} />
        </button>
      ) : null}
    </div>
  );
}

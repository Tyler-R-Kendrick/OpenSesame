import { IconAlert } from "../../components/Icons.js";
export function SecretConfigHeading({
  online,
  loading,
  projectId,
  onRefresh,
}: {
  online: boolean;
  loading: boolean;
  projectId: string;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="panel__head">
        <div>
          <h2 id="secret-configs-heading">Project configs</h2>
        </div>
        <button
          type="button"
          className="btn"
          disabled={!online || loading || !projectId.trim()}
          onClick={onRefresh}
        >
          Refresh
        </button>
      </div>
      {!online ? (
        <output className="note note--warn">
          <IconAlert /> Offline — configs require Host.
        </output>
      ) : null}
    </>
  );
}

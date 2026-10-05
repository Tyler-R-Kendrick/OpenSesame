import { EmptyTip } from "../../components/EmptyTip.js";
import { UpLink } from "../../components/UpLink.js";

/** An address for an item this vault does not hold: a stale link, a purge. */
export function ItemGone({ listPath }: { listPath: string }) {
  return (
    <div className="detail">
      <div className="empty">
        <h2>That item is not in this vault</h2>
        <EmptyTip tip="escBack" />
        <UpLink pane="list" className="btn btn--sm" to={listPath}>
          Back to the vault
        </UpLink>
      </div>
    </div>
  );
}

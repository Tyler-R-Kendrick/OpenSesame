import {
  assertNoPlaintextInSealedJson,
  createCursor,
  loadSealedStore,
  persistSealedStore,
} from "@opensesame/client-core";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import {
  IconClaim,
  IconConnection,
  IconDevice,
  IconNote,
  IconSearch,
  IconTask,
} from "../components/Icons.js";
import { track } from "../lib/telemetry.js";
import {
  type VaultItem,
  type VaultItemType,
  getVaultItem,
  loadVaultItems,
  typeLabel,
} from "../lib/vault-items.js";

const filters: Array<{ id: "all" | VaultItemType; label: string }> = [
  { id: "all", label: "All" },
  { id: "connection", label: "Connections" },
  { id: "task", label: "Tasks" },
  { id: "claim", label: "Claims" },
  { id: "device", label: "Devices" },
  { id: "note", label: "Notes" },
];

function TypeIcon({ type }: { type: VaultItemType }) {
  switch (type) {
    case "connection":
      return <IconConnection />;
    case "task":
      return <IconTask />;
    case "claim":
      return <IconClaim />;
    case "device":
      return <IconDevice />;
    case "note":
      return <IconNote />;
  }
}

export function VaultPage() {
  const { itemId } = useParams();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | VaultItemType>("all");
  const [items, setItems] = useState<VaultItem[]>([]);
  const [sealStatus, setSealStatus] = useState("Checking sealed store…");

  useEffect(() => {
    setItems(loadVaultItems());
    void (async () => {
      try {
        const cursor = createCursor("pages-device");
        const existing = await loadSealedStore(cursor.deviceId);
        const sealed =
          existing ??
          JSON.stringify({
            cursor: { device_id: cursor.deviceId, epoch: cursor.epoch },
            blobs: [],
          });
        assertNoPlaintextInSealedJson(sealed);
        await persistSealedStore(cursor.deviceId, sealed);
        setSealStatus("Sealed store ready (ciphertext only)");
      } catch (e) {
        setSealStatus(
          e instanceof Error ? e.message : "Sealed store unavailable",
        );
      }
    })();
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== "all" && item.type !== filter) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        typeLabel(item.type).toLowerCase().includes(q)
      );
    });
  }, [items, query, filter]);

  if (itemId) {
    const item = getVaultItem(itemId);
    if (!item) {
      return (
        <section className="vault-panel">
          <h1>Item not found</h1>
          <Link to="/vault">Back to vault</Link>
        </section>
      );
    }
    return <VaultItemDetail item={item} sealStatus={sealStatus} />;
  }

  return (
    <section className="vault-panel">
      <div className="vault-heading-row">
        <h1>Vault</h1>
        <output className="seal-chip">{sealStatus}</output>
      </div>
      <p className="lede tight">
        Search sealed authority items the way you would a password vault — for
        you or an agent. Secrets never appear here.
      </p>

      <div className="search-row">
        <IconSearch />
        <input
          type="search"
          placeholder="Search vault"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search vault"
        />
      </div>

      <div className="filter-row" role="toolbar" aria-label="Item type">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            className={filter === f.id ? "filter is-active" : "filter"}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <output className="empty">
          No items match. Clear search or add ceremonies under Tools.
        </output>
      ) : (
        <ul className="vault-list">
          {visible.map((item) => (
            <li key={item.id}>
              <Link className="vault-row" to={`/vault/${item.id}`}>
                <span className={`type-badge type-${item.type}`}>
                  <TypeIcon type={item.type} />
                </span>
                <span className="vault-row-text">
                  <span className="vault-row-name">
                    {item.name}
                    {item.synthetic ? (
                      <span className="synthetic-tag">synthetic</span>
                    ) : null}
                  </span>
                  <span className="vault-row-sub">{item.subtitle}</span>
                </span>
                <span className="vault-row-meta">{typeLabel(item.type)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function VaultItemDetail({
  item,
  sealStatus,
}: {
  item: VaultItem;
  sealStatus: string;
}) {
  // item.id is the actual "a different item was opened" trigger — dropping
  // it would mean navigating between two items of the same type never
  // re-fires this effect, silently under-counting item_opened. Only
  // item.type is read in the body (by design: never the item's name, id, or
  // value), but item.id must stay in the dependency list to gate re-firing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    track("item_opened", { item_type: item.type });
  }, [item.id, item.type]);

  return (
    <section className="vault-panel">
      <p className="crumb">
        <Link to="/vault">Vault</Link> / {typeLabel(item.type)}
      </p>
      <div className="detail-head">
        <span className={`type-badge large type-${item.type}`}>
          <TypeIcon type={item.type} />
        </span>
        <div>
          <h1>
            {item.name}
            {item.synthetic ? (
              <span className="synthetic-tag">synthetic</span>
            ) : null}
          </h1>
          <p className="lede tight">{item.subtitle}</p>
        </div>
      </div>

      <dl className="detail-grid">
        <div>
          <dt>Type</dt>
          <dd>{typeLabel(item.type)}</dd>
        </div>
        <div>
          <dt>Agent usable</dt>
          <dd>
            {item.agentUsable ? "Yes — visible under Agent" : "Human ceremony"}
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd className="mono">{new Date(item.updatedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Sealed store</dt>
          <dd>{sealStatus}</dd>
        </div>
      </dl>

      <div className="actions">
        {item.type === "device" ? (
          <Link className="button primary" to="/authorize">
            Authorize CLI
          </Link>
        ) : null}
        {item.type === "claim" ? (
          <Link className="button primary" to="/claim">
            Present claim
          </Link>
        ) : null}
        {item.type === "task" ? (
          <Link className="button primary" to="/task">
            Inspect task ceiling
          </Link>
        ) : null}
        {item.agentUsable ? (
          <Link className="button" to="/agent">
            Open in Agent
          </Link>
        ) : null}
        <Link className="button" to="/vault">
          Back
        </Link>
      </div>
    </section>
  );
}

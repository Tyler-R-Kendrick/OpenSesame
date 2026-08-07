import { useMemo, useState } from "react";
import { Link } from "react-router";
import { IconAgent, IconSearch } from "../components/Icons.js";
import {
  loadVaultItems,
  typeLabel,
  type VaultItem,
} from "../lib/vault-items.js";

export function AgentPage() {
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return loadVaultItems().filter((item) => {
      if (!item.agentUsable) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q)
      );
    });
  }, [query]);

  return (
    <section className="vault-panel">
      <div className="vault-heading-row">
        <h1>
          <IconAgent /> Agent
        </h1>
      </div>
      <p className="lede tight">
        Same vault, agent peer view. Agents authorize → invoke → receive receipts
        through Host — they never call <code>getSecret()</code> or read private
        proof keys from this page.
      </p>

      <div className="search-row">
        <IconSearch />
        <input
          type="search"
          placeholder="Search agent-usable items"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search agent-usable items"
        />
      </div>

      {items.length === 0 ? (
        <p className="empty" role="status">
          No agent-usable items. Connections, task grants, and sealed notes appear
          here.
        </p>
      ) : (
        <ul className="vault-list">
          {items.map((item) => (
            <AgentRow key={item.id} item={item} />
          ))}
        </ul>
      )}

      <div className="hint">
        Configure Host/Identity under Settings. Offline ceremony intents queue
        under Tools → Queue.
      </div>
    </section>
  );
}

function AgentRow({ item }: { item: VaultItem }) {
  return (
    <li>
      <div className="vault-row static">
        <span className={`type-badge type-${item.type}`} aria-hidden="true" />
        <span className="vault-row-text">
          <span className="vault-row-name">
            {item.name}
            {item.synthetic ? (
              <span className="synthetic-tag">synthetic</span>
            ) : null}
          </span>
          <span className="vault-row-sub">{item.subtitle}</span>
        </span>
        <span className="vault-row-actions">
          <span className="vault-row-meta">{typeLabel(item.type)}</span>
          <Link className="button compact" to={`/vault/${item.id}`}>
            Open
          </Link>
          {item.type === "task" ? (
            <Link className="button compact primary" to="/task">
              Inspect
            </Link>
          ) : null}
        </span>
      </div>
    </li>
  );
}

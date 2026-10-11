/**
 * Add a key: any live item of the vault can be one. Matches are the items'
 * own names, secrets first, a handful at a time, so a vault of five hundred
 * logins is searched and never listed.
 */

import type { VaultItem } from "@opensesame/vault-core";
import { useMemo, useState } from "react";

const LISTED = 6;

const rank = (item: VaultItem): number => (item.kind === "secret" ? 0 : 1);

export function KeyPicker({
  candidates,
  onPick,
}: Readonly<{
  candidates: readonly VaultItem[];
  onPick: (itemId: string) => void;
}>) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return candidates
      .filter(
        (item) => wanted === "" || item.name.toLowerCase().includes(wanted),
      )
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .slice(0, LISTED);
  }, [candidates, query]);
  if (candidates.length === 0) return null;
  return (
    <div className="env__picker">
      <input
        className="env__input"
        type="search"
        autoComplete="off"
        spellCheck={false}
        placeholder="Find an item"
        aria-label="Add a key from the vault"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="env__matches">
        {matches.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="env__choice"
              onClick={() => {
                onPick(item.id);
                setQuery("");
              }}
            >
              {item.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

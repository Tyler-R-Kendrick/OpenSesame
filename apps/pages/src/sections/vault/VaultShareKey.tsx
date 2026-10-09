import { isCommandSection } from "@opensesame/app-core/lib/command-bar/types.js";
import { Link, useLocation, useSearchParams } from "react-router";
import { IconShare } from "../../components/Icons.js";

/**
 * The vault header's Share key and the sheet it opens.
 *
 * Sharing is two roads: a standing grant to a person or an agent on the
 * local share ledger (PAM — policy and duration, revocable from Access ›
 * Grants), and, with an item in context, a temporary one-time drop. The key
 * and every menu's "Person or agent" all land on `?share=grant`, and the one
 * sheet mounted beside the vault's panes answers it — prefilled for the
 * vault, the folder, or the item it was opened from. Never a route to
 * `/claim`: that dispatcher is the recipient's side of a drop, not this
 * vault's chrome.
 */

/** The sheet answers the `share=grant` search param, whoever set it. */
export function vaultShareGrantParams(
  params: URLSearchParams,
  prefill?: { itemId?: string; folderId?: string },
): string {
  const next = new URLSearchParams(params);
  next.set("share", "grant");
  if (prefill?.folderId) next.set("folder", prefill.folderId);
  return `${next}`;
}

export { VaultShareSheet } from "./VaultShareSheet.js";

/** The path strip's Share key: opens the grant sheet for this vault. */
export function VaultShareKey() {
  const location = useLocation();
  const [params] = useSearchParams();
  // A vault-level share is a standing grant; where Access is not part of this
  // installation there is no ledger to write one to, so the key is not drawn.
  if (!isCommandSection("/access")) return null;
  return (
    <Link
      className="icon-btn icon-btn--sm"
      aria-label="Share"
      title="Share"
      aria-haspopup="dialog"
      to={`${location.pathname}?${vaultShareGrantParams(params)}`}
    >
      <IconShare size={15} />
    </Link>
  );
}

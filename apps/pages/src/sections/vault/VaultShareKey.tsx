import { isCommandSection } from "@opensesame/app-core/lib/command-bar/types.js";
import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import {
  FOLDER_TARGET_PREFIX,
  type ShareKind,
  createLocalShare,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconShare, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import { useVault } from "../../lib/vault/hooks.js";
import { ShareGrantForm } from "../access/ShareGrantForm.js";

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

const NOTICE = "vault-share";

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

type Prefill = {
  kind: ShareKind;
  resourceId?: string;
  /** Set when an item is in context: the drop road navigates to it. */
  itemId?: string;
};

function ShareSheet({
  prefill,
  onClose,
}: {
  prefill: Prefill;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);
  const { tomb } = useVault();
  const [identities, setIdentities] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [canGrant, setCanGrant] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [directory, { canAccess, resolveCurrentAccessRole }] =
          await Promise.all([
            readLocalDirectory(tomb),
            import("@opensesame/app-core/lib/local-rbac.js"),
          ]);
        if (!live) return;
        const actor = await resolveCurrentAccessRole(tomb);
        setCanGrant(canAccess(actor, "manage_grants"));
        setIdentities(
          directory.entries
            .filter(
              (entry) =>
                (entry.kind === "person" || entry.kind === "agent") &&
                entry.enabled,
            )
            .map((entry) => ({ id: entry.id, name: entry.name })),
        );
      } catch {
        if (!live) return;
        setCanGrant(false);
        setIdentities([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [tomb]);

  async function save(input: Parameters<typeof createLocalShare>[1]) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await createLocalShare(tomb, input);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not grant access.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
        role="dialog"
        aria-label="Share"
        aria-modal="true"
      >
        <div className="sheet__head">
          <span className="sheet__mark" aria-hidden="true">
            <IconShare size={20} />
          </span>
          <div className="sheet__grow">
            <h2>Share</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">
          <FailureNotice id={NOTICE} title="Share" message={error} />
          {prefill.itemId ? (
            <p>
              <Link
                className="btn choice"
                to={`/vault/${prefill.itemId}?share=drop`}
              >
                Temporary drop
              </Link>
            </p>
          ) : null}
          {canGrant === false ? (
            <StatusMark
              tone="idle"
              label="No person or agent on this device can be granted access"
            />
          ) : null}
          {canGrant ? (
            <ShareGrantForm
              identities={identities}
              busy={busy}
              initialKind={prefill.kind}
              initialResourceId={prefill.resourceId}
              onSave={(input) => void save(input)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The one share sheet of the vault section, mounted beside its panes. Open
 * while the location carries `share=grant`; the folder and item in the
 * location decide the prefill.
 */
export function VaultShareSheet() {
  const [params, setParams] = useSearchParams();
  const { itemId } = useParams();
  const { tomb } = useVault();
  if (params.get("share") !== "grant") return null;
  const folderId = params.get("folder");
  const prefill: Prefill = folderId
    ? { kind: "item", resourceId: `${FOLDER_TARGET_PREFIX}${folderId}` }
    : itemId
      ? { kind: "item", resourceId: itemId, itemId }
      : { kind: "vault", resourceId: tomb };
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("share");
    setParams(next, { replace: true });
  };
  return <ShareSheet prefill={prefill} onClose={close} />;
}

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

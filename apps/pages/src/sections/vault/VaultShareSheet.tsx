import {
  FOLDER_TARGET_PREFIX,
  type ShareKind,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { useRef } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconShare, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import { useVault } from "../../lib/vault/hooks.js";
import { ShareGrantForm } from "./ShareGrantForm.js";
import { useVaultShareSheet } from "./use-vault-share-sheet.js";

const NOTICE = "vault-share";

type Prefill = {
  kind: ShareKind;
  resourceId?: string;
  itemId?: string;
};

function ShareSheetBody({
  prefill,
  onClose,
}: {
  prefill: Prefill;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);
  const { identities, canGrant, busy, error, save } =
    useVaultShareSheet(onClose);

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
  return <ShareSheetBody prefill={prefill} onClose={close} />;
}

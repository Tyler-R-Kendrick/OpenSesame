import { useState } from "react";
import { useNavigate } from "react-router";
import { lockAfterDraft } from "../lib/sw-update-guard.js";
import { useVaultStore } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { AccountSwitcher } from "./AccountSwitcher.js";
import { IconLock } from "./Icons.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { sessionSections, useSections } from "./RailRows.js";
import { openContextMenu } from "./context-menu/menu-model.js";
import { VaultShareSeat } from "./vault-share-seat.js";

export function LockKey() {
  const store = useVaultStore();
  const ref = useGuideTarget<HTMLButtonElement>("shell.lock");
  return (
    <button
      ref={ref}
      type="button"
      className="icon-btn"
      onClick={() => lockAfterDraft(store)}
      aria-label="Lock vault"
      title="Lock vault"
    >
      <IconLock size={18} />
    </button>
  );
}

export function SessionPrompt({
  showLock = true,
  header = false,
}: { showLock?: boolean; header?: boolean }) {
  const [vaultGlyphHost, setVaultGlyphHost] = useState<HTMLElement | null>(
    null,
  );
  const [accountGlyphHost, setAccountGlyphHost] = useState<HTMLElement | null>(
    null,
  );
  const navigate = useNavigate();
  const sections = useSections();
  const roots = sessionSections(sections);
  return (
    <div
      className={header ? "rail__prompt header-prompt" : "rail__prompt"}
      onContextMenu={(event) => {
        if (roots.length === 0) return;
        openContextMenu(event, event.currentTarget, "Session", [
          roots.map((root) => ({
            id: root.id,
            label: root.label,
            hint: `g ${root.jump}`,
            run: () => navigate(root.to),
          })),
        ]);
      }}
    >
      {header ? (
        <>
          <span className="header-prompt__glyphs" aria-hidden="true">
            <span ref={setVaultGlyphHost} />
            <span ref={setAccountGlyphHost} />
          </span>
          <ProjectSwitcher glyphHost={vaultGlyphHost} />
          <span className="prompt__dim" aria-hidden="true">
            @
          </span>
          <AccountSwitcher glyphHost={accountGlyphHost} />
          <VaultShareSeat />
          {showLock ? <LockKey /> : null}
        </>
      ) : (
        <>
          <div className="prompt__line prompt__line--account">
            <AccountSwitcher />
            <span className="prompt__dim" aria-hidden="true">
              @
            </span>
          </div>
          <div className="prompt__line prompt__line--vault">
            <ProjectSwitcher />
            <span className="prompt__dim prompt__dim--path" aria-hidden="true">
              :/
            </span>
            <VaultShareSeat />
            {showLock ? <LockKey /> : null}
          </div>
        </>
      )}
    </div>
  );
}

import { useNavigate } from "react-router";
import { useVaultStore } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { AccountSwitcher } from "./AccountSwitcher.js";
import { IconLock } from "./Icons.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { sessionSections, useSections } from "./RailRows.js";
import { openContextMenu } from "./context-menu/menu-model.js";

export function LockKey() {
  const store = useVaultStore();
  const ref = useGuideTarget<HTMLButtonElement>("shell.lock");
  return (
    <button
      ref={ref}
      type="button"
      className="icon-btn"
      onClick={() => store.lock()}
      aria-label="Lock vault"
      title="Lock vault"
    >
      <IconLock size={18} />
    </button>
  );
}

export function SessionPrompt({ showLock = true }: { showLock?: boolean }) {
  const navigate = useNavigate();
  const sections = useSections();
  const roots = sessionSections(sections);
  return (
    <div
      className="rail__prompt"
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
        {showLock ? <LockKey /> : null}
      </div>
    </div>
  );
}

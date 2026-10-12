import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { connectorPath } from "@opensesame/app-core/sections/connections/shared.js";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { IconDots } from "../../components/Icons.js";
import { openContextMenu } from "../../components/context-menu/menu-model.js";

/** Installed actions open the existing provider controls, including removal confirmation. */
export function InstalledConnectorActions({
  provider,
  connectionId,
  children,
  layout = "tile",
}: {
  provider: Provider;
  connectionId: string;
  children?: ReactNode;
  layout?: "tile" | "service";
}) {
  const navigate = useNavigate();
  const path = connectorPath(provider.id, connectionId);
  return (
    <button
      type="button"
      className={
        layout === "tile" ? "conn-tile__link" : "icon-btn icon-btn--sm"
      }
      tabIndex={layout === "tile" ? -1 : 0}
      aria-label={`Actions for ${provider.displayName}`}
      aria-haspopup="menu"
      onClick={(event) => {
        const anchor = event.currentTarget;
        const rect = anchor.getBoundingClientRect();
        openContextMenu(
          {
            clientX: rect.right,
            clientY: rect.bottom,
            preventDefault: () => event.preventDefault(),
          },
          anchor,
          `${provider.displayName} connection`,
          [
            [
              {
                id: "configure",
                label: "Configure connection",
                run: () => navigate(`${path}#connector`),
              },
              {
                id: "access",
                label: "Check access",
                run: () => navigate(`${path}#complete`),
              },
              {
                id: "remove",
                label: "Remove connection…",
                run: () => navigate(`${path}#complete`),
              },
            ],
          ],
        );
      }}
    >
      {children}
      <IconDots
        className={layout === "tile" ? "conn-tile__go" : undefined}
        size={18}
      />
    </button>
  );
}

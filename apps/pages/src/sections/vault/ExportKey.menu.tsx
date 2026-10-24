import { IconKey } from "../../components/IconKey.js";
import { IconDots, IconDownload } from "../../components/Icons.js";
import { openContextMenu } from "../../components/context-menu/menu-model.js";

/** Explicit browser delivery is distinct from the primary native save picker. */
export function ExportBackupMenu({
  disabled,
  onDownload,
}: {
  disabled: boolean;
  onDownload: () => void;
}) {
  return (
    <IconKey
      small
      label="Backup actions"
      disabled={disabled}
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
          "Backup actions",
          [
            [
              {
                id: "download-encrypted-backup",
                label: "Download backup",
                icon: <IconDownload size={16} />,
                run: onDownload,
              },
            ],
          ],
        );
      }}
    >
      <IconDots size={16} />
    </IconKey>
  );
}

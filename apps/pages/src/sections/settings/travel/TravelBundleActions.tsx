import type { DeparturePackage } from "@opensesame/app-core/lib/travel/index.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconDots, IconDownload } from "../../../components/Icons.js";
import { openContextMenu } from "../../../components/context-menu/menu-model.js";
import { downloadBlob } from "../../../lib/file-system.js";
import { saveBundle } from "./TravelViews.js";

/** Save with the browser picker, or explicitly choose a browser download. */
export function TravelBundleActions({
  pkg,
}: {
  pkg: Pick<DeparturePackage, "bundleJson" | "bundleFileName">;
}) {
  return (
    <>
      <IconKey
        small
        label="Save the travel bundle"
        onClick={() => saveBundle(pkg)}
      >
        <IconDownload size={16} />
      </IconKey>
      <IconKey
        small
        label="Travel bundle actions"
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
            "Travel bundle actions",
            [
              [
                {
                  id: "download-travel-bundle",
                  label: "Download the travel bundle",
                  icon: <IconDownload size={16} />,
                  run: () =>
                    downloadBlob(
                      new Blob([pkg.bundleJson], {
                        type: "application/octet-stream",
                      }),
                      pkg.bundleFileName,
                    ),
                },
              ],
            ],
          );
        }}
      >
        <IconDots size={16} />
      </IconKey>
    </>
  );
}

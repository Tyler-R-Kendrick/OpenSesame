/** The Share sheet's routes and their existing sealed-file editor. */
import { liveTransportFiles } from "@opensesame/app-core/sections/settings/live-transport-files.js";
import { useMemo, useRef, useState } from "react";
import { IconChevronLeft } from "../../components/Icons.js";
import { firstControl } from "../../lib/focus.js";
import { useVault } from "../../lib/vault/hooks.js";
import { VirtualFileEditor } from "../../sections/settings/files/VirtualFileEditor.js";
import { SettingsFileContext } from "../../sections/settings/files/context.js";
import "../../sections/settings/files/settings-files.css";
import { LiveRoutesPanel } from "./LiveRoutesPanel.js";
import { useLandOnChange } from "./live-focus.js";
import { transportSeams } from "./live-transport-hooks.js";

function TransportSettings() {
  const [path, setPath] = useState<string | null>(null);
  // Resolve the open vault when the provider operates, as the Routes form does.
  const files = useMemo(
    () => liveTransportFiles(() => transportSeams.tomb()),
    [],
  );
  const navigation = useMemo(() => ({ openFile: setPath }), []);
  const file = files.list().find((entry) => entry.path === path);
  const body = useRef<HTMLDivElement>(null);
  useLandOnChange(file?.path ?? "routes", () => firstControl(body.current));
  return (
    <div ref={body} className="setup__stack">
      {file ? (
        <>
          <button
            type="button"
            className="icon-btn"
            aria-label="Back to routes"
            onClick={() => setPath(null)}
          >
            <IconChevronLeft size={18} />
          </button>
          <VirtualFileEditor file={file} files={files} onMoved={setPath} />
        </>
      ) : (
        <SettingsFileContext.Provider value={navigation}>
          <LiveRoutesPanel />
        </SettingsFileContext.Provider>
      )}
    </div>
  );
}

/** A vault change withdraws its editor and draft; locking withdraws both views. */
export function LiveTransportSettings() {
  const { tomb, status } = useVault();
  return status === "unlocked" ? <TransportSettings key={tomb} /> : null;
}

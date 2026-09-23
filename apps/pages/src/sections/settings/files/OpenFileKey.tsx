/** The key on a Form row that opens the file the row is drawn from. */
import { IconTerminal } from "../../../components/Icons.js";
import { useOpenSettingsFile } from "./context.js";

export function OpenFileKey({ path, name }: { path: string; name: string }) {
  const openFile = useOpenSettingsFile();
  if (openFile === null) return null;
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label={`Open ${name}`}
      title={`Open ${path}`}
      onClick={() => openFile(path)}
    >
      <IconTerminal size={16} />
    </button>
  );
}

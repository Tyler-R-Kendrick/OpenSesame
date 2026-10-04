import { useContributions } from "../../bindings/contributions.js";
import { ExportKey } from "./ExportKey.js";
import "./vault-tools.css";

/**
 * What takes a vault in or out, on the screen a phone opens on.
 *
 * A desktop's list carries Import and Export as two icon keys among the
 * path strip's others. On a phone a pair of unlabelled arrows pointing in
 * opposite directions is a guess: these are full-width rows that say what
 * they do, under the tree they belong to — they act on the whole vault, not
 * on the list a pane away. The list keeps one header and the corner button.
 */
export function VaultTools() {
  const commands = useContributions("vault-command");
  return (
    <section className="vtools" aria-label="Vault tools">
      {commands.map(({ id, Command }) => (
        <Command key={id} row />
      ))}
      <ExportKey row />
    </section>
  );
}

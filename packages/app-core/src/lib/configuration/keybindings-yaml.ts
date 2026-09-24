import { parse, stringify } from "yaml";

/**
 * `settings/keybindings.yaml` in the file's own language. The panel showed
 * the bindings as JSON under a `.yaml` name; JSON is YAML, so a file pasted
 * in the old spelling still reads.
 */
export function keybindingsToYaml(bindings: Readonly<Record<string, string>>) {
  return stringify(bindings, { lineWidth: 0 });
}

/** The typed text as data, or `null` when it is not YAML at all. */
export function readKeybindingsYaml(text: string): unknown {
  try {
    return parse(text) ?? {};
  } catch {
    return null;
  }
}

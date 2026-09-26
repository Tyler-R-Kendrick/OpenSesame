import type { JsonValue } from "@opensesame/os-domain";

/** The generated module's text; each spec defaults to the checked-in file. */
export function renderModule(
  services?: JsonValue,
  presets?: JsonValue,
  catalog?: JsonValue,
): string;

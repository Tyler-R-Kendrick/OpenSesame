import type { JsonValue } from "@opensesame/os-domain";
/** Original public JSON, before lossless generated-fragment packing. */
export function renderPlanJson(
  services?: JsonValue,
  presets?: JsonValue,
  catalog?: JsonValue,
): string[];

/** The generated module's text; each spec defaults to the checked-in file. */
export function renderModule(
  services?: JsonValue,
  presets?: JsonValue,
  catalog?: JsonValue,
): string;

import type { JsonValue } from "@opensesame/os-domain";
export function googleAccountPolicy(presets?: JsonValue): {
  endpoints: Record<string, string>;
  scopes: string[];
  aliases: Record<string, string>;
  forbiddenParameters: string[];
};
export function renderGoogleAccountPolicy(presets?: JsonValue): string;

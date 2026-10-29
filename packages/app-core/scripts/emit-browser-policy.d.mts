import type { JsonValue } from "@opensesame/os-domain";
/** Compile the public browser policy source without introducing another authority. */
export function renderBrowserPolicy(policy: JsonValue): string;
/** Project only the authored fields consumed by the runtime policy. */
export function projectBrowserPolicy(policy: JsonValue): JsonValue;
export function renderRuntimeBrowserPolicy(policy: JsonValue): string;

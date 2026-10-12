import type { JsonValue } from "@opensesame/os-domain";
/** The part of the dispositions spec a browser reads: no probes, no kind definitions. */
export function runtimeDispositions(spec: JsonValue): JsonValue;
/** Compile the authored browser dispositions without introducing another authority. */
export function renderBrowserDispositions(spec: JsonValue): string;

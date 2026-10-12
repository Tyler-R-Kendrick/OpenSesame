/**
 * What `opensesame-id session` prints (ADR 0195). Results go to stdout, so a
 * pipe gets nothing else; everything a person is told along the way goes to
 * stderr. With `--json`, stdout is exactly one document.
 *
 * Text the host's tab reports (a connection's label, an item's name or
 * address) reached a terminal from a provider, so it is stripped of anything
 * a terminal would act on before it is drawn. JSON escapes it already.
 */

import type { DeviceResult } from "@opensesame/app-core/lib/live/device-client.js";
import type {
  DeviceConnection,
  DeviceItem,
} from "@opensesame/app-core/lib/live/device-messages.js";
import type { JsonObject } from "@opensesame/os-domain";
import { emit, emitHumanValue, emitStderrLine } from "./output.js";
import type { GlobalFlags } from "./parse.js";

const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** `text` with every control, format and private-use character replaced. */
export function printable(text: string): string {
  return text.replace(NOT_PRINTABLE, "?");
}

/** Rows as columns separated by two spaces, the last one unpadded. */
function columns(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows)
    row.slice(0, -1).forEach((cell, at) => {
      widths[at] = Math.max(widths[at] ?? 0, cell.length);
    });
  return rows
    .map((row) =>
      row
        .map((cell, at) => cell.padEnd(widths[at] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function connectionJson(connection: DeviceConnection): JsonObject {
  return {
    id: connection.id,
    label: connection.label,
    provider: connection.provider,
    operations: [...connection.operations],
  };
}

function itemJson(item: DeviceItem): JsonObject {
  return item.url === undefined
    ? { id: item.id, label: item.label }
    : { id: item.id, label: item.label, url: item.url };
}

function stamp(epochMs: number): string | null {
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) || epochMs <= 0
    ? null
    : date.toISOString();
}

/** Progress and instructions for the person at the terminal. */
export function tell(line: string): void {
  emitStderrLine(line);
}

/** The granted connections: one row each, or a document with `--json`. */
export function printConnections(
  flags: GlobalFlags,
  connections: readonly DeviceConnection[],
  expiresAt: number,
): void {
  const until = stamp(expiresAt);
  if (until !== null) tell(`The host's grant lapses at ${until}.`);
  if (connections.length === 0) tell("The host granted no connections.");
  if (flags.json) {
    emit(flags, "", {
      ok: true,
      action: "list",
      ...(until === null ? undefined : { expiresAt: until }),
      connections: connections.map(connectionJson),
    });
    return;
  }
  if (connections.length === 0) return;
  const rows = connections.map((connection) => [
    printable(connection.id),
    printable(connection.label),
    printable(connection.provider),
    printable(connection.operations.join(", ")),
  ]);
  emitHumanValue(`${columns(rows)}\n`);
}

/** One operation's answer: its label, then a line per item. */
export function printResult(
  flags: GlobalFlags,
  call: Readonly<{ connection: string; operation: string }>,
  result: DeviceResult,
): void {
  if (result.truncated)
    tell("The host cut this answer short to fit; there is more than is shown.");
  if (result.items.length === 0) tell("The operation returned no items.");
  if (flags.json) {
    emit(flags, "", {
      ok: true,
      action: "invoke",
      connection: call.connection,
      operation: call.operation,
      label: result.label,
      items: result.items.map(itemJson),
      truncated: result.truncated,
    });
    return;
  }
  const rows = result.items.map((item) =>
    [item.id, item.label, item.url].flatMap((cell) =>
      cell === undefined ? [] : [printable(cell)],
    ),
  );
  const lines = [printable(result.label)];
  if (rows.length > 0) lines.push(columns(rows));
  emitHumanValue(`${lines.join("\n")}\n`);
}

/** A failure: one line on stderr, and with `--json` the same on stdout. */
export function printFailure(
  flags: GlobalFlags,
  failure: Readonly<{ code: string; message: string }>,
): void {
  tell(failure.message);
  if (flags.json)
    emit(flags, "", {
      ok: false,
      error: failure.code,
      message: failure.message,
    });
}

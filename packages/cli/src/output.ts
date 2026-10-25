import { scrubText } from "@opensesame/log-scrub";
import type { BoundaryValue, JsonValue } from "@opensesame/os-domain";
import { redactSecrets } from "@opensesame/sdk-cli";
import { z } from "zod";

interface OutputFlags {
  json: boolean;
}

/** Print a result: the redacted data with `--json`, else the human line. */
export function emit(
  flags: OutputFlags,
  human: string,
  data: JsonValue | undefined,
): void {
  const redacted = redactSecrets(data);
  const redactedReceipt = restoreReceiptCount(data, redacted);
  const trimmed = human.trimStart();
  const text =
    flags.json || trimmed.startsWith("{") || trimmed.startsWith("[")
      ? JSON.stringify(redactedReceipt, null, 2)
      : human;
  writeStdout(`${text}\n`);
}

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function writeStderr(text: string): void {
  process.stderr.write(text);
}

/** One scrubbed line on stderr (ADR 0157). */
export function emitStderrLine(line: string): void {
  const scrubbed = scrubText(line);
  const text = scrubbed.endsWith("\n") ? scrubbed : `${scrubbed}\n`;
  writeStderr(text);
}

/**
 * Child-process output the run lane has already masked, forwarded
 * byte-for-byte: functional output like an explicit human read, never a
 * log line, so it does not re-enter the scrubbing logger.
 */
export function emitChildStdout(chunk: string): void {
  writeStdout(chunk);
}

export function emitChildStderr(chunk: string): void {
  writeStderr(chunk);
}

/** What went wrong, as one scrubbed line for stderr (ADR 0157). */
export function errorLine(err: BoundaryValue): string {
  return `${scrubText(err instanceof Error ? err.message : String(err))}\n`;
}

const JsonOutputSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonOutputSchema),
    z.record(z.string(), JsonOutputSchema),
  ]),
);

/** Command receipts pass through the same redaction boundary as existing CLI output. */
export function emitMetadata<T>(value: T): void {
  emit(
    { json: true },
    "",
    JsonOutputSchema.parse(JSON.parse(JSON.stringify(value))),
  );
}

/** Only an explicit human read writes exact secret bytes; this is functional output. */
export function emitHumanValue(value: string): void {
  writeStdout(value);
}

/** Numeric receipt counts carry no plaintext; other secret-shaped fields stay redacted. */
function restoreReceiptCount(
  data: JsonValue | undefined,
  redacted: JsonValue | undefined,
): JsonValue | undefined {
  const metric = z
    .object({
      secretEchoes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .safeParse(data);
  const object = z.record(z.string(), JsonOutputSchema).safeParse(redacted);
  if (metric.success && object.success)
    return { ...object.data, secretEchoes: metric.data.secretEchoes };
  return redacted;
}

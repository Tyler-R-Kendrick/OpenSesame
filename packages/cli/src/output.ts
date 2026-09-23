import type { JsonValue } from "@opensesame/os-domain";
import { redactSecrets } from "@opensesame/sdk-cli";

/** Print a result: the redacted data with `--json`, else the human line. */
export function emit(
  flags: { json: boolean },
  human: string,
  data: JsonValue | undefined,
): void {
  const redacted = redactSecrets(data);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
    return;
  }
  const trimmed = human.trimStart();
  const safeHuman =
    trimmed.startsWith("{") || trimmed.startsWith("[")
      ? JSON.stringify(redacted, null, 2)
      : human;
  process.stdout.write(`${safeHuman}\n`);
}

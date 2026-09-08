import { isString } from "@opensesame/os-domain";
import {
  parseSupportTurn,
  redactSupportQuestion,
} from "@opensesame/support-agent";

/** Jazzer discovers this target; parser output remains inert data. */
export function fuzz(data: Buffer): void {
  const input = data.subarray(0, 2000).toString("utf8").slice(0, 2000);
  const redacted = redactSupportQuestion(input);
  if (redacted !== redactSupportQuestion(input))
    throw new Error("Nondeterministic redaction");
  const turn = parseSupportTurn(data.subarray(0, 65_536).toString("utf8"));
  if (!isString(turn.answer)) throw new Error("Invalid parser output");
}

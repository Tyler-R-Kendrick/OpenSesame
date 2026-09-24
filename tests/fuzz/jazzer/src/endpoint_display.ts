import { briefOrigin, repoHint } from "@opensesame/os-domain";
import { FuzzedDataProvider } from "./provider.js";

/**
 * Endpoint and git-remote shortening, over arbitrary input.
 *
 * Both functions render values a person typed into settings, which are
 * attacker-influenced the moment anything can write our storage. They are
 * displayed in a status glyph's accessible name, a connector tile and a
 * ceremony header — three places where a throw takes out the whole
 * connectivity bar, and where an unbounded return value wrecks the layout the
 * bar depends on to stay glanceable.
 *
 * The invariants worth holding for *any* input:
 *
 *  - never throw, for anything a person can type;
 *  - be deterministic, because a status line that changes between renders
 *    with no new probe is worse than a stale one;
 *  - never grow the input, since these exist to shorten;
 *  - never invent a scheme — `briefOrigin` drops it, and a caller that shows
 *    the result beside the word "unreachable" must not imply https.
 */
export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const raw = p.consumeString(256);
  const remote = p.consumeString(256);

  const origin = briefOrigin(raw);
  if (origin !== briefOrigin(raw)) {
    throw new Error("briefOrigin is not deterministic");
  }
  if (origin.length > raw.trim().length) {
    throw new Error(`briefOrigin grew its input: ${JSON.stringify(raw)}`);
  }
  // A shortened origin must not carry a scheme it might not have had. The
  // only way one survives is if the input never parsed, in which case it is
  // passed through verbatim and is the operator's own text.
  if (/^https?:\/\//i.test(origin) && origin !== raw.trim()) {
    throw new Error(`briefOrigin kept a scheme: ${JSON.stringify(raw)}`);
  }
  if (raw.trim() === "" && origin !== "") {
    throw new Error("briefOrigin invented output for empty input");
  }

  const hint = repoHint(remote);
  if (hint !== repoHint(remote)) {
    throw new Error("repoHint is not deterministic");
  }
  if (hint.length > remote.trim().length) {
    throw new Error(`repoHint grew its input: ${JSON.stringify(remote)}`);
  }
  if (remote.trim() === "" && hint !== "") {
    throw new Error("repoHint invented output for empty input");
  }
  // `.git` is noise on every remote and must not survive into a status line.
  if (hint.endsWith(".git")) {
    throw new Error(`repoHint kept a .git suffix: ${JSON.stringify(remote)}`);
  }
  // Neither is a validator, so both stay total: whatever comes back is a
  // string, and never a leading slash that would read as a path.
  if (hint.startsWith("/")) {
    throw new Error(
      `repoHint leaked a leading slash: ${JSON.stringify(remote)}`,
    );
  }
}

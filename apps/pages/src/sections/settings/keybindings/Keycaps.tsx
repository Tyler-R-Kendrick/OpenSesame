import {
  keycapLabel,
  parseSequence,
} from "@opensesame/app-core/lib/keymap/notation.js";

/** A sequence as keycaps: one `kbd` per press, `g` `v`. */
export function Keycaps({ sequence }: { sequence: string }) {
  const tokens = parseSequence(sequence) ?? [sequence];
  return (
    <>
      {tokens.map((token, index) => (
        <kbd key={`${index}-${token}`} className="keycap">
          {keycapLabel(token)}
        </kbd>
      ))}
    </>
  );
}

import { estimateStrength } from "@opensesame/app-core/lib/vault/password.js";

const STRENGTH_VARS = ["--s-0", "--s-1", "--s-2", "--s-3", "--s-4"] as const;

/** The password's estimated strength as a four-step bar and its label. */
export function StrengthBar({ password }: { password: string }) {
  const strength = estimateStrength(password);
  const color = `var(${STRENGTH_VARS[strength.score]})`;
  return (
    <div className="sbar">
      <div className="sbar__track" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            style={
              index <= strength.score - 1 ? { background: color } : undefined
            }
          />
        ))}
      </div>
      <span className="sbar__label" style={{ color }}>
        {strength.label} · ≈{strength.bits} bits
      </span>
    </div>
  );
}

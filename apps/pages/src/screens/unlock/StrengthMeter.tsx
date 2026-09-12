import { estimateStrength } from "../../lib/vault/password.js";

const STRENGTH_VARS = ["--s-0", "--s-1", "--s-2", "--s-3", "--s-4"] as const;

/** The four-segment strength track under a first-run master password. */
export function StrengthMeter({ password }: { password: string }) {
  const strength = estimateStrength(password);
  const filled = password ? strength.score + 1 : 0;
  const color = `var(${STRENGTH_VARS[strength.score]})`;
  return (
    <div className="unlock__meter">
      <div className="unlock__track" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            style={index < filled ? { background: color } : undefined}
          />
        ))}
      </div>
      <p className="unlock__meter-row">
        <span className="unlock__meter-label" style={{ color }}>
          {password ? strength.label : "Enter a master password"}
        </span>
        <span className="unlock__bits">
          {password ? `≈${strength.bits} bits` : ""}
        </span>
      </p>
    </div>
  );
}

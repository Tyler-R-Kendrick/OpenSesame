/**
 * Step 4 — mfa. Nothing can be enrolled before a vault exists to guard, so
 * this step is a tour of the second steps rather than a form: what each is,
 * and where each is switched on (Settings › Security, once sealed).
 */

import { StepHead } from "./shared.js";

const ROADS: readonly { name: string; note: string }[] = [
  {
    name: "Authenticator app",
    note: "A six-digit code after the key. This vault can hold its own entry and supply the code itself (ADR 0113); anything else asks.",
  },
  {
    name: "Email code",
    note: "A fallback the identity service on the identity tab delivers. Anyone who reads the inbox reads the code — keep a stronger step beside it.",
  },
  {
    name: "Text message",
    note: "The same service, by SMS. A number can be moved to another SIM — a fallback, never a first second step.",
  },
];

export function MfaStep() {
  return (
    <>
      <StepHead title="Should a code follow the key?">
        A second step asks for more than the key. Enrolling one needs a sealed
        vault, so each road is switched on from Settings › Security afterwards —
        recovery codes are handed over there too.
      </StepHead>

      <ul className="list">
        {ROADS.map((road) => (
          <li key={road.name}>
            <div>
              <strong>{road.name}</strong>
              <div className="muted">{road.note}</div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

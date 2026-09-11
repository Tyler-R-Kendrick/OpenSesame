/**
 * Step 4 — mfa. Nothing can be enrolled before a vault exists to guard, so
 * this step is a tour of the second steps rather than a form: what each is,
 * and where each is switched on (Settings › Security, once sealed).
 */

import { StepHead } from "./shared.js";

const ROADS: readonly { name: string; note: string }[] = [
  {
    name: "Authenticator app",
    note: "A six-digit code after the key. This vault can hold its own entry and supply the code itself; anything else asks.",
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

      <ul className="xcards" aria-label="Second steps">
        {ROADS.map((road) => (
          <li key={road.name} className="xcard">
            <span className="xcard__pick">
              <span className="xcard__name">{road.name}</span>
              <span className="xcard__kind">{road.note}</span>
            </span>
            <span className="xcard__side">
              <span className="chip">after sealing</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

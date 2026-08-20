import { useEffect, useState } from "react";
import {
  type TotpConfig,
  TotpParseError,
  parseTotp,
  secondsRemaining,
  totpCode,
} from "../lib/vault/totp.js";
import { overlapCast } from "@opensesame/os-domain";

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Live RFC 6238 code, regenerated on the period boundary. */
export function TotpCode({ secret }: { secret: string }) {
  const [state, setState] = useState<
    | { kind: "code"; code: string; remaining: number; period: number }
    | { kind: "error"; message: string }
  >({ kind: "error", message: "" });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    // Never show the previous item's code while the new one is generating.
    setState({ kind: "error", message: "" });

    let config: TotpConfig;
    try {
      config = parseTotp(secret);
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof TotpParseError
            ? error.message
            : "This authenticator secret could not be read.",
      });
      return;
    }

    const tick = async () => {
      try {
        const code = await totpCode(config);
        if (cancelled) return;
        const remaining = secondsRemaining(config.period);
        setState({ kind: "code", code, remaining, period: config.period });
        // Land on the period boundary, then tick once per second within it.
        timer = window.setTimeout(
          () => void tick(),
          remaining > 1 ? 1000 : 250,
        );
      } catch {
        if (cancelled) return;
        setState({
          kind: "error",
          message: "This authenticator code could not be generated.",
        });
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [secret]);

  if (state.kind === "error") {
    return (
      <span className="frow__value frow__value--muted">{state.message}</span>
    );
  }

  const fraction = state.remaining / state.period;
  const expiring = state.remaining <= 5;
  const grouped =
    state.code.length === 6
      ? `${state.code.slice(0, 3)} ${state.code.slice(3)}`
      : state.code;

  return (
    <span className={`totp${expiring ? " totp--expiring" : ""}`}>
      <span className="totp__code">{grouped}</span>
      <svg
        className="totp__ring"
        viewBox="0 0 20 20"
        style={{ [overlapCast("--dash")]: `${CIRCUMFERENCE}` }}
        role="img"
        aria-label={`${state.remaining} seconds remaining`}
      >
        <circle className="track" cx="10" cy="10" r={RADIUS} />
        <circle
          className="head"
          cx="10"
          cy="10"
          r={RADIUS}
          style={{ strokeDashoffset: CIRCUMFERENCE * (1 - fraction) }}
        />
      </svg>
    </span>
  );
}

/** Raw current code for copying, without the display chrome. */
export async function currentTotp(secret: string): Promise<string> {
  return totpCode(parseTotp(secret));
}

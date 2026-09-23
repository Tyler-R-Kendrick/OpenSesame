import type { ConnectorDecision } from "@opensesame/app-core/lib/duress/compartment/connectors.js";
import type { OpenOutcome } from "@opensesame/app-core/lib/duress/compartment/session.js";
import { createElement } from "react";

/**
 * Honest status for decoy/locked outcomes — never fabricates production success.
 */
export function DecoyStatus(props: {
  outcome: OpenOutcome;
  connectorDecision?: ConnectorDecision | null;
}) {
  const locked = props.outcome.kind === "locked";
  const reason = props.outcome.kind === "locked" ? props.outcome.reason : null;

  return createElement(
    "div",
    { className: "decoy-status", role: "status" },
    locked
      ? createElement("p", null, `Unavailable (${reason ?? "locked"})`)
      : createElement("p", null, "Ready"),
    props.connectorDecision && !props.connectorDecision.ok
      ? createElement(
          "p",
          null,
          `Connector refused: ${props.connectorDecision.code}`,
        )
      : null,
  );
}

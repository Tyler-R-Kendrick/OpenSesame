import { useState } from "react";
import {
  evaluateDecision,
  localApplicationEvaluator,
} from "../../lib/configuration/evaluate.js";
import {
  type SavedPolicyTest,
  publicationBlocked,
  runSavedPolicyTests,
} from "../../lib/configuration/policy-tests.js";
import type { LocalScopeRoles } from "../../lib/local-application-policy.js";

export function ApplicationDiagnostics(props: {
  policy?: LocalScopeRoles[];
  policyRevision?: string;
}) {
  const policy = props.policy ?? [];
  const policyRevision = props.policyRevision ?? "0";
  const [role, setRole] = useState<"owner" | "admin" | "member">("member");
  const [scopeText, setScopeText] = useState("openid");
  const scopes = scopeText.split(/\s+/).filter(Boolean);
  const input = {
    resourceId: "local-application",
    principalId: "synthetic",
    operation: "authorize",
    facts: { role, scopes, policy },
    policyRevision,
  };
  const evaluation = evaluateDecision(
    localApplicationEvaluator,
    input,
    "simulate",
  );
  const [tests, setTests] = useState<SavedPolicyTest[]>([]);
  const [expectDecision, setExpectDecision] = useState<"allow" | "deny">(
    "allow",
  );
  const runs = runSavedPolicyTests(tests, localApplicationEvaluator);

  function saveCurrent() {
    setTests([
      ...tests,
      {
        id: `case-${tests.length + 1}`,
        name: `${role} ${scopes.join(" ")}`,
        input,
        expect: expectDecision,
      },
    ]);
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h3>Diagnostics</h3>
        </div>
      </div>
      <div className="panel__body">
        <p className="hint">
          Simulation uses the same scope-role check as local admission. It does
          not issue tokens, send mail, or approve requests.
        </p>
        <label>
          Role{" "}
          <select
            aria-label="Simulated role"
            value={role}
            onChange={(event) =>
              setRole(event.target.value as "owner" | "admin" | "member")
            }
          >
            <option value="owner">owner</option>
            <option value="admin">admin</option>
            <option value="member">member</option>
          </select>
        </label>
        <label>
          Scopes{" "}
          <input
            aria-label="Requested scopes"
            value={scopeText}
            onChange={(event) => setScopeText(event.target.value)}
          />
        </label>
        <p>
          Decision: <strong>{evaluation.decision}</strong> (
          {evaluation.coverage})
        </p>
        <label>
          Expect{" "}
          <select
            aria-label="Expected decision"
            value={expectDecision}
            onChange={(event) =>
              setExpectDecision(
                event.target.value === "deny" ? "deny" : "allow",
              )
            }
          >
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
        </label>
        <button type="button" className="btn btn--sm" onClick={saveCurrent}>
          Save as policy test
        </button>
        <ul>
          {runs.map((run) => (
            <li key={run.id}>
              {run.name}: expect {run.expect}, got {run.actual}{" "}
              {run.passed ? "pass" : "fail"}
            </li>
          ))}
        </ul>
        {publicationBlocked(runs) ? (
          <p role="alert" className="note note--err">
            A saved test failed. Candidate publication is blocked.
          </p>
        ) : null}
      </div>
    </section>
  );
}

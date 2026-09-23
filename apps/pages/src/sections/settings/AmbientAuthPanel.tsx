import { IconCheck, IconX } from "../../components/Icons.js";
/**
 * Returning-user opt-in for automatic sign-in. Deployment-selected policy is
 * shown as configuration, never as device management.
 */

import {
  clearUserAmbientPreference,
  resolveAmbientAuthPolicy,
  writeUserAmbientPreference,
} from "@opensesame/app-core/lib/ambient-auth/policy.js";
import {
  protocolForIssuer,
  providerConnectionKey,
} from "@opensesame/app-core/lib/ambient-auth/provider.js";
import { deployedAmbientPolicy } from "@opensesame/app-core/lib/ambient-auth/runtime.js";
import { signInMethods } from "@opensesame/app-core/lib/settings.js";
import { useId, useReducer } from "react";

export function AmbientAuthPanel() {
  const id = useId();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const providers = signInMethods().providers;
  const decision = resolveAmbientAuthPolicy({
    runtime: deployedAmbientPolicy(),
    userPreference: undefined,
    operatorProviders: providers,
  });
  const deployed =
    decision.policy.mode === "deployment-selected" && decision.eligible;

  function optIn(issuer: string, clientId: string, providerId: string): void {
    const protocol = protocolForIssuer(issuer, providerId);
    writeUserAmbientPreference({
      schemaVersion: 1,
      mode: "returning-opt-in",
      selectedProviderKey: providerConnectionKey({
        protocol,
        issuer,
        clientId,
      }),
      allowedTransport: "silent-redirect",
    });
    bump();
  }

  return (
    <section className="card" aria-labelledby={id}>
      <div className="keyed-row">
        <h2 id={id}>Automatic sign-in</h2>
        {deployed ? null : (
          <button
            type="button"
            className="icon-btn"
            aria-label="Don't sign me in automatically"
            title="Don't sign me in automatically"
            onClick={() => {
              clearUserAmbientPreference();
              bump();
            }}
          >
            <IconX size={16} />
          </button>
        )}
      </div>
      {deployed ? (
        <p>
          This deployment is configured to sign you in with{" "}
          {decision.connection?.displayName ?? "your organization"} when the
          provider can complete silently. That is operator configuration, not
          proof that this device is managed.
        </p>
      ) : (
        <p>
          OpenSesame can retry the provider you choose when you return. This
          never unlocks a vault and never attaches a guest account.
        </p>
      )}
      {deployed ? null : providers.length === 0 ? (
        <p className="hint">Add an organization provider to enable this.</p>
      ) : (
        <ul className="stack">
          {providers.map((idp) => (
            <li key={idp.issuer} className="keyed-row keyed-row--field">
              <span>{idp.label}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Use ${idp.label} automatically next time`}
                title={`Use ${idp.label} automatically next time`}
                onClick={() => optIn(idp.issuer, idp.clientId, idp.providerId)}
              >
                <IconCheck size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

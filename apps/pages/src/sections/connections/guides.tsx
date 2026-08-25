import { IconExternal } from "../../components/Icons.js";
import type { Provider } from "../../lib/connections.js";
import { connectorSteps } from "../../lib/connector-guidance.js";
import { hostBase } from "../../lib/identity.js";

export function DeploymentSetupGuide({ provider }: { provider: Provider }) {
  const callback = `${hostBase()}/api/v1/oauth/callback/${provider.id}`;
  const delegated = provider.id === "openrouter";
  const missing = provider.missingConfig.filter(
    (name) => !name.includes("CONNECTION_KEY"),
  );
  return (
    <div className="conn-setup-guide">
      <ol>
        <li>
          {delegated
            ? "No provider app registration is required; OpenRouter creates the key after the user approves access."
            : provider.authKind === "oauth2_authorization_code"
              ? "Create an OAuth app registration using the provider guide."
              : "Create the provider credential using the setup guide."}
        </li>
        {provider.authKind === "oauth2_authorization_code" && !delegated ? (
          <li>
            Register this exact callback URL: <code>{callback}</code>
          </li>
        ) : null}
        {missing.length > 0 ? (
          <li>
            Optional OAuth app env vars on the Host (not required when using a
            personal access token for GitHub/GitLab):
            <ul className="conn-envs">
              {missing.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
          </li>
        ) : (
          <li>Restart the Host after updating provider credentials.</li>
        )}
      </ol>
      <a
        className="conn-doc-link"
        href={provider.docsUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        <IconExternal size={16} /> Open {provider.displayName} setup guide
      </a>
    </div>
  );
}

export function ConnectorSetupGuide({ provider }: { provider: Provider }) {
  return (
    <div className="conn-setup-guide">
      <ol>
        {connectorSteps(provider).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <a
        className="conn-doc-link"
        href={provider.docsUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        <IconExternal size={16} /> Open {provider.displayName} setup guide
      </a>
    </div>
  );
}

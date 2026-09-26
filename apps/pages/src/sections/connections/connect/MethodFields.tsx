import {
  type DraftState,
  methodOf,
  withParam,
} from "@opensesame/app-core/lib/connect-draft.js";
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { OauthClientFields, OauthServerFields } from "./OauthFields.js";
import { Facts, OutLink, SelectField } from "./fields.js";

type Props = {
  plan: ConnectPlan;
  state: DraftState;
  onState: (next: DraftState) => void;
  redirectUri?: string;
};

const REGISTRATION = {
  dcr: "Registers its own client (RFC 7591)",
  cimd: "Client ID metadata document",
  manual: "Needs a client you register",
} as const;

function McpFields({ plan, state, onState }: Props) {
  const method = methodOf(plan, "mcp");
  if (method?.kind !== "mcp" || method.mcp.status !== "ok") return null;
  const mcp = method.mcp;
  return (
    <fieldset className="cx-block">
      <legend>MCP server</legend>
      <Facts
        rows={[
          ["Server", mcp.url],
          ["Authorization", mcp.issuer ?? mcp.authorizationEndpoint],
          ["Client", REGISTRATION[mcp.registration]],
          ["PKCE", mcp.pkce.join(", ") || "Not offered"],
          ["Scopes", mcp.scopes.join(" ") || "Server default"],
        ]}
      />
      {mcp.registration === "manual" ? (
        <div className="cx-grid">
          <FieldShell
            label="Client ID"
            value={state.mcpClientId}
            autoComplete="off"
            mono
            onValueChange={(mcpClientId) => onState({ ...state, mcpClientId })}
          />
          <FieldShell
            label="Client secret"
            type="password"
            value={state.mcpClientSecret}
            autoComplete="new-password"
            mono
            onValueChange={(mcpClientSecret) =>
              onState({ ...state, mcpClientSecret })
            }
          />
        </div>
      ) : null}
    </fieldset>
  );
}

const SUBJECTS = [
  { id: "user", label: "Each person pastes their own" },
  { id: "app", label: "One shared key" },
] as const;

function KeyFields({ plan, state, onState }: Props) {
  const method = methodOf(plan, "api-key");
  const preset = method?.kind === "api-key" ? method.preset : null;
  return (
    <fieldset className="cx-block">
      <legend>API key</legend>
      {preset?.templateParams.map((param) => (
        <FieldShell
          key={param.name}
          label={param.label}
          value={state.params[param.name] ?? ""}
          placeholder={param.placeholder}
          mono
          onValueChange={(value) =>
            onState(withParam(state, plan, param.name, value))
          }
        />
      ))}
      <SelectField
        label="Whose key"
        value={state.keySubject}
        options={SUBJECTS}
        onChange={(keySubject) => onState({ ...state, keySubject })}
      />
      {state.keySubject === "app" ? (
        <FieldShell
          label="API key"
          type="password"
          value={state.key}
          placeholder={preset?.keyPrefix ? `${preset.keyPrefix}…` : ""}
          autoComplete="new-password"
          mono
          onValueChange={(key) => onState({ ...state, key })}
        />
      ) : null}
      <FieldShell
        label="API"
        type="url"
        value={state.serviceUrls[0] ?? ""}
        mono
        onValueChange={(first) =>
          onState({
            ...state,
            serviceUrls: [first, ...state.serviceUrls.slice(1)],
          })
        }
      />
      <div className="cx-select">
        <label className="f__label" htmlFor={`${plan.id}-instructions`}>
          Instructions shown while authorizing
        </label>
        <textarea
          id={`${plan.id}-instructions`}
          className="cx-textarea"
          value={state.instructions}
          maxLength={4000}
          onChange={(event) =>
            onState({ ...state, instructions: event.target.value })
          }
        />
      </div>
      <div className="cx-links">
        {preset?.keyUrl ? (
          <OutLink href={preset.keyUrl}>{plan.name} API keys</OutLink>
        ) : null}
        {preset?.docsUrl ? (
          <OutLink href={preset.docsUrl}>{plan.name} API docs</OutLink>
        ) : null}
      </div>
    </fieldset>
  );
}

/** The fields the chosen method asks for, already filled from the plan. */
export function MethodFields(props: Props) {
  switch (props.state.method) {
    case "oauth":
      return (
        <>
          <OauthClientFields {...props} />
          <OauthServerFields {...props} />
        </>
      );
    case "mcp":
      return <McpFields {...props} />;
    case "api-key":
      return <KeyFields {...props} />;
    case "managed":
      return <Facts rows={[["Client", `Vercel's ${props.plan.name} app`]]} />;
  }
}

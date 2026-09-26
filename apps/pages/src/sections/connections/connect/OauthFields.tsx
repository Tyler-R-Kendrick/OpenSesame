import type { OauthDraft } from "@opensesame/app-core/lib/connect-create.js";
import {
  type DraftState,
  methodOf,
  withParam,
} from "@opensesame/app-core/lib/connect-draft.js";
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { AuthorizationParams, ScopeFields } from "./ScopeFields.js";
import { CopyKey, Facts, OutLink, SelectField } from "./fields.js";

const TOKEN_AUTH = [
  { id: "client_secret_post", label: "client_secret_post" },
  { id: "client_secret_basic", label: "client_secret_basic" },
  { id: "none", label: "none (public client)" },
] as const;

const PKCE = [
  { id: "S256", label: "S256 when offered" },
  { id: "required", label: "S256, required" },
  { id: "none", label: "Not used" },
] as const;

type Props = {
  plan: ConnectPlan;
  state: DraftState;
  onState: (next: DraftState) => void;
  redirectUri?: string;
};

function setOauth(props: Props, patch: Partial<OauthDraft>) {
  props.onState({ ...props.state, oauth: { ...props.state.oauth, ...patch } });
}

/** Who the client is: an account host if the preset needs one, and its id. */
export function OauthClientFields(props: Props) {
  const { plan, state, onState, redirectUri } = props;
  const method = methodOf(plan, "oauth");
  const preset = method?.kind === "oauth" ? method.preset : null;
  const assisted = state.oauth.registration !== "manual";
  return (
    <fieldset className="cx-block">
      <legend>OAuth client</legend>
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
      <div className="cx-grid">
        <FieldShell
          label={assisted ? "Client ID (optional)" : "Client ID"}
          value={state.oauth.clientId}
          placeholder={assisted ? "Registered for you" : ""}
          autoComplete="off"
          mono
          onValueChange={(clientId) => setOauth(props, { clientId })}
        />
        {state.oauth.tokenAuth === "none" ? null : (
          <FieldShell
            label="Client secret"
            type="password"
            value={state.oauth.clientSecret}
            placeholder={redirectUri ? "Unchanged" : ""}
            autoComplete="new-password"
            mono
            onValueChange={(clientSecret) => setOauth(props, { clientSecret })}
          />
        )}
      </div>
      {redirectUri ? (
        <Facts
          rows={[
            [
              "Redirect URI",
              <span className="cx-inline" key="redirect">
                <span>{redirectUri}</span>
                <CopyKey value={redirectUri} label="Copy redirect URI" />
              </span>,
            ],
          ]}
        />
      ) : null}
      <div className="cx-links">
        {preset?.consoleUrl ? (
          <OutLink href={preset.consoleUrl}>
            {plan.name} developer console
          </OutLink>
        ) : null}
        {preset?.docsUrl ? (
          <OutLink href={preset.docsUrl}>{plan.name} OAuth docs</OutLink>
        ) : null}
      </div>
    </fieldset>
  );
}

/** The authorization server, as Vercel's connector settings lay it out. */
export function OauthServerFields(props: Props) {
  const o = props.state.oauth;
  const url = (label: string, key: keyof OauthDraft, value: string) => (
    <FieldShell
      label={label}
      type="url"
      value={value}
      mono
      onValueChange={(next) => setOauth(props, { [key]: next })}
    />
  );
  return (
    <fieldset className="cx-block">
      <legend>OAuth server</legend>
      {url("Server URL", "serverUrl", o.serverUrl)}
      {url(
        "Authorization endpoint",
        "authorizationEndpoint",
        o.authorizationEndpoint,
      )}
      {url("Token endpoint", "tokenEndpoint", o.tokenEndpoint)}
      <div className="cx-grid">
        {url("Revocation endpoint", "revocationEndpoint", o.revocationEndpoint)}
        {url("User info endpoint", "userinfoEndpoint", o.userinfoEndpoint)}
      </div>
      <div className="cx-grid">
        <SelectField
          label="Token endpoint auth method"
          value={o.tokenAuth}
          options={TOKEN_AUTH}
          onChange={(tokenAuth) => setOauth(props, { tokenAuth })}
        />
        <SelectField
          label="PKCE"
          value={o.pkce}
          options={PKCE}
          onChange={(pkce) => setOauth(props, { pkce })}
        />
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={o.refreshTokens}
          onChange={(event) =>
            setOauth(props, { refreshTokens: event.target.checked })
          }
        />
        <span>Refresh tokens</span>
      </label>
      <AuthorizationParams
        params={o.authorizationParams}
        onParams={(authorizationParams) =>
          setOauth(props, { authorizationParams })
        }
      />
      <ScopeFields
        plan={props.plan}
        state={props.state}
        onState={props.onState}
      />
    </fieldset>
  );
}

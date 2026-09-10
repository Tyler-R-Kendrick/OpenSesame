import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type LocalScopeRoles,
  defaultScopeRoles,
} from "../../lib/local-application-policy.js";
import {
  type LocalApplication,
  type LocalApplications,
  configureLocalApplication,
  readLocalApplications,
} from "../../lib/local-applications.js";
import {
  type LocalDirectory,
  LocalDirectoryError,
} from "../../lib/local-directory.js";
import {
  OrganizationField,
  ScopeRolesField,
} from "./LocalApplicationFields.js";

type Props = {
  tomb: string;
  applicationId: string;
  directory: LocalDirectory;
  disabled: boolean;
};

export function LocalApplicationSettings(props: Props) {
  const [open, setOpen] = useState(false);
  const summary = useRef<HTMLElement>(null);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary ref={summary}>Application registration</summary>
      {open ? (
        <RegistrationEditor
          {...props}
          onRemoved={() => {
            if (document.activeElement === document.body)
              summary.current?.focus();
          }}
        />
      ) : null}
    </details>
  );
}

function useRegistration(tomb: string, applicationId: string) {
  const [state, setState] = useState<LocalApplications | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const focusSource = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (busy || !focusSource.current) return;
    const previous = focusSource.current;
    focusSource.current = null;
    if (previous.isConnected && document.activeElement === document.body)
      previous.focus();
  }, [busy]);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const request = ++generation.current;
    setState(null);
    void readLocalApplications(tomb).then(
      (next) => {
        if (request === generation.current) {
          setState(next);
          setError("");
        }
      },
      () => {
        if (request === generation.current)
          setError(
            "Could not read application registration. Unlock the vault and reload.",
          );
      },
    );
  }, [tomb]);
  useEffect(() => {
    reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  async function save(
    organizationId: string,
    redirects: string,
    scopes: string,
    scopeRoles: LocalScopeRoles[],
    remove = false,
  ) {
    if (!state || busy) return false;
    if (document.activeElement instanceof HTMLElement)
      focusSource.current = document.activeElement;
    setBusy(true);
    setError("");
    try {
      const next = await configureLocalApplication(
        tomb,
        state.revision,
        applicationId,
        remove
          ? null
          : {
              applicationId,
              organizationId,
              redirectUris: redirects
                .split("\n")
                .map((uri) => uri.trim())
                .filter(Boolean),
              scopes: scopes.trim().split(/\s+/).filter(Boolean),
              scopeRoles,
            },
      );
      setState(next);
      return true;
    } catch (failure) {
      setError(
        failure instanceof LocalDirectoryError
          ? failure.message
          : "Could not save registration. Check vault storage and retry; your draft is retained.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  return {
    state,
    error,
    busy,
    save,
    reload,
  };
}

function RegistrationEditor({
  tomb,
  applicationId,
  directory,
  disabled,
  onRemoved,
}: Props & { onRemoved: () => void }) {
  const model = useRegistration(tomb, applicationId);
  const registration = model.state?.applications.find(
    (app) => app.applicationId === applicationId,
  );
  const [removing, setRemoving] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  return (
    <div aria-busy={model.busy}>
      <p className="hint">
        Bind this application to an organization and exact callbacks.
        Registration alone grants no sign-in or resource access.
      </p>
      {model.state ? (
        <output>
          {registration
            ? "Registered locally. Access still requires authorization."
            : "Not registered for local application access."}
        </output>
      ) : null}
      {model.error ? (
        <p role="alert" className="note note--err">
          {model.error}
        </p>
      ) : null}
      {!model.state && !model.error ? (
        <output>Loading registration…</output>
      ) : null}
      {model.state ? (
        <RegistrationForm
          model={model}
          applicationId={applicationId}
          directory={directory}
          disabled={disabled}
        />
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={model.busy}
          onClick={model.reload}
        >
          Reload registration
        </button>
        {registration ? (
          <>
            <button
              ref={removeButton}
              type="button"
              className="btn btn--sm btn--danger"
              disabled={model.busy}
              onClick={() => {
                if (!removing) {
                  setRemoving(true);
                  return;
                }
                void model.save("", "", "", [], true).then((saved) => {
                  if (saved) {
                    setRemoving(false);
                    onRemoved();
                  }
                });
              }}
            >
              {removing ? "Confirm removal" : "Remove registration"}
            </button>
            {removing ? (
              <button
                type="button"
                className="btn btn--sm"
                disabled={model.busy}
                onClick={() => {
                  setRemoving(false);
                  removeButton.current?.focus();
                }}
              >
                Keep registration
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function registrationDraft(saved: LocalApplication | undefined) {
  return {
    organizationId: saved?.organizationId ?? "",
    redirects: saved?.redirectUris.join("\n") ?? "",
    scopes: saved?.scopes.join(" ") ?? "openid",
    scopeRoles:
      saved?.scopeRoles ?? defaultScopeRoles(saved?.scopes ?? ["openid"]),
  };
}

function RegistrationForm({
  model,
  applicationId,
  directory,
  disabled,
}: {
  model: ReturnType<typeof useRegistration>;
  applicationId: string;
  directory: LocalDirectory;
  disabled: boolean;
}) {
  const id = useId();
  const saved = model.state?.applications.find(
    (app) => app.applicationId === applicationId,
  );
  const [draft, setDraft] = useState(() => registrationDraft(saved));
  const { organizationId, redirects, scopes, scopeRoles } = draft;
  useEffect(() => {
    setDraft(registrationDraft(saved));
  }, [saved]);
  const organizations = directory.entries.filter(
    (entry) =>
      entry.kind === "organization" &&
      entry.enabled &&
      directory.memberships.some(
        (row) => row.organizationId === entry.id && row.role === "owner",
      ),
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const policy = defaultScopeRoles(
          scopes.trim().split(/\s+/).filter(Boolean),
        ).map(
          (fallback) =>
            scopeRoles.find((row) => row.scope === fallback.scope) ?? fallback,
        );
        void model.save(organizationId, redirects, scopes, policy);
      }}
    >
      <fieldset disabled={disabled || model.busy}>
        <legend>Local application configuration</legend>
        <OrganizationField
          id={id}
          organizations={organizations}
          value={organizationId}
          onChange={(organizationId) => setDraft({ ...draft, organizationId })}
        />
        <div className="field">
          <label className="label" htmlFor={`${id}-redirects`}>
            Redirect URIs (one per line)
          </label>
          <textarea
            id={`${id}-redirects`}
            required
            rows={3}
            maxLength={32768}
            spellCheck={false}
            value={redirects}
            onChange={(event) =>
              setDraft({ ...draft, redirects: event.target.value })
            }
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-scopes`}>
            Allowed scopes (space separated)
          </label>
          <input
            id={`${id}-scopes`}
            required
            maxLength={2079}
            spellCheck={false}
            value={scopes}
            onChange={(event) =>
              setDraft({ ...draft, scopes: event.target.value })
            }
          />
        </div>
        <ScopeRolesField
          scopes={scopes}
          value={scopeRoles}
          onChange={(scopeRoles) => setDraft({ ...draft, scopeRoles })}
        />
        <p className="hint">
          Use exact HTTPS callbacks, or HTTP on loopback for development.
          Include openid. No client secret is stored in an application.
        </p>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={!organizationId || !redirects.trim() || !scopes.trim()}
        >
          {model.busy ? "Saving…" : "Save registration"}
        </button>
      </fieldset>
    </form>
  );
}

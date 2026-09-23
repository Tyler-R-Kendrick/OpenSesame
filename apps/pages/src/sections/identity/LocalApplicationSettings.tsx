import type { EditorMode } from "@opensesame/app-core/lib/configuration/draft.js";
import {
  type LocalScopeRoles,
  defaultScopeRoles,
} from "@opensesame/app-core/lib/local-application-policy.js";
import {
  type LocalApplication,
  type LocalApplications,
  configureLocalApplication,
  readLocalApplications,
} from "@opensesame/app-core/lib/local-applications.js";
import {
  type LocalDirectory,
  LocalDirectoryError,
} from "@opensesame/app-core/lib/local-directory.js";
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconCheck } from "../../components/Icons.js";
import { ModeToggle } from "../../components/configuration/ModeToggle.js";
import { ApplicationSetupCard } from "./ApplicationSetupCard.js";
import { ApplicationSourceEditor } from "./ApplicationSourceEditor.js";
import {
  OrganizationField,
  ScopeRolesField,
} from "./LocalApplicationFields.js";
import { RegistrationExtras } from "./RegistrationExtras.js";

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
  const [mode, setMode] = useState<EditorMode>("visual");
  const removeButton = useRef<HTMLButtonElement>(null);
  return (
    <div aria-busy={model.busy}>
      <ModeToggle mode={mode} onMode={setMode} />
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
      {model.state && mode === "visual" ? (
        <RegistrationForm
          model={model}
          applicationId={applicationId}
          directory={directory}
          disabled={disabled}
        />
      ) : null}
      {model.state && mode === "source" ? (
        <ApplicationSourceEditor
          applicationId={applicationId}
          revision={model.state.revision}
          registration={registration}
          disabled={disabled || model.busy}
          onApply={(registration) =>
            model.save(
              registration.organizationId,
              registration.redirectUris.join("\n"),
              registration.scopes.join(" "),
              defaultScopeRoles(registration.scopes),
            )
          }
        />
      ) : null}
      <RegistrationActions
        busy={model.busy}
        registered={Boolean(registration)}
        removing={removing}
        removeButton={removeButton}
        onReload={model.reload}
        onRemove={() => {
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
        onKeep={() => {
          setRemoving(false);
          removeButton.current?.focus();
        }}
      />
      <ApplicationSetupCard registration={registration} />
      <RegistrationExtras
        tomb={tomb}
        registration={registration}
        revision={model.state?.revision}
      />
    </div>
  );
}

function RegistrationActions(props: {
  busy: boolean;
  registered: boolean;
  removing: boolean;
  removeButton: RefObject<HTMLButtonElement | null>;
  onReload: () => void;
  onRemove: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="actions">
      <button
        type="button"
        className="btn btn--sm"
        disabled={props.busy}
        onClick={props.onReload}
      >
        Reload registration
      </button>
      {props.registered ? (
        <>
          <button
            ref={props.removeButton}
            type="button"
            className="btn btn--sm btn--danger"
            disabled={props.busy}
            onClick={props.onRemove}
          >
            {props.removing ? "Confirm removal" : "Remove registration"}
          </button>
          {props.removing ? (
            <button
              type="button"
              className="btn btn--sm"
              disabled={props.busy}
              onClick={props.onKeep}
            >
              Keep registration
            </button>
          ) : null}
        </>
      ) : null}
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
        <FormCommit
          label="Save registration"
          disabled={!organizationId || !redirects.trim() || !scopes.trim()}
        />
      </fieldset>
    </form>
  );
}

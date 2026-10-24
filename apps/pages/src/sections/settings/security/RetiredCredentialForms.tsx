import { isProtectorUnlockMethod } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import type {
  LocalRetiredCommand,
  LocalVaultFactorRoute,
  LocalVaultPrimary,
} from "@opensesame/vault-core/local-vault-security.js";
import { useState } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconMail } from "../../../components/Icons.js";

export function RetiredPrimaryForm({
  methods,
  busy,
  submit,
}: {
  methods: readonly string[];
  busy: boolean;
  submit: (primary: LocalVaultPrimary) => void;
}) {
  const [method, setMethod] = useState(methods[0] ?? "password");
  const [secret, setSecret] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const primary: LocalVaultPrimary =
          method === "passkey"
            ? { kind: "passkey" }
            : isProtectorUnlockMethod(method)
              ? {
                  kind: "protector",
                  method,
                  secret: method === "agePasskey" ? undefined : secret,
                }
              : { kind: method === "pin" ? "pin" : "password", secret };
        setSecret("");
        submit(primary);
      }}
    >
      <label>
        Current key
        <select
          value={method}
          disabled={busy}
          onChange={(event) => {
            setMethod(event.target.value);
            setSecret("");
          }}
        >
          {methods.map((name) => (
            <option key={name} value={name}>
              {name === "pin"
                ? "PIN"
                : name === "passkey"
                  ? "Passkey"
                  : name === "password"
                    ? "Password"
                    : name === "recovery"
                      ? "Recovery key"
                      : name === "age"
                        ? "age identity"
                        : "age passkey"}
            </option>
          ))}
        </select>
      </label>
      {method !== "passkey" && method !== "agePasskey" ? (
        <FieldShell
          label={primarySecretLabel(method)}
          type="password"
          autoComplete="current-password"
          value={secret}
          onValueChange={setSecret}
          disabled={busy}
        />
      ) : null}
      <FormCommit
        label="Verify current key"
        disabled={
          busy || (method !== "passkey" && method !== "agePasskey" && !secret)
        }
        busy={busy}
      />
    </form>
  );
}
export function RetiredFactorForm({
  routes,
  busy,
  complete,
  send,
}: {
  routes: readonly LocalVaultFactorRoute[];
  busy: boolean;
  complete: (kind: "totp" | "remote" | "recovery", code: string) => void;
  send: (channel: "email" | "sms") => void;
}) {
  const [route, setRoute] = useState<LocalVaultFactorRoute>(
    routes[0] ?? "totp",
  );
  const [code, setCode] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const value = code;
        setCode("");
        complete(
          route === "email" || route === "sms" ? "remote" : route,
          value,
        );
      }}
    >
      <label>
        Second step
        <select
          value={route}
          disabled={busy}
          onChange={(event) => {
            const next = routes.find((name) => name === event.target.value);
            if (next) setRoute(next);
          }}
        >
          {routes.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {route === "email" || route === "sms" ? (
        <button
          className="icon-btn"
          aria-label={`Send ${route === "email" ? "email" : "text"} code`}
          title={`Send ${route === "email" ? "email" : "text"} code`}
          type="button"
          disabled={busy}
          onClick={() => send(route)}
        >
          <IconMail size={18} />
        </button>
      ) : null}
      <FieldShell
        label="Verification code"
        autoComplete="one-time-code"
        value={code}
        onValueChange={setCode}
        disabled={busy}
      />
      <FormCommit
        label="Verify second step"
        disabled={busy || !code}
        busy={busy}
      />
    </form>
  );
}
export function RetiredEnrollmentForm({
  busy,
  choose,
}: { busy: boolean; choose: (command: LocalRetiredCommand) => void }) {
  const [password, setPassword] = useState("");
  const [days, setDays] = useState("90");
  const [synthetic, setSynthetic] = useState(false);
  const [consent, setConsent] = useState(false);
  const retention = Number(days);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        choose({
          kind: "change",
          change: {
            type: "enroll",
            password,
            response: synthetic ? "synthetic_decoy" : "reject",
            retentionMs: retention * 86400000,
          },
        });
        setPassword("");
      }}
    >
      <FieldShell
        label="Retired password"
        type="password"
        autoComplete="off"
        value={password}
        onValueChange={setPassword}
        disabled={busy}
      />
      <FieldShell
        label="Retention in days (1–90)"
        value={days}
        inputMode="numeric"
        onValueChange={setDays}
        disabled={busy}
      />
      <label className="check">
        <input
          type="checkbox"
          checked={synthetic}
          onChange={(event) => {
            setSynthetic(event.target.checked);
            setConsent(false);
          }}
          disabled={busy}
        />
        <span>Open a synthetic vault when this password is used</span>
      </label>
      {synthetic ? (
        <label className="check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            disabled={busy}
          />
          <span>
            I understand this creates fictional items and never grants access to
            my vault or connected services.
          </span>
        </label>
      ) : (
        <p>Use is recorded and access is refused.</p>
      )}
      <FormCommit
        label="Add retired password"
        disabled={
          busy ||
          !password ||
          !Number.isInteger(retention) ||
          retention < 1 ||
          retention > 90 ||
          (synthetic && !consent)
        }
        busy={busy}
      />
    </form>
  );
}

function primarySecretLabel(method: string) {
  if (method === "pin") return "Current PIN";
  if (method === "recovery") return "Recovery key";
  if (method === "age") return "age identity";
  return "Current password";
}

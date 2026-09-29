/**
 * Settings › Security — age key inventory (typage), not a Connections broker.
 *
 * Configures recipients and the sealed identity for age documents. Browser
 * crypto is FiloSottile typage (`age-encryption`). A key that protects the
 * vault itself is enrolled under Vault key protection, never sealed here.
 */

import {
  type AgeKeyConfig,
  generateAgeKeyPair,
  proveAgeKeyRoundTrip,
  readAgeKeyConfig,
  writeAgeKeyConfig,
} from "@opensesame/app-core/lib/age-keys.js";
import { type FormEvent, useEffect, useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import { IconCheck, IconRefresh, IconSecret } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { StatusNote } from "../../components/StatusNote.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

type Flash = { tone: "ok" | "warn" | "err"; text: string } | null;

export const ageKeysPanelDependencies = {
  readAgeKeyConfig,
  writeAgeKeyConfig,
  generateAgeKeyPair,
  proveAgeKeyRoundTrip,
};

export function AgeKeysPanel() {
  const { tomb } = useVault();
  const panelRef = useGuideTarget<HTMLElement>("settings.age-keys");
  const [config, setConfig] = useState<AgeKeyConfig>({
    recipients: [],
    identity: null,
    identities: [],
  });
  const [recipientsText, setRecipientsText] = useState("");
  const [importIdentity, setImportIdentity] = useState("");
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!tomb) {
      setConfig({ recipients: [], identity: null, identities: [] });
      setRecipientsText("");
      return;
    }
    let cancelled = false;
    void ageKeysPanelDependencies
      .readAgeKeyConfig(tomb)
      .then((next) => {
        if (cancelled) return;
        setConfig(next);
        setRecipientsText(next.recipients.join("\n"));
      })
      // A tomb whose key is not held yet reads as no keys, not as a crash.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tomb]);

  async function saveRecipients(event: FormEvent) {
    event.preventDefault();
    if (!tomb) {
      setFlash({ tone: "warn", text: "Unlock a vault to seal age keys." });
      return;
    }
    setBusy(true);
    setFlash(null);
    try {
      const recipients = recipientsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const next = await ageKeysPanelDependencies.writeAgeKeyConfig(tomb, {
        recipients,
        identity: config.identity,
      });
      setConfig(next);
      setRecipientsText(next.recipients.join("\n"));
      setFlash({ tone: "ok", text: "Age recipients sealed on this device." });
    } catch (caught) {
      setFlash({
        tone: "err",
        text:
          caught instanceof Error
            ? caught.message
            : "Could not save recipients.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function mintIdentity() {
    if (!tomb) {
      setFlash({ tone: "warn", text: "Unlock a vault to seal age keys." });
      return;
    }
    setBusy(true);
    setFlash(null);
    try {
      const pair = await ageKeysPanelDependencies.generateAgeKeyPair();
      const recipients = config.recipients.includes(pair.recipient)
        ? config.recipients
        : [...config.recipients, pair.recipient];
      const next = await ageKeysPanelDependencies.writeAgeKeyConfig(tomb, {
        recipients,
        identity: pair.identity,
      });
      setConfig(next);
      setRecipientsText(next.recipients.join("\n"));
      setImportIdentity("");
      setFlash({
        tone: "ok",
        text: "New age identity sealed. Matching recipient added.",
      });
    } catch (caught) {
      setFlash({
        tone: "err",
        text:
          caught instanceof Error ? caught.message : "Could not mint identity.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function sealImportedIdentity(event: FormEvent) {
    event.preventDefault();
    if (!tomb) {
      setFlash({ tone: "warn", text: "Unlock a vault to seal age keys." });
      return;
    }
    setBusy(true);
    setFlash(null);
    try {
      const next = await ageKeysPanelDependencies.writeAgeKeyConfig(tomb, {
        recipients: config.recipients,
        identity: importIdentity.trim(),
      });
      setConfig(next);
      setImportIdentity("");
      setFlash({ tone: "ok", text: "Imported age identity sealed." });
    } catch (caught) {
      setFlash({
        tone: "err",
        text:
          caught instanceof Error
            ? caught.message
            : "Could not import identity.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function prove() {
    setBusy(true);
    setFlash(null);
    try {
      const ok = await ageKeysPanelDependencies.proveAgeKeyRoundTrip(config);
      setFlash(
        ok
          ? { tone: "ok", text: "typage encrypt/decrypt round-trip succeeded." }
          : {
              tone: "warn",
              text: "Need both a sealed identity and at least one recipient.",
            },
      );
    } catch (caught) {
      setFlash({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Round-trip failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  // Age keys are sealed into a vault. Without one (a guest, a locked device)
  // every control here would be disabled, so none is drawn.
  if (!tomb) return null;

  return (
    <section className="panel" id="age-keys" ref={panelRef}>
      <div className="panel__head">
        <div>
          <h2>Age keys</h2>
        </div>
        <div className="actions">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            disabled={!tomb || busy}
            aria-label="Prove round-trip"
            title="Prove round-trip"
            onClick={() => void prove()}
          >
            <IconCheck size={16} />
          </button>
        </div>
      </div>
      <div className="panel__body">
        {flash ? <StatusNote message={flash} /> : null}
        <form onSubmit={(event) => void saveRecipients(event)}>
          <div className="keyed-field">
            <label htmlFor="age-recipients">Recipients</label>
            <textarea
              id="age-recipients"
              className="f__input--mono"
              rows={3}
              spellCheck={false}
              value={recipientsText}
              disabled={!tomb || busy}
              onChange={(event) => setRecipientsText(event.target.value)}
            />
            <p className="hint">
              One age1… or ssh-… recipient per line. Public; sealed with the
              vault.
            </p>
            <div className="actions">
              <button
                type="submit"
                className="icon-btn icon-btn--sm"
                disabled={!tomb || busy}
                aria-label="Save recipients"
                title="Save recipients"
              >
                <IconCheck size={16} />
              </button>
            </div>
          </div>
        </form>

        <div className="keyed-row">
          <span className="label">Identity</span>
          <div className="actions">
            {config.identity ? (
              <StatusMark tone="ok" label="Identity sealed" />
            ) : (
              <StatusMark tone="idle" label="No identity" />
            )}
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              disabled={!tomb || busy}
              aria-label="Generate identity"
              title="Generate identity"
              onClick={() => void mintIdentity()}
            >
              <IconRefresh size={16} />
            </button>
          </div>
        </div>

        <form onSubmit={(event) => void sealImportedIdentity(event)}>
          <FieldShell
            id="age-identity-import"
            label="Import identity"
            type="password"
            autoComplete="off"
            lead={<IconSecret size={17} />}
            mono
            placeholder="AGE-SECRET-KEY-1…"
            value={importIdentity}
            disabled={!tomb || busy}
            onValueChange={setImportIdentity}
            hint="Paste AGE-SECRET-KEY-… once. Sealed immediately; never shown again."
            tail={
              <button
                type="submit"
                className="icon-btn icon-btn--sm"
                disabled={!tomb || busy || importIdentity.trim().length === 0}
                aria-label="Seal identity"
                title="Seal identity"
              >
                <IconCheck size={16} />
              </button>
            }
          />
        </form>
      </div>
    </section>
  );
}

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { IconAlert, IconCheck } from "../../components/Icons.js";
import {
  type ChangelogEvent,
  formatChangelogSummary,
  listHostChangelogPage,
} from "../../lib/changelog.js";
import {
  ensureHostSession,
  hostLocalSessionEligible,
  useIdentitySession,
} from "../../lib/identity.js";
import {
  type ConfigCompare,
  type ConfigKeyMeta,
  type ConfigSecretVersion,
  type SecretConfig,
  branchConfig,
  compareConfigs,
  deleteConfigSecret,
  formatConfigSummary,
  listConfigKeys,
  listConfigSecretVersions,
  listSecretConfigs,
  putConfigSecrets,
  rollbackConfigSecret,
} from "../../lib/secret-configs.js";
import { loadSettings } from "../../lib/settings.js";
import { useOnline } from "../../lib/use-online.js";

type Flash = { tone: "ok" | "err" | "warn"; text: string };

const CHANGELOG_PAGE_SIZE = 20;

/**
 * Project-config secrets for the active project (ADR 0052 / WP-12).
 *
 * The set-input is write-only UI: the masked value goes up once and is
 * cleared on submit. Everything rendered here is metadata — config views,
 * key names, version numbers — because the Host never returns a value.
 */
export function SecretConfigsPanel() {
  const online = useOnline();
  const session = useIdentitySession();
  const [projectId, setProjectId] = useState(
    () => loadSettings().activeProjectId?.trim() ?? "",
  );
  const [configs, setConfigs] = useState<SecretConfig[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [keys, setKeys] = useState<ConfigKeyMeta[]>([]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");

  const [versionsFor, setVersionsFor] = useState<{
    keyName: string;
    rows: ConfigSecretVersion[];
  } | null>(null);
  const [confirmRollback, setConfirmRollback] = useState<{
    keyName: string;
    version: number;
  } | null>(null);

  const [branchSlug, setBranchSlug] = useState("");
  const [compareWith, setCompareWith] = useState("");
  const [compared, setCompared] = useState<{
    a: string;
    b: string;
    diff: ConfigCompare;
  } | null>(null);

  const [events, setEvents] = useState<ChangelogEvent[]>([]);
  const [nextBeforeSeq, setNextBeforeSeq] = useState<number | null>(null);
  const [changelogLoaded, setChangelogLoaded] = useState(false);

  const refreshConfigs = useCallback(async () => {
    const project = projectId.trim();
    if (!online || !project) return;
    setLoading(true);
    setFlash(null);
    try {
      if (hostLocalSessionEligible() || session) {
        await ensureHostSession().catch(() => undefined);
      }
      const next = await listSecretConfigs(project);
      setConfigs(next);
      setSelectedId((prev) =>
        prev && next.some((row) => row.id === prev)
          ? prev
          : (next[0]?.id ?? ""),
      );
    } catch (error) {
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Could not load configs",
      });
    } finally {
      setLoading(false);
    }
  }, [online, projectId, session]);

  useEffect(() => {
    void refreshConfigs();
  }, [refreshConfigs]);

  const refreshKeys = useCallback(async () => {
    if (!selectedId) {
      setKeys([]);
      return;
    }
    try {
      setKeys(await listConfigKeys(selectedId));
    } catch (error) {
      setKeys([]);
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Could not load keys",
      });
    }
  }, [selectedId]);

  useEffect(() => {
    setVersionsFor(null);
    setConfirmRollback(null);
    setCompared(null);
    void refreshKeys();
  }, [refreshKeys]);

  async function onSetSecret(event: FormEvent) {
    event.preventDefault();
    const keyName = newKeyName.trim();
    if (!selectedId || !keyName || !newKeyValue) return;
    setBusy(true);
    setFlash(null);
    try {
      await putConfigSecrets(selectedId, { [keyName]: newKeyValue });
      setFlash({ tone: "ok", text: `Set ${keyName} — value not shown again` });
      setNewKeyName("");
      await refreshKeys();
    } catch (error) {
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Set failed",
      });
    } finally {
      // The write-only input never outlives the submit, success or not.
      setNewKeyValue("");
      setBusy(false);
    }
  }

  async function onUnset(keyName: string) {
    if (!selectedId) return;
    setBusy(true);
    setFlash(null);
    try {
      await deleteConfigSecret(selectedId, keyName);
      setFlash({ tone: "ok", text: `Unset ${keyName}` });
      if (versionsFor?.keyName === keyName) setVersionsFor(null);
      await refreshKeys();
    } catch (error) {
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Unset failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onShowVersions(keyName: string) {
    if (!selectedId) return;
    setBusy(true);
    setFlash(null);
    try {
      const rows = await listConfigSecretVersions(selectedId, keyName);
      setVersionsFor({ keyName, rows });
      setConfirmRollback(null);
    } catch (error) {
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Versions failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onRollback(keyName: string, version: number) {
    if (!selectedId) return;
    setBusy(true);
    setFlash(null);
    try {
      const rolled = await rollbackConfigSecret(selectedId, keyName, version);
      setConfirmRollback(null);
      await refreshKeys();
      await onShowVersions(keyName);
      setFlash({
        tone: "ok",
        text: `Rolled ${rolled.keyName} back to v${version} as new v${rolled.version}`,
      });
    } catch (error) {
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Rollback failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onBranch(event: FormEvent) {
    event.preventDefault();
    const slug = branchSlug.trim();
    if (!selectedId || !slug) return;
    setBusy(true);
    setFlash(null);
    try {
      const child = await branchConfig(selectedId, { slug });
      setConfigs((prev) => [...prev, child]);
      setBranchSlug("");
      setFlash({ tone: "ok", text: `Branched into ${child.slug}` });
    } catch (error) {
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Branch failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onCompare() {
    if (!selectedId || !compareWith) return;
    setBusy(true);
    setFlash(null);
    try {
      const diff = await compareConfigs(selectedId, compareWith);
      setCompared({ a: selectedId, b: compareWith, diff });
    } catch (error) {
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Compare failed",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onLoadChangelog(beforeSeq?: number) {
    const project = projectId.trim();
    if (!project) return;
    setBusy(true);
    setFlash(null);
    try {
      const page = await listHostChangelogPage(project, {
        limit: CHANGELOG_PAGE_SIZE,
        ...(beforeSeq === undefined ? undefined : { beforeSeq }),
      });
      setEvents((prev) =>
        beforeSeq === undefined ? page.events : [...prev, ...page.events],
      );
      setNextBeforeSeq(page.events.length === 0 ? null : page.nextBeforeSeq);
      setChangelogLoaded(true);
    } catch (error) {
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Changelog failed",
      });
    } finally {
      setBusy(false);
    }
  }

  const selected = configs.find((row) => row.id === selectedId);
  const others = configs.filter((row) => row.id !== selectedId);

  return (
    <section className="panel" aria-labelledby="secret-configs-heading">
      <div className="panel__head">
        <div>
          <h2 id="secret-configs-heading">Project configs</h2>
          <p>
            Doppler-parity secret configs for the active project. Values go up
            through a write-only intake and never come back — everything below
            is key names and version metadata.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          disabled={!online || loading || !projectId.trim()}
          onClick={() => void refreshConfigs()}
        >
          Refresh
        </button>
      </div>

      {!online ? (
        <output className="note note--warn">
          <IconAlert /> Offline — configs require Host.
        </output>
      ) : null}

      {flash ? (
        <p
          className={`note note--${flash.tone === "ok" ? "ok" : flash.tone === "warn" ? "warn" : "err"}`}
          role={flash.tone === "err" ? "alert" : "status"}
        >
          {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
          <span>{flash.text}</span>
        </p>
      ) : null}

      <div className="panel__body">
        <label className="field">
          <span>Project id</span>
          <input
            type="text"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="project_…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        {!projectId.trim() ? (
          <p className="hint">
            Set an active project (Connectivity → Active project) to manage its
            configs.
          </p>
        ) : configs.length === 0 && !loading ? (
          <p className="hint">
            No configs yet for this project. Create them via Host API (
            <code>POST /api/v1/projects/&lt;id&gt;/configs</code>).
          </p>
        ) : (
          <>
            <label className="field">
              <span>Config</span>
              <select
                aria-label="Config"
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {configs.map((config) => (
                  <option key={config.id} value={config.id}>
                    {formatConfigSummary(config)}
                  </option>
                ))}
              </select>
            </label>

            {selected ? (
              <>
                <h3>Keys</h3>
                {keys.length === 0 ? (
                  <p className="hint">No secrets in this config yet.</p>
                ) : (
                  <ul className="list">
                    {keys.map((key) => (
                      <li key={key.keyName} className="list__row">
                        <div>
                          <strong>
                            <code>{key.keyName}</code>
                          </strong>
                          <p className="hint">
                            v{key.version}
                            {key.updatedAt ? ` · ${key.updatedAt}` : null}
                          </p>
                        </div>
                        <div className="actions">
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={() => void onShowVersions(key.keyName)}
                          >
                            Versions
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={() => void onUnset(key.keyName)}
                          >
                            Unset
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {versionsFor ? (
                  <>
                    <h3>
                      History of <code>{versionsFor.keyName}</code>
                    </h3>
                    <ul className="list">
                      {versionsFor.rows.map((row) => (
                        <li
                          key={`${versionsFor.keyName}:${row.version}`}
                          className="list__row"
                        >
                          <div>
                            <strong>v{row.version}</strong>
                            <p className="hint">
                              {row.deleted ? "deleted · " : ""}
                              {row.createdAt}
                              {row.actorId ? ` · ${row.actorId}` : null}
                            </p>
                          </div>
                          <div className="actions">
                            {confirmRollback &&
                            confirmRollback.keyName === versionsFor.keyName &&
                            confirmRollback.version === row.version ? (
                              <>
                                <button
                                  type="button"
                                  className="btn btn--danger"
                                  disabled={busy}
                                  onClick={() =>
                                    void onRollback(
                                      versionsFor.keyName,
                                      row.version,
                                    )
                                  }
                                >
                                  Confirm rollback
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--ghost"
                                  onClick={() => setConfirmRollback(null)}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn"
                                disabled={busy || row.deleted}
                                onClick={() =>
                                  setConfirmRollback({
                                    keyName: versionsFor.keyName,
                                    version: row.version,
                                  })
                                }
                              >
                                Rollback to v{row.version}
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}

                <form
                  className="set__inline"
                  onSubmit={(event) => void onSetSecret(event)}
                >
                  <div className="field set__inline-grow">
                    <label htmlFor="secret-config-key">Key name</label>
                    <input
                      id="secret-config-key"
                      value={newKeyName}
                      placeholder="DATABASE_URL"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setNewKeyName(event.target.value)}
                    />
                  </div>
                  <div className="field set__inline-grow">
                    <label htmlFor="secret-config-value">
                      Value (write-only)
                    </label>
                    <input
                      id="secret-config-value"
                      type="password"
                      value={newKeyValue}
                      autoComplete="off"
                      onChange={(event) => setNewKeyValue(event.target.value)}
                    />
                  </div>
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={busy || !newKeyName.trim() || !newKeyValue}
                  >
                    Set secret
                  </button>
                </form>

                <form
                  className="set__inline"
                  onSubmit={(event) => void onBranch(event)}
                >
                  <div className="field set__inline-grow">
                    <label htmlFor="secret-config-branch">
                      Branch into child config
                    </label>
                    <input
                      id="secret-config-branch"
                      value={branchSlug}
                      placeholder="dev-yourname"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setBranchSlug(event.target.value)}
                    />
                  </div>
                  <button
                    type="submit"
                    className="btn"
                    disabled={busy || !branchSlug.trim()}
                  >
                    Branch
                  </button>
                </form>

                {others.length > 0 ? (
                  <div className="set__inline">
                    <div className="field set__inline-grow">
                      <label htmlFor="secret-config-compare">
                        Compare with
                      </label>
                      <select
                        id="secret-config-compare"
                        value={compareWith}
                        onChange={(event) => setCompareWith(event.target.value)}
                      >
                        <option value="">Pick a config…</option>
                        {others.map((config) => (
                          <option key={config.id} value={config.id}>
                            {formatConfigSummary(config)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !compareWith}
                      onClick={() => void onCompare()}
                    >
                      Compare
                    </button>
                  </div>
                ) : null}

                {compared ? (
                  <div>
                    <h3>Compare (presence + versions only)</h3>
                    <p className="hint">
                      Only in this config:{" "}
                      {compared.diff.onlyInA.length > 0
                        ? compared.diff.onlyInA.join(", ")
                        : "none"}
                    </p>
                    <p className="hint">
                      Only in the other:{" "}
                      {compared.diff.onlyInB.length > 0
                        ? compared.diff.onlyInB.join(", ")
                        : "none"}
                    </p>
                    {compared.diff.inBoth.length > 0 ? (
                      <ul className="list">
                        {compared.diff.inBoth.map((entry) => (
                          <li key={entry.keyName}>
                            <code>{entry.keyName}</code> — v{entry.aVersion} vs
                            v{entry.bVersion}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        )}

        {projectId.trim() ? (
          <div>
            <h3>Change log</h3>
            {events.length > 0 ? (
              <ul className="list">
                {events.map((event) => (
                  <li key={event.id}>
                    <div>
                      <strong>{formatChangelogSummary(event)}</strong>
                      <div className="muted">
                        {event.occurredAt}
                        {event.actorId ? ` · ${event.actorId}` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : changelogLoaded ? (
              <p className="hint">No changelog events yet.</p>
            ) : null}
            <div className="actions">
              {!changelogLoaded ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void onLoadChangelog()}
                >
                  Load change log
                </button>
              ) : nextBeforeSeq !== null ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void onLoadChangelog(nextBeforeSeq)}
                >
                  Load older
                </button>
              ) : (
                <span className="hint">No older events.</span>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

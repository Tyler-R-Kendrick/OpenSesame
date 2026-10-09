import { readLinearConnector } from "@opensesame/app-core/lib/linear-connectors.js";
import { invokeLinearConnector } from "@opensesame/app-core/lib/linear-operations.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { z } from "zod";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconEye, IconPlus, IconRefresh } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { SelectField } from "./fields.js";

const ResultItem = z.object({
  id: z.string(),
  title: z.string().optional(),
  name: z.string().optional(),
  identifier: z.string().optional(),
  url: z.string().optional(),
});
const Teams = z.array(
  z.object({ id: z.string(), name: z.string(), key: z.string() }),
);
type Item = z.infer<typeof ResultItem>;

function resultUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "linear.app" || url.hostname.endsWith(".linear.app"))
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function useLinearFields() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [resultLabel, setResultLabel] = useState("");
  const [teams, setTeams] = useState<z.infer<typeof Teams>>([]);
  const [teamId, setTeamId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  return {
    busy,
    setBusy,
    failure,
    setFailure,
    items,
    setItems,
    resultLabel,
    setResultLabel,
    teams,
    setTeams,
    teamId,
    setTeamId,
    title,
    setTitle,
    description,
    setDescription,
  };
}

function useLinearActions(
  connectorId: string,
  onFlash: (flash: Flash) => void,
  onChanged?: () => void,
) {
  const grant = readLinearConnector(connectorId);
  const [actor, setActor] = useState<"app" | "user">(
    grant?.app ? "app" : "user",
  );
  const fields = useLinearFields();
  const actors = actorChoices(grant);
  const identity = grant?.[actor];
  const canRead =
    identity?.kind === "api-key" || identity?.grantedScopes.includes("read");
  const canCreate =
    identity?.kind === "api-key" ||
    identity?.grantedScopes.some(
      (scope) => scope === "write" || scope === "issues:create",
    );

  async function run(
    operation: "issues.list" | "projects.list" | "teams.list" | "issue.create",
  ) {
    if (fields.busy) return;
    fields.setBusy(true);
    fields.setFailure(null);
    fields.setResultLabel("");
    try {
      const result = await invokeLinearConnector(
        connectorId,
        operation,
        operation === "issue.create"
          ? {
              teamId: fields.teamId,
              title: fields.title,
              description: fields.description,
            }
          : {},
        actor,
      );
      if (operation === "teams.list") {
        const found = Teams.parse(result);
        fields.setTeams(found);
        fields.setTeamId(found[0]?.id ?? "");
        if (found.length === 0) {
          fields.setFailure("Linear returned no accessible teams.");
          onFlash({
            tone: "err",
            text: "Linear returned no accessible teams.",
          });
        } else onFlash({ tone: "ok", text: "Linear teams loaded." });
      } else {
        const found =
          operation === "issue.create"
            ? [ResultItem.parse(result)]
            : z.array(ResultItem).parse(result);
        fields.setItems(found);
        fields.setResultLabel(
          operation === "issue.create"
            ? "Issue created in Linear"
            : operation === "issues.list"
              ? "Linear issues"
              : "Linear projects",
        );
        if (operation === "issue.create") {
          fields.setTitle("");
          fields.setDescription("");
        }
        onFlash({ tone: "ok", text: "Linear operation completed." });
      }
    } catch (error) {
      const text =
        error instanceof z.ZodError
          ? "Linear returned an invalid operation result."
          : errorText(error);
      fields.setFailure(text);
      onFlash({ tone: "err", text });
    } finally {
      fields.setBusy(false);
      onChanged?.();
    }
  }

  return { ...fields, actor, setActor, actors, canRead, canCreate, run };
}
type Model = ReturnType<typeof useLinearActions>;

function LinearIssueInputs({ model }: { model: Model }) {
  const {
    teams,
    teamId,
    setTeamId,
    title,
    setTitle,
    description,
    setDescription,
    canCreate,
    canRead,
    run,
  } = model;
  return (
    <>
      <details className="cx-application">
        <summary>Create a Linear issue</summary>
        <div className="cx-form">
          <div className="keyed-row">
            <span>Linear teams</span>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Load Linear teams"
              title={
                canRead ? "Load Linear teams" : "Linear read scope required"
              }
              disabled={!canRead}
              onClick={() => void run("teams.list")}
            >
              <IconRefresh size={16} />
            </button>
          </div>
          {teams.length > 0 ? (
            <SelectField
              label="Linear team"
              value={teamId}
              options={teams.map((team) => ({
                id: team.id,
                label: `${team.name} (${team.key})`,
              }))}
              onChange={setTeamId}
            />
          ) : null}
          <FieldShell
            label="Issue title"
            value={title}
            onValueChange={setTitle}
          />
          <label className="cx-select">
            <span className="f__label">Issue description</span>
            <textarea
              className="cx-textarea"
              value={description}
              maxLength={100_000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <FormCommit
            label="Create issue in Linear"
            icon={<IconPlus size={18} />}
            disabled={!canCreate || !teamId || !title.trim()}
            onClick={() => void run("issue.create")}
          />
        </div>
      </details>
    </>
  );
}
function LinearActionInputs({ model }: { model: Model }) {
  const {
    actor,
    setActor,
    actors,
    busy,
    setTeams,
    setTeamId,
    setItems,
    setResultLabel,
    setFailure,
    canRead,
    canCreate,
    run,
  } = model;
  return (
    <>
      <fieldset className="cx-block cx-form" disabled={busy}>
        <legend className="visually-hidden">Linear operations</legend>
        <SelectField
          label="Act as"
          value={actor}
          options={actors}
          onChange={(next) => {
            setActor(next);
            setTeams([]);
            setTeamId("");
            setItems([]);
            setResultLabel("");
            setFailure(null);
          }}
        />
        <div className="panel__head">
          <h3>Linear records</h3>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Read Linear issues"
            title={
              canRead ? "Read Linear issues" : "Linear read scope required"
            }
            disabled={!canRead}
            onClick={() => void run("issues.list")}
          >
            <IconEye size={16} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Read Linear projects"
            title={
              canRead ? "Read Linear projects" : "Linear read scope required"
            }
            disabled={!canRead}
            onClick={() => void run("projects.list")}
          >
            <IconEye size={16} />
          </button>
        </div>
        <LinearIssueInputs model={model} />
        {!canRead ? (
          <StatusMark tone="warn" label="Linear read scope required" />
        ) : null}
        {!canCreate ? (
          <StatusMark
            tone="warn"
            label="Linear write or issues:create scope required"
          />
        ) : null}
      </fieldset>
    </>
  );
}
function LinearResults({
  items,
  resultLabel,
}: Pick<Model, "items" | "resultLabel">) {
  return (
    <>
      {resultLabel ? (
        <section aria-label={resultLabel}>
          <output>
            {resultLabel}
            {items.length === 0 ? ": none found" : ""}
          </output>
          <ul>
            {items.map((item) => {
              const label = `${item.identifier ? `${item.identifier} · ` : ""}${item.title ?? item.name ?? item.id}`;
              const url = resultUrl(item.url);
              return (
                <li key={item.id}>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer noopener">
                      {label}
                    </a>
                  ) : (
                    label
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}
export function LinearActions({
  connectorId,
  onFlash,
  onChanged,
}: {
  connectorId: string;
  onFlash: (flash: Flash) => void;
  onChanged?: () => void;
}) {
  const model = useLinearActions(connectorId, onFlash, onChanged);
  if (model.actors.length === 0) return null;
  return (
    <section className="cx-block cx-form" aria-label="Use Linear">
      <h3>Use Linear</h3>
      <LinearActionInputs model={model} />
      {model.busy ? <output>Waiting for Linear…</output> : null}
      {model.failure ? <StatusMark tone="err" label={model.failure} /> : null}
      <LinearResults items={model.items} resultLabel={model.resultLabel} />
    </section>
  );
}

function actorChoices(grant: ReturnType<typeof readLinearConnector>) {
  const actors: { id: "app" | "user"; label: string }[] = [];
  if (grant?.app)
    actors.push({
      id: "app",
      label: grant.app.kind === "api-key" ? "API key account" : "Application",
    });
  if (grant?.user) actors.push({ id: "user", label: "User" });
  return actors;
}

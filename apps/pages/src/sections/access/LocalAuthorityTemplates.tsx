import {
  type AudienceTemplate,
  listAudienceTemplates,
} from "@opensesame/os-domain/authority-templates";
import { StatusMark } from "../../components/StatusMark.js";
import {
  AccessDetail,
  AccessFact,
  AccessRecords,
  useAccessRecord,
} from "./AccessRecords.js";

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const hours = ms / (60 * 60 * 1000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** A claim's support is a status: a glyph whose sentence is its name. */
function SupportStatus({ status }: { status: string }) {
  return (
    <StatusMark
      tone={status === "unsupported" ? "idle" : "warn"}
      label={status.replaceAll("_", " ")}
    />
  );
}

function TemplateDetail({ template }: { template: AudienceTemplate }) {
  return (
    <>
      <AccessFact label="Summary" value={template.summary} />
      <AccessFact
        label="Vocabulary"
        value={[
          template.vocabulary.domain,
          template.vocabulary.participant,
          template.vocabulary.supervisor,
        ]
          .filter(Boolean)
          .join(" · ")}
      />
      <AccessFact
        label="Lifetime"
        value={`${template.defaults.lifetimeKind} · ${formatDuration(template.defaults.defaultLifetimeMs)} default · ${formatDuration(template.defaults.maxLifetimeMs)} maximum`}
      />
      <AccessFact label="Inheritance" value={template.defaults.inheritance} />
      <AccessFact
        label="Suggested verbs"
        value={template.defaults.suggestedVerbs.join(", ")}
      />
      <h3 className="access-policy-title">Support matrix</h3>
      <ul className="access-domain-list">
        {template.supportMatrix.map((claim) => (
          <li key={claim.id} className="access-domain-row">
            <div>
              <strong title={claim.note}>{claim.label}</strong>
              <SupportStatus status={claim.status} />
            </div>
          </li>
        ))}
      </ul>
      <AccessFact label="Workflow" value={template.workflowHints.join(" · ")} />
    </>
  );
}

/**
 * Lists declarative audience templates for ephemeral domain/session context.
 * Selection is local UI state only — not a grant ledger and not remote enforcement.
 */
export function LocalAuthorityTemplates() {
  const templates = listAudienceTemplates();
  const selection = useAccessRecord("local-authority-templates", "sessions");
  const selected = templates.find((template) => template.id === selection.id);
  return (
    <AccessRecords
      title="Audience templates"
      selection={selection}
      rows={templates.map((template) => ({
        id: template.id,
        label: template.label,
        extension: "template",
        to: selection.path(template.id),
      }))}
    >
      {selected ? (
        <AccessDetail title={selected.label} kind="Audience template">
          <TemplateDetail template={selected} />
        </AccessDetail>
      ) : null}
    </AccessRecords>
  );
}

import { useSearchParams } from "react-router";
import { IDENTITY_LABELS, IDENTITY_VIEWS } from "../lib/section-views.js";
import { SECTIONS, SectionRow, TreeRow } from "./RailRows.js";

export function IdentityTree({
  open,
  active,
  onToggle,
}: {
  open: boolean;
  active: boolean;
  onToggle: () => void;
}) {
  const [params] = useSearchParams();
  const view =
    IDENTITY_VIEWS.find((id) => id === params.get("view")) ?? "people";
  return (
    <>
      <SectionRow
        section={SECTIONS[3]}
        open={open}
        active={active}
        branch={open}
        onToggle={onToggle}
      />
      {open ? (
        <div className="railtree__kids">
          {IDENTITY_VIEWS.map((id) => (
            <TreeRow
              key={id}
              child
              to={`/identity?view=${id}`}
              selected={view === id}
              isActive={view === id}
            >
              <span className="railtree__name">{IDENTITY_LABELS[id]}</span>
            </TreeRow>
          ))}
        </div>
      ) : null}
    </>
  );
}

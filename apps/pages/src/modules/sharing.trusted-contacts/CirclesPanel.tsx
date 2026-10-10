/**
 * Settings › Trusted contacts › Circles (ADR 0186): the circles this vault's
 * owner keeps, each with its rule, how many contacts it has and where it
 * stands. The ceremonies that make and change one hang from here: the head's
 * key starts a circle, a row's key opens the circle it names, and each
 * ceremony is a sheet (`circles/`).
 *
 * Sheets are shown one at a time. A circle's sheet gives way to the ceremony
 * it opens and comes back when that closes, with the keyboard on the key that
 * opened it.
 */

import { useEffect, useRef, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { AskSheet } from "./circles/AskSheet.js";
import { CancelSheet } from "./circles/CancelSheet.js";
import { ChangeSheet } from "./circles/ChangeSheet.js";
import { CircleRow } from "./circles/CircleRow.js";
import { CircleSheet, type Sub } from "./circles/CircleSheet.js";
import { InviteMoreSheet } from "./circles/InviteMoreSheet.js";
import { NewCircleSheet } from "./circles/NewCircleSheet.js";
import { PacketsSheet } from "./circles/PacketsSheet.js";
import { landOnId } from "./circles/circle-focus.js";
import "./circles/circles.css";
import { PanelFrame, useSaid } from "./panel-frame.js";
import { circleFacts, circleMark, countText } from "./row-model.js";
import { type Desk, useDesk } from "./use-desk.js";

type View =
  | Readonly<{ kind: "new" }>
  | Readonly<{ kind: "circle"; circleId: string; returnTo?: Sub }>
  | Readonly<{ kind: Sub; circleId: string; digest?: string }>;

const HEAD_KEY = "circle-new";

function Sheet({
  desk,
  view,
  show,
  retired,
}: {
  desk: Desk;
  view: View;
  show: (next: View | null) => void;
  retired: () => void;
}) {
  if (view.kind === "new") {
    return <NewCircleSheet desk={desk} onClose={() => show(null)} />;
  }
  const { circleId } = view;
  const back = (returnTo: Sub): View => ({
    kind: "circle",
    circleId,
    returnTo,
  });
  switch (view.kind) {
    case "circle":
      return (
        <CircleSheet
          desk={desk}
          circleId={circleId}
          returnTo={view.returnTo}
          onOpen={(sub, digest) => show({ kind: sub, circleId, digest })}
          onClose={() => show(null)}
          onRetired={retired}
        />
      );
    case "packets":
      return (
        <PacketsSheet
          desk={desk}
          circleId={circleId}
          onClose={() => show(back("packets"))}
        />
      );
    case "invite":
      return (
        <InviteMoreSheet
          desk={desk}
          circleId={circleId}
          onClose={() => show(back("invite"))}
        />
      );
    case "change":
      return (
        <ChangeSheet
          desk={desk}
          circleId={circleId}
          onClose={() => show(back("change"))}
        />
      );
    case "ask":
      return (
        <AskSheet
          desk={desk}
          circleId={circleId}
          digest={view.digest}
          onClose={() => show(back("ask"))}
        />
      );
    case "cancel":
      return (
        <CancelSheet
          desk={desk}
          circleId={circleId}
          onClose={() => show(back("cancel"))}
        />
      );
  }
}

function Circles({ desk }: { desk: Desk }) {
  const said = useSaid(countText(desk.owned.length, "circle"));
  const [view, setView] = useState<View | null>(null);
  const opener = useRef(HEAD_KEY);
  const wasOpen = useRef(false);
  const guide = useGuideTarget<HTMLButtonElement>("circle.new");

  // A circle that is gone takes its sheets with it.
  const gone =
    view !== null &&
    view.kind !== "new" &&
    !desk.owned.some((r) => r.signedPolicy.policy.circleId === view.circleId);
  useEffect(() => {
    if (gone) setView(null);
  }, [gone]);

  // Closing the last sheet puts the keyboard back where the person came from,
  // unless it is somewhere already.
  useEffect(() => {
    if (view !== null) {
      wasOpen.current = true;
    } else if (wasOpen.current) {
      wasOpen.current = false;
      landOnId(opener.current);
    }
  }, [view]);

  function open(next: View, from: string): void {
    opener.current = from;
    setView(next);
  }

  return (
    <PanelFrame
      id="circles"
      title="Circles"
      target="settings.trusted-contacts-circles"
      said={said}
      keys={
        <IconKey
          id={HEAD_KEY}
          keyRef={guide}
          small
          label="Start a circle"
          onClick={() => open({ kind: "new" }, HEAD_KEY)}
        >
          <IconPlus size={15} />
        </IconKey>
      }
      overlay={
        view ? (
          <Sheet
            desk={desk}
            view={view}
            show={setView}
            retired={() => {
              opener.current = HEAD_KEY;
              setView(null);
            }}
          />
        ) : null
      }
    >
      {desk.owned.length === 0 ? (
        <div className="actions">
          <StatusMark tone="idle" label="No circles yet." />
        </div>
      ) : (
        <ul className="tc-rows">
          {desk.owned.map(({ signedPolicy, state }) => {
            const { circleId, label } = signedPolicy.policy;
            const mark = circleMark(state);
            const key = `tcc-open-${circleId}`;
            return (
              <CircleRow
                key={circleId}
                keyId={key}
                name={label}
                facts={circleFacts(signedPolicy.policy)}
                marks={<StatusMark tone={mark.tone} label={mark.label} />}
                onOpen={() => open({ kind: "circle", circleId }, key)}
              />
            );
          })}
        </ul>
      )}
    </PanelFrame>
  );
}

export function CirclesPanel() {
  const desk = useDesk();
  return desk ? <Circles desk={desk} /> : null;
}

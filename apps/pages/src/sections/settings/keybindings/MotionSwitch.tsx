import { useSyncExternalStore } from "react";
import { IconShake } from "../../../components/Icons.gestures.js";
import { IconCheck } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import {
  type MotionAccess,
  motionAccessSnapshot,
  requestMotionAccess,
  subscribeMotionAccess,
} from "../../../lib/gesture-motion.js";
import type { KeymapState } from "./useKeymap.js";

const label = "Gestures made by moving the phone";

/** What the motion switch says beside itself, or nothing. */
function Beside({ access }: { access: MotionAccess }) {
  if (access === "needs-permission") {
    const ask = "Allow this site to read the phone's motion";
    return (
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label={ask}
        title={ask}
        data-allow-motion=""
        onClick={() => void requestMotionAccess()}
      >
        <IconShake size={14} />
      </button>
    );
  }
  if (access === "denied") {
    return (
      <StatusMark
        tone="err"
        label="Motion is blocked for this site: allow it in the browser's site settings"
      />
    );
  }
  if (access === "granted") return <IconCheck size={14} />;
  return null;
}

/**
 * The motion switch (WCAG 2.5.4): gestures made by moving the phone can be
 * switched off. Absent where the browser has no motion sensor at all
 * (ADR 0158), and carrying its Allow key where the browser asks first.
 */
export function MotionSwitch({ state }: { state: KeymapState }) {
  const access = useSyncExternalStore(
    subscribeMotionAccess,
    motionAccessSnapshot,
    (): MotionAccess => "unsupported",
  );
  if (access === "unsupported") return null;
  const on = state.config.motion !== false;
  const next = on ? { ...state.config, motion: false } : withoutMotion(state);
  return (
    <div className="sw kb-single">
      <span className="sw__name">Shake</span>
      <span className="kb-single__end">
        {on ? <Beside access={access} /> : null}
        <button
          type="button"
          className="toggle"
          role="switch"
          aria-checked={on}
          aria-label={label}
          title={on ? label : "Off: a shake does nothing"}
          onClick={() => state.save(next)}
        />
      </span>
    </div>
  );
}

function withoutMotion({ config }: KeymapState) {
  const { motion: _motion, ...rest } = config;
  return rest;
}

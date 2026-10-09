import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  T_CLICK_MS,
  T_OPEN_MS,
} from "../../components/CipherDial/constants.js";
import {
  CipherDial,
  type CipherDialPhase,
} from "../../components/CipherDial/index.js";
import { VaultDoors } from "../../components/VaultDoors/index.js";
import type { WordmarkHandle } from "../../components/Wordmark.js";
import {
  injectedNowMs,
  prefersReducedMotion,
} from "../../lib/injected-clock.js";
import { unlockCeremonyStore } from "../../lib/unlock-ceremony-store.js";
import "../../components/VaultDoors/vault-doors.css";

const nowMs = injectedNowMs;

export type UnlockLockV5Props = {
  paneRef: RefObject<HTMLDivElement | null>;
  cardRef: RefObject<HTMLDivElement | null>;
  notesRef: RefObject<HTMLElement | null>;
  wordmarkRef: RefObject<WordmarkHandle | null>;
  /** Set when a vault unlock succeeded and the ceremony should run. */
  ceremonyToken: number;
  vaultUnlocked: boolean;
};

export function UnlockLockV5({
  paneRef,
  cardRef,
  notesRef,
  wordmarkRef,
  ceremonyToken,
  vaultUnlocked,
}: UnlockLockV5Props) {
  const [phase, setPhase] = useState<CipherDialPhase>("idle");
  const [alignStartMs, setAlignStartMs] = useState<number | null>(null);
  const [openStartMs, setOpenStartMs] = useState<number | null>(null);
  const [lit, setLit] = useState(0);
  const [doorsActive, setDoorsActive] = useState(false);
  const [splitX, setSplitX] = useState(0);
  const lastToken = useRef(0);

  const finishCeremony = useCallback(() => {
    setPhase("idle");
    setAlignStartMs(null);
    setOpenStartMs(null);
    setLit(0);
    setDoorsActive(false);
    unlockCeremonyStore.end();
  }, []);

  useEffect(() => {
    if (!vaultUnlocked || ceremonyToken === 0) return;
    if (lastToken.current === ceremonyToken) return;
    lastToken.current = ceremonyToken;
    unlockCeremonyStore.begin();
    const reduce = prefersReducedMotion();
    if (reduce) {
      setDoorsActive(true);
      setPhase("open");
      setOpenStartMs(nowMs());
      return;
    }
    setPhase("align");
    const t0 = nowMs();
    setAlignStartMs(t0);
    wordmarkRef.current?.replayCipher();
  }, [ceremonyToken, vaultUnlocked, wordmarkRef]);

  useEffect(() => {
    if (phase !== "align" || alignStartMs === null) return;
    let frame = 0;
    const loop = () => {
      const e = nowMs() - alignStartMs;
      const nextLit = e < T_CLICK_MS ? 0 : Math.min(1, (e - T_CLICK_MS) / 60);
      setLit(nextLit);
      if (e >= T_OPEN_MS) {
        setPhase("open");
        setOpenStartMs(nowMs());
        setDoorsActive(true);
        return;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [alignStartMs, phase]);

  return (
    <>
      <CipherDial
        paneRef={paneRef}
        cardRef={cardRef}
        notesRef={notesRef}
        phase={phase}
        alignStartMs={alignStartMs}
        lit={lit}
        onSplitX={setSplitX}
      />
      <VaultDoors
        active={doorsActive}
        openStartMs={openStartMs}
        splitX={splitX}
        paneRef={paneRef}
        onComplete={finishCeremony}
      />
    </>
  );
}

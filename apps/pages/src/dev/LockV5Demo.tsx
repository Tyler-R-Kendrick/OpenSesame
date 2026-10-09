import { useCallback, useRef, useState } from "react";
import { CipherDial } from "../components/CipherDial/index.js";
import { CipherWordmark } from "../components/CipherWordmark/index.js";
import { VaultDoors } from "../components/VaultDoors/index.js";
import "./lock-v5-demo.css";

function nowMs(): number {
  const w = globalThis as { __vt?: number };
  if (typeof w.__vt === "number") return w.__vt;
  return performance.now();
}

export function LockV5Demo() {
  const paneRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLElement>(null);
  const [doorsActive, setDoorsActive] = useState(false);
  const [openStartMs, setOpenStartMs] = useState<number | null>(null);
  const [splitX, setSplitX] = useState(600);

  const openDoors = useCallback(() => {
    setDoorsActive(true);
    setOpenStartMs(nowMs());
  }, []);

  const onDoorsComplete = useCallback(() => {
    setDoorsActive(false);
    setOpenStartMs(null);
  }, []);

  return (
    <main id="main" className="lock-v5-demo" tabIndex={-1}>
      <h1 className="hint">Lock v5 components</h1>
      <section aria-label="CipherWordmark">
        <div className="lock-v5-demo__row">
          <div>
            <p className="lock-v5-demo__label">Animate</p>
            <CipherWordmark animateOnMount includeMark />
          </div>
          <div>
            <p className="lock-v5-demo__label">Static</p>
            <CipherWordmark static includeMark />
          </div>
          <div>
            <p className="lock-v5-demo__label">Rail size</p>
            <CipherWordmark static size={11} theme="rail" includeMark />
          </div>
        </div>
        <div className="lock-v5-demo--dark" data-theme="dark">
          <p className="lock-v5-demo__label">Dark ink</p>
          <CipherWordmark static includeMark size={20} />
        </div>
      </section>
      <section aria-label="CipherDial and VaultDoors">
        <div ref={paneRef} className="lock-v5-demo__stage unlock">
          <div ref={cardRef} className="lock-v5-demo__card" />
          <aside ref={notesRef} className="lock-v5-demo__notes" />
          <CipherDial
            paneRef={paneRef}
            cardRef={cardRef}
            notesRef={notesRef}
            phase="idle"
            alignStartMs={null}
            lit={0}
            onSplitX={setSplitX}
          />
          <VaultDoors
            active={doorsActive}
            openStartMs={openStartMs}
            splitX={splitX}
            paneRef={paneRef}
            onComplete={onDoorsComplete}
          />
        </div>
        <div className="lock-v5-demo__actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Open vault doors"
            title="Open vault doors"
            onClick={openDoors}
          />
        </div>
      </section>
    </main>
  );
}

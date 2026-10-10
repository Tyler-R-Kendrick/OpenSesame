import { useRef } from "react";
import { CipherWordmark } from "../components/CipherWordmark/index.js";
import type { WordmarkHandle } from "../components/Wordmark.js";
import { UnlockLockV5 } from "../screens/unlock/UnlockLockV5.js";
import { ReleaseNotes } from "../screens/unlock/ReleaseNotes.js";
import { useUnlockHeroLayout } from "../screens/unlock/use-unlock-hero-layout.js";
import "../screens/unlock.css";
import "../components/VaultDoors/vault-doors.css";

/**
 * Full-viewport lock-v5 unlock composition for visual reference captures
 * (lock-v5.html / LockV5Demo stage parity at 390/1024/1280).
 */
export function LockV5UnlockReference() {
  const paneRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLElement>(null);
  const wordmarkRef = useRef<WordmarkHandle>({ replayCipher: () => {} });
  const hero = useUnlockHeroLayout(paneRef, cardRef, notesRef);

  return (
    <div className="unlock unlock--lock-v5" ref={paneRef}>
      <UnlockLockV5
        paneRef={paneRef}
        cardRef={cardRef}
        notesRef={notesRef}
        wordmarkRef={wordmarkRef}
        ceremonyToken={0}
        vaultUnlocked={false}
      />
      <div
        className="unlock__hero"
        aria-hidden="true"
        style={{
          left: hero.left,
          top: hero.top,
          fontSize: `${hero.size}px`,
        }}
      >
        <CipherWordmark
          static
          includeMark
          className="unlock__hero-wordmark"
          size={hero.size}
        />
      </div>
      <div className="unlock__card" ref={cardRef}>
        <div className="unlock__brand">
          <span className="unlock__wordmark unlock__wordmark--reserve" />
        </div>
        <h1 className="unlock__title">Unlock</h1>
        <div className="unlock__form" style={{ minHeight: "11rem" }} />
      </div>
      <ReleaseNotes ref={notesRef} />
    </div>
  );
}

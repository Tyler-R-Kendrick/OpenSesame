/**
 * Browser Web Speech API — click-to-toggle voice listening.
 *
 * `start()` must run in the same turn as a user gesture. Chrome will report
 * onstart for a restart from setTimeout, then deliver no audio and no
 * results — exactly the "No speech heard" failure. So we keep one engine
 * instance for the whole armed turn (continuous + interim) and never
 * restart it. If the browser ends the session early (silence), we disarm
 * and hand back whatever we heard.
 */

import { isFunction } from "@opensesame/os-domain";

export type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives?: number;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart?: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export type SpeechRecognitionResultEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type SpeechCtor = new () => SpeechRecognitionLike;

type SpeechGlobals = {
  SpeechRecognition?: SpeechCtor;
  webkitSpeechRecognition?: SpeechCtor;
};

/**
 * `globalThis` as the optional Web Speech constructors.
 *
 * Declared optional so the assertion claims no witness — each read is guarded
 * by `isSpeechCtor` before `new`.
 */
const speechGlobals =
  /* SAFETY: SpeechGlobals declares every name optional, so the assertion
     asserts no runtime witness; the contract is checked at each read by the
     isFunction guards below before anything is constructed. */
  globalThis as SpeechGlobals;

function asSpeechCtor(value: SpeechCtor | undefined): SpeechCtor | null {
  if (value === undefined || !isFunction(value)) return null;
  return value;
}

type SpeechSeams = {
  globals: () => SpeechGlobals;
};

/** Tests replace the globals without asserting on `globalThis`. */
export const speechSeams: SpeechSeams = {
  globals: () => speechGlobals,
};

export function resetSpeechSeams(): void {
  speechSeams.globals = () => speechGlobals;
}

export function detectSpeechRecognition(): SpeechCtor | null {
  const scope = speechSeams.globals();
  return (
    asSpeechCtor(scope.SpeechRecognition) ??
    asSpeechCtor(scope.webkitSpeechRecognition)
  );
}

export type SpeechDiagnostics = {
  readonly lastError: string | null;
  readonly results: number;
  readonly started: boolean;
};

export type PushToTalkSession = {
  /** Arm listening and start the engine (must stay sync for the click gesture). */
  press: () => void;
  /** Disarm, stop the engine, and resolve with the transcript so far. */
  release: () => Promise<string>;
  cancel: () => void;
  readonly listening: boolean;
  diagnostics: () => SpeechDiagnostics;
};

export function createPushToTalk(options?: {
  /** Fixed BCP-47 tag, or a getter so Settings changes apply on the next start. */
  lang?: string | (() => string);
  onInterim?: (text: string) => void;
  onError?: (code: string) => void;
  /** Browser ended the session while we were still armed (usually silence). */
  onEngineEnd?: (text: string) => void;
}): PushToTalkSession | null {
  const Ctor = detectSpeechRecognition();
  if (Ctor === null) return null;

  let recognition: SpeechRecognitionLike | null = null;
  let armed = false;
  let stopping = false;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let finalText = "";
  let interimText = "";
  let settle: ((text: string) => void) | null = null;
  let lastError: string | null = null;
  let results = 0;
  let started = false;

  const resolveLang = (): string => {
    const lang = options?.lang;
    if (lang === undefined) return "en-US";
    if (isFunction(lang)) return lang();
    return lang;
  };

  const clearFinish = () => {
    if (finishTimer === null) return;
    globalThis.clearTimeout(finishTimer);
    finishTimer = null;
  };

  const transcript = () =>
    [finalText, interimText].filter(Boolean).join(" ").trim();

  const finish = (text: string) => {
    clearFinish();
    armed = false;
    stopping = false;
    recognition = null;
    const done = settle;
    settle = null;
    done?.(text.trim());
  };

  /** Trailing `onresult` often follows `onend` when stop() was called. */
  const finishSoon = () => {
    clearFinish();
    finishTimer = globalThis.setTimeout(() => {
      finishTimer = null;
      finish(transcript());
    }, 300);
  };

  const begin = () => {
    const rec = new Ctor();
    recognition = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = resolveLang();
    rec.onstart = () => {
      started = true;
    };
    rec.onresult = (event) => {
      let interim = "";
      let finals = finalText;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const row = event.results[i];
        if (row === undefined) continue;
        const piece = row[0]?.transcript ?? "";
        if (piece.trim() !== "") results += 1;
        if (row.isFinal) finals = `${finals} ${piece}`.trim();
        else interim = `${interim} ${piece}`.trim();
      }
      finalText = finals;
      interimText = interim;
      options?.onInterim?.(transcript());
    };
    rec.onerror = (event) => {
      const code = event.error;
      if (code === "aborted") return;
      lastError = code;
      // no-speech is normal while waiting; the engine may still continue
      // under continuous:true, or end — onend handles disarm.
      if (code === "no-speech") return;
      options?.onError?.(code);
      if (
        code === "not-allowed" ||
        code === "service-not-allowed" ||
        code === "network"
      ) {
        armed = false;
        stopping = true;
      }
    };
    rec.onend = () => {
      recognition = null;
      if (stopping) {
        finishSoon();
        return;
      }
      if (!armed) {
        finishSoon();
        return;
      }
      // Spontaneous end (silence / engine drop). Never restart here —
      // a deferred start() is outside the user gesture and hears nothing.
      const heard = transcript();
      armed = false;
      options?.onEngineEnd?.(heard);
    };
    try {
      rec.start();
    } catch {
      recognition = null;
      lastError = "start-failed";
      armed = false;
      options?.onError?.("start-failed");
      finish(transcript());
    }
  };

  return {
    get listening() {
      return armed;
    },
    diagnostics: () => ({ lastError, results, started }),
    press() {
      if (armed) return;
      clearFinish();
      armed = true;
      stopping = false;
      finalText = "";
      interimText = "";
      settle = null;
      lastError = null;
      results = 0;
      started = false;
      begin();
    },
    release() {
      if (!armed) {
        const heard = transcript();
        finalText = "";
        interimText = "";
        return Promise.resolve(heard);
      }
      stopping = true;
      return new Promise((resolve) => {
        settle = resolve;
        if (recognition === null) {
          finishSoon();
          return;
        }
        try {
          recognition.stop();
        } catch {
          finishSoon();
        }
        globalThis.setTimeout(() => {
          if (settle !== null) finish(transcript());
        }, 1500);
      });
    },
    cancel() {
      clearFinish();
      armed = false;
      stopping = false;
      const done = settle;
      settle = null;
      done?.(transcript());
      if (recognition === null) return;
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
      recognition = null;
    },
  };
}

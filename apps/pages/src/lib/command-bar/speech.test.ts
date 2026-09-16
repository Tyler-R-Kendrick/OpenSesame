import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type SpeechRecognitionLike,
  createPushToTalk,
  detectSpeechRecognition,
  resetSpeechSeams,
  speechSeams,
} from "./speech.js";

describe("detectSpeechRecognition", () => {
  afterEach(resetSpeechSeams);

  it("returns null when the browser has no engine", () => {
    speechSeams.globals = () => ({});
    expect(detectSpeechRecognition()).toBeNull();
    expect(createPushToTalk()).toBeNull();
  });
});

describe("createPushToTalk", () => {
  afterEach(() => {
    resetSpeechSeams();
    vi.useRealTimers();
  });

  it("press/release collects a final transcript", async () => {
    vi.useFakeTimers();
    class FakeRec implements SpeechRecognitionLike {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: SpeechRecognitionLike["onresult"] = null;
      onerror: SpeechRecognitionLike["onerror"] = null;
      onend: SpeechRecognitionLike["onend"] = null;
      onstart: SpeechRecognitionLike["onstart"] = null;
      start = (): void => {
        this.onstart?.();
        this.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: "go to vault" } }],
        });
      };
      stop = (): void => {
        this.onend?.();
      };
      abort = (): void => {};
    }
    speechSeams.globals = () => ({ SpeechRecognition: FakeRec });
    const talk = createPushToTalk();
    talk?.press();
    const pending = talk?.release();
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toBe("go to vault");
    expect(talk?.diagnostics().results).toBeGreaterThan(0);
  });

  it("keeps a trailing result that arrives after onend", async () => {
    vi.useFakeTimers();
    const box: { rec: SpeechRecognitionLike | null } = { rec: null };
    class FakeRec implements SpeechRecognitionLike {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: SpeechRecognitionLike["onresult"] = null;
      onerror: SpeechRecognitionLike["onerror"] = null;
      onend: SpeechRecognitionLike["onend"] = null;
      onstart: SpeechRecognitionLike["onstart"] = null;
      start = (): void => {
        box.rec = this;
        this.onstart?.();
      };
      stop = (): void => {
        this.onend?.();
      };
      abort = (): void => {};
    }
    speechSeams.globals = () => ({ SpeechRecognition: FakeRec });
    const talk = createPushToTalk();
    talk?.press();
    const pending = talk?.release();
    box.rec?.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "copy password" } }],
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toBe("copy password");
  });

  it("reads lang from a getter on each new listen session", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    class FakeRec implements SpeechRecognitionLike {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: SpeechRecognitionLike["onresult"] = null;
      onerror: SpeechRecognitionLike["onerror"] = null;
      onend: SpeechRecognitionLike["onend"] = null;
      start = (): void => {
        seen.push(this.lang);
      };
      stop = (): void => {
        this.onend?.();
      };
      abort = (): void => {};
    }
    speechSeams.globals = () => ({ SpeechRecognition: FakeRec });
    let lang = "en-US";
    const talk = createPushToTalk({ lang: () => lang });
    talk?.press();
    const first = talk?.release();
    await vi.advanceTimersByTimeAsync(300);
    await first;
    lang = "ja-JP";
    talk?.press();
    expect(seen).toEqual(["en-US", "ja-JP"]);
  });

  it("does not restart after a spontaneous end — that would drop the mic", () => {
    vi.useFakeTimers();
    let starts = 0;
    const box: { rec: SpeechRecognitionLike | null } = { rec: null };
    const onEngineEnd = vi.fn();
    class FakeRec implements SpeechRecognitionLike {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: SpeechRecognitionLike["onresult"] = null;
      onerror: SpeechRecognitionLike["onerror"] = null;
      onend: SpeechRecognitionLike["onend"] = null;
      start = (): void => {
        starts += 1;
        box.rec = this;
      };
      stop = (): void => {
        this.onend?.();
      };
      abort = (): void => {};
    }
    speechSeams.globals = () => ({ SpeechRecognition: FakeRec });
    const talk = createPushToTalk({ onEngineEnd });
    talk?.press();
    expect(starts).toBe(1);
    box.rec?.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "hello" } }],
    });
    box.rec?.onend?.();
    vi.advanceTimersByTime(500);
    expect(starts).toBe(1);
    expect(talk?.listening).toBe(false);
    expect(onEngineEnd).toHaveBeenCalledWith("hello");
  });
});

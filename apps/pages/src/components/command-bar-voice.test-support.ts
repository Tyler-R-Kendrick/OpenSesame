import {
  type SpeechRecognitionLike,
  speechSeams,
} from "@opensesame/app-core/lib/command-bar/speech.js";

/** One engine the push-to-talk session built, driven by the test. */
export class FakeEngine implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: SpeechRecognitionLike["onresult"] = null;
  onerror: SpeechRecognitionLike["onerror"] = null;
  onend: SpeechRecognitionLike["onend"] = null;
  onstart: SpeechRecognitionLike["onstart"] = null;
  aborted = false;
  constructor(
    private readonly announceStart: boolean,
    registry: FakeEngine[],
  ) {
    registry.push(this);
  }
  start() {
    if (this.announceStart) this.onstart?.();
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.aborted = true;
  }
  fail(error: string) {
    this.onerror?.({ error });
  }
  hear(transcript: string) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: false, 0: { transcript } }],
    });
  }
}

/** Routes the real push-to-talk to fake engines through the speech seam. */
export function installFakeSpeech(announceStart: boolean) {
  const engines: FakeEngine[] = [];
  class Engine extends FakeEngine {
    constructor() {
      super(announceStart, engines);
    }
  }
  speechSeams.globals = () => ({ SpeechRecognition: Engine });
  return { engines };
}

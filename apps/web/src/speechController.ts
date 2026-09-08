export type SpeechState = {
  id: string | null;
  phase: "idle" | "speaking" | "paused";
  error: string;
};
export type SpeechDevice = {
  engine: Pick<SpeechSynthesis, "speak" | "cancel" | "pause" | "resume" | "getVoices">;
  utterance: (text: string) => SpeechSynthesisUtterance;
};
export function localVoice(voices: SpeechSynthesisVoice[], text: string, language: string) {
  const cyrillic = text.match(/[а-яё]/giu)?.length ?? 0;
  const latin = text.match(/[a-z]/giu)?.length ?? 0;
  const lang = cyrillic > latin / 2 ? "ru" : latin > cyrillic ? "en" : language.split("-")[0];
  const local = voices.filter((voice) => voice.localService);
  return (
    local.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === lang && v.default) ??
    local.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === lang) ??
    local.find((v) => v.default) ??
    local[0]
  );
}
export class MessageSpeech {
  private state: SpeechState = { id: null, phase: "idle", error: "" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private chunks: string[] = [];
  private index = 0;
  private device: SpeechDevice | undefined;
  private voice: SpeechSynthesisVoice | undefined;
  // Keep a strong reference: the browser owns the same utterance until its terminal event.
  private current: SpeechSynthesisUtterance | undefined;
  private getDevice: () => SpeechDevice | undefined;
  constructor(getDevice: () => SpeechDevice | undefined) {
    this.getDevice = getDevice;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: SpeechState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  stop = (id?: string) => {
    if (id && this.state.id !== id) return;
    ++this.generation;
    const device = this.device;
    this.device = undefined;
    this.current = undefined;
    this.chunks = [];
    this.index = 0;
    this.voice = undefined;
    this.update({ id: null, phase: "idle", error: "" });
    try {
      device?.engine.cancel();
    } catch {
      /* A closed device is already stopped. */
    }
  };
  stopScope = (scope: string) => {
    if (this.state.id?.startsWith(scope + ":")) this.stop();
  };
  start = (id: string, chunks: string[], language: string) => {
    if (id === this.state.id && this.state.phase !== "idle") return;
    this.stop();
    if (!chunks.length) return;
    try {
      const device = this.getDevice();
      if (!device) return;
      const voice = localVoice(device.engine.getVoices(), chunks.join(" "), language);
      if (!voice) {
        this.update({ id, phase: "idle", error: "Системный голос пока недоступен" });
        return;
      }
      this.device = device;
      this.voice = voice;
      this.chunks = chunks;
      this.update({ id, phase: "speaking", error: "" });
      // cancel() retains the browser's paused flag. Resume an empty queue before starting.
      device.engine.cancel();
      device.engine.resume();
      this.next(this.generation);
    } catch {
      this.fail(id);
    }
  };
  private fail(id: string | null) {
    this.stop();
    this.update({ id, phase: "idle", error: "Не удалось озвучить ответ" });
  }
  private next(generation: number) {
    if (generation !== this.generation || !this.device || this.state.phase !== "speaking") return;
    const text = this.chunks[this.index];
    if (!text) {
      this.stop();
      return;
    }
    try {
      const utterance = this.device.utterance(text);
      this.current = utterance;
      utterance.voice = this.voice ?? null;
      utterance.lang = this.voice?.lang ?? "";
      const valid = () => generation === this.generation && this.current === utterance;
      utterance.onend = () => {
        if (!valid()) return;
        this.current = undefined;
        ++this.index;
        if (this.index >= this.chunks.length) this.stop();
        else this.next(generation);
      };
      utterance.onerror = () => {
        if (valid()) this.fail(this.state.id);
      };
      this.device.engine.speak(utterance);
    } catch {
      this.fail(this.state.id);
    }
  }
  pause = () => {
    if (this.state.phase !== "speaking") return;
    this.update({ ...this.state, phase: "paused" });
    try {
      this.device?.engine.pause();
    } catch {
      this.fail(this.state.id);
    }
  };
  resume = () => {
    if (this.state.phase !== "paused") return;
    this.update({ ...this.state, phase: "speaking" });
    try {
      this.device?.engine.resume();
      if (!this.current) this.next(this.generation);
    } catch {
      this.fail(this.state.id);
    }
  };
}

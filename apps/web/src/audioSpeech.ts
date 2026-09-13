export type AudioSpeechState = {
  id: string | null;
  phase: "idle" | "loading" | "speaking" | "paused";
  error: string;
};
export class AudioMessageSpeech {
  private state: AudioSpeechState = { id: null, phase: "idle", error: "" };
  private listeners = new Set<() => void>();
  private audio?: HTMLAudioElement;
  private clip?: string;
  private generation = 0;
  private mediaActions: MediaSessionAction[] = [];
  private dependencies: {
    audio: () => HTMLAudioElement;
    create: (id: string, text: string, language: string, voice?: string) => Promise<unknown>;
    remove: (id: string) => Promise<unknown>;
    media?: () => MediaSession | undefined;
    playback?: (active: boolean) => void;
    audioUrl?: (clip: string) => string;
  };
  constructor(dependencies: AudioMessageSpeech["dependencies"]) {
    this.dependencies = dependencies;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: AudioSpeechState) {
    this.state = state;
    for (const listener of this.listeners) listener();
    try {
      const media = this.dependencies.media?.();
      if (media)
        media.playbackState =
          state.phase === "speaking" ? "playing" : state.phase === "paused" ? "paused" : "none";
    } catch {}
  }
  stop = (id?: string) => {
    if (id && this.state.id !== id) return;
    ++this.generation;
    const audio = this.audio,
      clip = this.clip;
    this.audio = undefined;
    this.clip = undefined;
    if (audio) {
      audio.onplaying = null;
      audio.onpause = null;
      audio.onended = null;
      audio.onerror = null;
      audio.onloadedmetadata = null;
      audio.ontimeupdate = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    try {
      const media = this.dependencies.media?.();
      if (media) {
        for (const action of this.mediaActions) media.setActionHandler(action, null);
        media.metadata = null;
        media.setPositionState?.();
      }
    } catch {}
    this.mediaActions = [];
    this.dependencies.playback?.(false);
    if (clip) void this.dependencies.remove(clip).catch(() => {});
    this.update({ id: null, phase: "idle", error: "" });
  };
  stopScope = (scope: string) => {
    if (this.state.id?.startsWith(scope + ":")) this.stop();
  };
  private fail(id: string, message = "Не удалось озвучить ответ") {
    this.stop();
    this.update({ id, phase: "idle", error: message });
  }
  private position() {
    const audio = this.audio;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      this.dependencies.media?.()?.setPositionState?.({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: Math.min(audio.duration, Math.max(0, audio.currentTime)),
      });
    } catch {}
  }
  start = (id: string, text: string, language: string, voice?: string) => {
    this.stop();
    if (!text.trim()) return;
    const generation = this.generation;
    const valid = () => generation === this.generation;
    const clip = crypto.randomUUID();
    this.clip = clip;
    this.update({ id, phase: "loading", error: "" });
    try {
      const audio = this.dependencies.audio();
      this.audio = audio;
      audio.preload = "auto";
      audio.defaultPlaybackRate = 0.85;
      audio.playbackRate = 0.85;
      audio.preservesPitch = true;
      audio.onplaying = () => {
        if (valid()) {
          this.update({ id, phase: "speaking", error: "" });
          this.position();
        }
      };
      audio.onpause = () => {
        if (valid() && this.state.phase === "speaking")
          this.update({ ...this.state, phase: "paused" });
      };
      audio.onended = () => {
        if (valid()) this.stop();
      };
      audio.onerror = () => {
        if (valid()) this.fail(id);
      };
      audio.onloadedmetadata = () => this.position();
      audio.ontimeupdate = () => this.position();
      this.dependencies.playback?.(true);
      const media = this.dependencies.media?.();
      if (media) {
        if (typeof MediaMetadata !== "undefined")
          media.metadata = new MediaMetadata({ title: "Озвучивание ответа", artist: "CodexWeb" });
        const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
          ["play", this.resume],
          ["pause", this.pause],
          ["stop", () => this.stop()],
          [
            "seekbackward",
            (details) => {
              audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset ?? 10));
              this.position();
            },
          ],
          [
            "seekforward",
            (details) => {
              if (Number.isFinite(audio.duration))
                audio.currentTime = Math.min(
                  audio.duration,
                  audio.currentTime + (details.seekOffset ?? 10),
                );
              this.position();
            },
          ],
          [
            "seekto",
            (details) => {
              if (details.seekTime !== undefined && Number.isFinite(audio.duration))
                audio.currentTime = Math.min(audio.duration, Math.max(0, details.seekTime));
              this.position();
            },
          ],
        ];
        for (const [action, handler] of actions) {
          try {
            media.setActionHandler(action, handler);
            this.mediaActions.push(action);
          } catch {}
        }
      }
      // Issue the media request and play() inside the tap; synthesis POST runs concurrently.
      void this.dependencies
        .create(clip, text, language, voice)
        .then(() => {
          if (!valid()) void this.dependencies.remove(clip).catch(() => {});
        })
        .catch(() => {
          if (valid()) this.fail(id, "Не удалось подготовить озвучивание. Попробуй ещё раз.");
        });
      audio.src = this.dependencies.audioUrl?.(clip) ?? "/api/speech/" + clip + "/audio";
      void audio.play().catch((error) => {
        if (!valid()) return;
        if (error?.name === "NotAllowedError")
          this.update({ id, phase: "paused", error: "Нажми ▶, чтобы начать чтение" });
        else if (error?.name !== "AbortError") this.fail(id);
      });
    } catch {
      if (valid()) this.fail(id);
    }
  };
  pause = () => {
    if (!this.audio) return;
    this.audio.pause();
    this.update({ ...this.state, phase: "paused" });
    this.position();
  };
  resume = () => {
    const audio = this.audio,
      id = this.state.id,
      generation = this.generation;
    if (!audio || !id) return;
    void audio.play().catch(() => {
      if (generation === this.generation) this.fail(id);
    });
  };
}

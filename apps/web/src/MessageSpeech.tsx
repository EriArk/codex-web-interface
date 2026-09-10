import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { AudioMessageSpeech } from "./audioSpeech";
import { Icon } from "./icons";
import { MessageSpeech as Controller } from "./speechController";
import { speechChunks, speechText } from "./speechText";
import "./speech.css";

const device = () =>
  typeof window !== "undefined" &&
  typeof window.speechSynthesis?.speak === "function" &&
  typeof window.SpeechSynthesisUtterance === "function"
    ? {
        engine: window.speechSynthesis,
        utterance: (text: string) => new SpeechSynthesisUtterance(text),
      }
    : undefined;
const systemPlayer = new Controller(device);
let previousAudioType: string | undefined;
const audioPlayer = new AudioMessageSpeech({
  audio: () => new Audio(),
  create: (id, text, language) =>
    api("/speech/" + id, { method: "POST", body: { text, language } }),
  remove: (id) => api("/speech/" + id, { method: "DELETE" }),
  media: () => navigator.mediaSession,
  playback: (active) => {
    try {
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (!session) return;
      if (active) {
        previousAudioType = session.type;
        session.type = "playback";
      } else if (previousAudioType !== undefined) {
        session.type = previousAudioType;
        previousAudioType = undefined;
      }
    } catch {}
  },
});
let backgroundAvailable = false;
let backgroundCheck: Promise<boolean> | undefined;
const checkBackground = () =>
  (backgroundCheck ??= api<{ available: boolean }>("/speech/status")
    .then((value) => (backgroundAvailable = value.available === true))
    .catch(() => false));
const player = {
  snapshot: () => (audioPlayer.snapshot().id ? audioPlayer.snapshot() : systemPlayer.snapshot()),
  subscribe: (listener: () => void) => {
    const a = audioPlayer.subscribe(listener),
      b = systemPlayer.subscribe(listener);
    return () => {
      a();
      b();
    };
  },
  stop: (id?: string) => {
    audioPlayer.stop(id);
    systemPlayer.stop(id);
  },
  stopScope: (scope: string) => {
    audioPlayer.stopScope(scope);
    systemPlayer.stopScope(scope);
  },
  pause: () => (audioPlayer.snapshot().id ? audioPlayer.pause() : systemPlayer.pause()),
  resume: () => (audioPlayer.snapshot().id ? audioPlayer.resume() : systemPlayer.resume()),
  start: (id: string, text: string) => {
    audioPlayer.stop();
    systemPlayer.stop();
    if (speechMode.snapshot() === "background" || !device()) {
      const cyrillic = text.match(/[а-яё]/giu)?.length ?? 0,
        latin = text.match(/[a-z]/giu)?.length ?? 0;
      if (backgroundAvailable && text.length <= 30000)
        audioPlayer.start(id, text, cyrillic > latin / 2 ? "ru" : "en");
    } else systemPlayer.start(id, speechChunks(text), navigator.language);
  },
};
type SpeechMode = "system" | "background";
const modeKey = "codex-speech-mode";
const readMode = (): SpeechMode => {
  try {
    return localStorage.getItem(modeKey) === "background" ? "background" : "system";
  } catch {
    return "system";
  }
};
let selectedMode = readMode();
const modeListeners = new Set<() => void>();
const speechMode = {
  snapshot: () => selectedMode,
  subscribe: (listener: () => void) => {
    modeListeners.add(listener);
    return () => {
      modeListeners.delete(listener);
    };
  },
  select: (next: SpeechMode, persist = true) => {
    if (next === selectedMode) return;
    player.stop();
    selectedMode = next;
    if (next === "background") backgroundCheck = undefined;
    if (persist)
      try {
        localStorage.setItem(modeKey, next);
      } catch {}
    for (const listener of modeListeners) listener();
  },
};
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === modeKey || event.key === null) speechMode.select(readMode(), false);
  });
}
function useSpeechMode() {
  const preferred = useSyncExternalStore(
    speechMode.subscribe,
    speechMode.snapshot,
    speechMode.snapshot,
  );
  const supported = !!device();
  const mode = preferred === "system" && !supported ? "background" : preferred;
  const [background, setBackground] = useState(backgroundAvailable);
  useEffect(() => {
    if (mode !== "background") return;
    let disposed = false;
    void checkBackground().then((value) => {
      if (!disposed) setBackground(value);
    });
    return () => {
      disposed = true;
    };
  }, [mode]);
  return { mode, supported, background };
}
export function SpeechSettings() {
  const { mode, supported } = useSpeechMode();
  return (
    <label className="speech-settings">
      <span>Озвучивание</span>
      <select
        aria-label="Режим озвучивания"
        value={mode}
        onChange={(event) => speechMode.select(event.target.value as SpeechMode)}
      >
        <option value="system" disabled={!supported}>
          Системный голос
        </option>
        <option value="background">Фоновое аудио</option>
      </select>
    </label>
  );
}
if (typeof window !== "undefined")
  window.addEventListener("private-session-ended", () => {
    player.stop();
    backgroundAvailable = false;
    backgroundCheck = undefined;
  });
export function useSpeechScope(scope: string, visible: boolean) {
  useEffect(() => {
    if (!visible) player.stopScope(scope);
    const stop = () => player.stopScope(scope);
    window.addEventListener("pagehide", stop);
    window.addEventListener("private-session-ended", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("private-session-ended", stop);
      stop();
    };
  }, [scope, visible]);
}
export function SpeechButton({ id, text }: { id: string; text: string }) {
  const state = useSyncExternalStore(player.subscribe, player.snapshot, player.snapshot);
  const [hasVoice, setHasVoice] = useState(false);
  const { mode, background } = useSpeechMode();
  useEffect(() => {
    const engine = device()?.engine;
    if (!engine) return;
    const refresh = () => {
      try {
        setHasVoice(engine.getVoices().some((voice) => voice.localService));
      } catch {
        setHasVoice(false);
      }
    };
    refresh();
    engine.addEventListener("voiceschanged", refresh);
    return () => engine.removeEventListener("voiceschanged", refresh);
  }, []);
  useEffect(() => () => player.stop(id), [id]);
  if ((!device() && !background) || !text.trim()) return null;
  const playable = mode === "system" ? hasVoice : background && speechText(text).length <= 30000;
  const active = state.id === id && state.phase !== "idle";
  const paused = active && state.phase === "paused";
  const label =
    active && state.phase === "loading"
      ? "Подготовка озвучивания"
      : active
        ? paused
          ? "Продолжить озвучивание"
          : "Приостановить озвучивание"
        : "Озвучить ответ";
  const error = state.id === id ? state.error : "";
  return (
    <span className="speech-control" data-speech-state={active ? state.phase : "idle"}>
      <button
        type="button"
        className="speech-button"
        aria-label={label}
        title={
          playable || active
            ? label
            : mode === "system"
              ? "Системный голос пока недоступен"
              : "Фоновое аудио недоступно"
        }
        disabled={(state.id === id && state.phase === "loading") || (!playable && !active)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (active) {
            if (paused) player.resume();
            else player.pause();
          } else player.start(id, speechText(text));
        }}
      >
        <Icon
          name={
            active ? (state.phase === "loading" ? "refresh" : paused ? "play" : "pause") : "speaker"
          }
          size={17}
        />
      </button>
      {active && (
        <button
          type="button"
          className="speech-button"
          aria-label="Остановить озвучивание"
          title="Остановить озвучивание"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            player.stop(id);
          }}
        >
          <Icon name="stop" size={17} />
        </button>
      )}
      {error && (
        <span className="speech-error" role="status">
          {error}
        </span>
      )}
    </span>
  );
}

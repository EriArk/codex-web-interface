import { useEffect, useState, useSyncExternalStore } from "react";
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
const player = new Controller(device);
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
  if (!device() || !text.trim()) return null;
  const active = state.id === id && state.phase !== "idle";
  const paused = active && state.phase === "paused";
  const label = active
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
        title={hasVoice || active ? label : "Системный голос пока недоступен"}
        disabled={!hasVoice && !active}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (active) {
            if (paused) player.resume();
            else player.pause();
          } else player.start(id, speechChunks(speechText(text)), navigator.language);
        }}
      >
        <Icon name={active ? (paused ? "play" : "pause") : "speaker"} size={17} />
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

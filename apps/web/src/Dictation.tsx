import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import "./dictation.css";

const MAX_BYTES = 6 * 1024 * 1024;
type Phase = "idle" | "permission" | "recording" | "processing" | "error";
export function useDictation(
  scope: string,
  enabled: boolean,
  text: string,
  save: (text: string) => void,
  maxLength = 32000,
) {
  const [available, setAvailable] = useState(false),
    [phase, setPhase] = useState<Phase>("idle"),
    [error, setError] = useState(""),
    [seconds, setSeconds] = useState(0);
  const current = useRef({ text, save, enabled, scope });
  current.current = { text, save, enabled, scope };
  const generation = useRef(0),
    recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    audio = useRef<Blob | null>(null),
    operation = useRef<string | null>(null),
    timer = useRef<ReturnType<typeof setInterval> | null>(null),
    abort = useRef<AbortController | null>(null),
    processing = useRef(false);
  const dispose = useCallback(() => {
    generation.current++;
    abort.current?.abort();
    abort.current = null;
    processing.current = false;
    const recording = recorder.current;
    recorder.current = null;
    if (recording && recording.state !== "inactive") recording.stop();
    stream.current?.getTracks().forEach((t) => {
      t.stop();
    });
    stream.current = null;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (operation.current)
      void api(`/dictation/${operation.current}`, { method: "DELETE" }).catch(() => {});
    operation.current = null;
    audio.current = null;
  }, []);
  const cancel = () => {
    dispose();
    setPhase("idle");
    setError("");
  };
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    if (
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof MediaRecorder !== "undefined"
    )
      void api<{ available: boolean }>("/dictation/status")
        .then((v) => {
          if (!disposed) setAvailable(v.available);
        })
        .catch(() => {
          if (!disposed) setAvailable(false);
        });
    return () => {
      disposed = true;
    };
  }, [enabled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A scope/availability change must cancel capture even when the refs remain the same.
  useEffect(() => {
    setPhase("idle");
    setError("");
    const hide = () => {
      if (document.hidden && recorder.current?.state === "recording") recorder.current.stop();
    };
    const leave = () => {
      dispose();
      setPhase("idle");
      setError("");
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    window.addEventListener("private-session-ended", leave);
    return () => {
      dispose();
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("private-session-ended", leave);
    };
  }, [scope, enabled, dispose]);
  const process = async (clip: Blob, version: number) => {
    if (generation.current !== version || processing.current) return;
    processing.current = true;
    setPhase("processing");
    setError("");
    audio.current = clip;
    const id = operation.current ?? crypto.randomUUID();
    operation.current = id;
    const controller = new AbortController();
    abort.current = controller;
    try {
      const mime = clip.type.split(";")[0] ?? "";
      await api(`/dictation/${id}?mime=${encodeURIComponent(mime)}`, {
        method: "POST",
        raw: clip,
        signal: controller.signal,
      });
      for (let count = 0; count < 180; count++) {
        const result = await api<{ state: string; text: string }>(`/dictation/${id}`, {
          signal: controller.signal,
        });
        if (
          generation.current !== version ||
          current.current.scope !== scope ||
          !current.current.enabled
        )
          return;
        if (result.state === "failed") {
          await api(`/dictation/${id}`, { method: "DELETE", signal: controller.signal });
          operation.current = null;
          throw new Error("OpenAI не смог распознать запись. Можно повторить обработку.");
        }
        if (result.state === "completed") {
          if (!result.text.trim())
            throw new Error("Не удалось разобрать речь. Попробуй записать ещё раз.");
          const draft = current.current.text;
          const next = draft + (draft && !/\s$/.test(draft) ? "\n" : "") + result.text.trim();
          if (next.length > maxLength)
            throw new Error(
              "Для распознанного текста не хватает места. Сократи черновик и повтори обработку.",
            );
          current.current.save(next);
          setPhase("idle");
          audio.current = null;
          void api(`/dictation/${id}`, { method: "DELETE" }).catch(() => {});
          operation.current = null;
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            clearTimeout(wait);
            reject(new DOMException("Cancelled", "AbortError"));
          };
          const wait = setTimeout(() => {
            controller.signal.removeEventListener("abort", stop);
            resolve();
          }, 1000);
          controller.signal.addEventListener("abort", stop, { once: true });
          if (controller.signal.aborted) stop();
        });
      }
      throw new Error("Распознавание затянулось. Можно повторить обработку.");
    } catch (e) {
      if (generation.current === version) {
        setError(messageOf(e));
        setPhase("error");
      }
    } finally {
      if (abort.current === controller) processing.current = false;
    }
  };
  const start = async () => {
    if (phase !== "idle" || !current.current.enabled) return;
    const version = ++generation.current;
    setPhase("permission");
    setError("");
    setSeconds(0);
    try {
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (generation.current !== version || !current.current.enabled) {
        microphone.getTracks().forEach((t) => {
          t.stop();
        });
        return;
      }
      stream.current = microphone;
      const mime = [
        "audio/mp4",
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ].find((t) => MediaRecorder.isTypeSupported(t));
      if (!mime) throw new Error("В этом браузере запись недоступна.");
      const recording = new MediaRecorder(microphone, {
        mimeType: mime,
        audioBitsPerSecond: 96000,
      });
      recorder.current = recording;
      const chunks: Blob[] = [];
      let size = 0,
        failed = false;
      recording.ondataavailable = (event) => {
        size += event.data.size;
        if (size > MAX_BYTES) {
          failed = true;
          if (recording.state !== "inactive") recording.stop();
        } else if (event.data.size) chunks.push(event.data);
      };
      recording.onerror = () => {
        failed = true;
        if (recording.state !== "inactive") recording.stop();
      };
      recording.onstop = () => {
        microphone.getTracks().forEach((t) => {
          t.stop();
        });
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        if (generation.current !== version) return;
        recorder.current = null;
        stream.current = null;
        if (failed || !size) {
          setPhase("error");
          setError("Не удалось сохранить запись. Попробуй записать ещё раз.");
          return;
        }
        void process(new Blob(chunks, { type: mime }), version);
      };
      recording.start(1000);
      setPhase("recording");
      const started = Date.now();
      timer.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        setSeconds(elapsed);
        if (elapsed >= 180 && recording.state === "recording") recording.stop();
      }, 500);
    } catch (e) {
      stream.current?.getTracks().forEach((t) => {
        t.stop();
      });
      stream.current = null;
      if (generation.current === version) {
        setPhase("error");
        setError(
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "Разреши доступ к микрофону в настройках браузера."
            : messageOf(e),
        );
      }
    }
  };
  return {
    locked: phase !== "idle",
    button: available ? (
      <button
        type="button"
        className="icon-button dictation-button"
        aria-label="Продиктовать сообщение"
        disabled={!enabled || phase !== "idle"}
        onClick={() => void start()}
      >
        <Icon name="microphone" />
      </button>
    ) : null,
    panel:
      phase !== "idle" ? (
        <section className="dictation-panel" aria-label="Диктовка сообщения">
          <span role="status">
            {phase === "recording"
              ? `Запись ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
              : phase === "permission"
                ? "Доступ к микрофону…"
                : phase === "processing"
                  ? "Распознаю…"
                  : error}
          </span>
          {phase === "recording" && (
            <button type="button" className="primary" onClick={() => recorder.current?.stop()}>
              Готово
            </button>
          )}
          {phase === "error" && audio.current && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const clip = audio.current;
                if (clip) void process(clip, generation.current);
              }}
            >
              Повторить
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Отменить диктовку"
            onClick={cancel}
          >
            <Icon name="close" />
          </button>
        </section>
      ) : null,
  };
}

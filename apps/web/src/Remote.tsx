import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";

interface MouseState {
  x: number;
  y: number;
  left: boolean;
  middle: boolean;
  right: boolean;
}
interface MouseSource {
  onEach: (types: string[], callback: (event: { state: MouseState }) => void) => void;
  reset: () => void;
}
interface Display {
  getElement: () => HTMLElement;
  getWidth: () => number;
  getHeight: () => number;
  scale: (value: number) => void;
  showCursor: (show: boolean) => void;
  flatten: () => HTMLCanvasElement;
  flush: (callback: () => void, timestamp?: number, frames?: number) => void;
  onresize: () => void;
}
interface Client {
  connect: (data?: string) => void;
  disconnect: () => void;
  sendMouseState: (state: MouseState, scaled: boolean) => void;
  sendKeyEvent: (pressed: number, code: number) => void;
  getDisplay: () => Display;
  onstatechange: (state: number) => void;
  onsync: () => void;
  onerror: (error: { message: string }) => void;
}
interface Keyboard {
  onkeydown: (key: number) => boolean;
  onkeyup: (key: number) => void;
  reset: () => void;
}
interface Sink {
  getElement: () => HTMLElement;
  focus: () => void;
}
interface Guac {
  Client: new (tunnel: unknown) => Client;
  WebSocketTunnel: new (
    url: string,
  ) => { onerror: (e: { message: string }) => void; onstatechange: (state: number) => void };
  Mouse: {
    new (element: HTMLElement): MouseSource;
    Touchpad: new (element: HTMLElement) => MouseSource;
    Touchscreen: new (element: HTMLElement) => MouseSource;
  };
  Keyboard: new (element: HTMLElement) => Keyboard;
  InputSink: new () => Sink;
}
declare global {
  interface Window {
    Guacamole?: Guac;
  }
}
let loader: Promise<Guac> | undefined;
function loadGuacamole(): Promise<Guac> {
  if (window.Guacamole) return Promise.resolve(window.Guacamole);
  if (!loader)
    loader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/guacamole-1.6.0.min.js";
      script.onload = () =>
        window.Guacamole ? resolve(window.Guacamole) : reject(new Error("Remote не загрузился"));
      script.onerror = () => {
        loader = undefined;
        reject(new Error("Не удалось загрузить Remote"));
      };
      document.head.append(script);
    });
  return loader;
}
export function Remote({
  projectId,
  threadId,
  visible,
  available,
  onSnapshot,
}: {
  projectId: string;
  threadId: string;
  visible: boolean;
  available: boolean;
  onSnapshot: () => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    inputHost = useRef<HTMLDivElement>(null),
    pane = useRef<HTMLElement>(null);
  const clientRef = useRef<Client | undefined>(undefined),
    sinkRef = useRef<Sink | undefined>(undefined),
    modifiers = useRef(new Set<number>());
  const [requested, setRequested] = useState(false),
    [status, setStatus] = useState("idle"),
    [error, setError] = useState(""),
    [full, setFull] = useState(false),
    [touchMode, setTouchMode] = useState<"trackpad" | "touch">("trackpad"),
    [snapshotBusy, setSnapshotBusy] = useState(false),
    [held, setHeld] = useState<number[]>([]);
  const release = useCallback(() => {
    for (const key of modifiers.current) clientRef.current?.sendKeyEvent(0, key);
    modifiers.current.clear();
    setHeld([]);
  }, []);
  useEffect(() => {
    if (!visible) {
      setRequested(false);
      setFull(false);
    }
  }, [visible]);
  useEffect(() => {
    if (!requested || !visible || !host.current) return;
    let disposed = false,
      client: Client | undefined,
      resize: ResizeObserver | undefined,
      keyboard: Keyboard | undefined,
      mouse: MouseSource | undefined,
      touch: MouseSource | undefined;
    setStatus("connecting");
    setError("");
    void loadGuacamole()
      .then((G) => {
        if (disposed || !host.current || !inputHost.current) return;
        const url =
          (location.protocol === "https:" ? "wss://" : "ws://") +
          location.host +
          "/api/projects/" +
          encodeURIComponent(projectId) +
          "/remote";
        const tunnel = new G.WebSocketTunnel(url);
        tunnel.onerror = (e: { message: string }) => {
          if (!disposed) {
            setError(e.message || "Соединение с Remote прервалось");
            setStatus("error");
          }
        };
        tunnel.onstatechange = (state: number) => {
          if (!disposed && state === 2) setStatus("disconnected");
        };
        client = new G.Client(tunnel);
        clientRef.current = client;
        const activeClient = client,
          display = client.getDisplay(),
          element = display.getElement();
        host.current.replaceChildren(element);
        element.setAttribute("aria-label", "Удалённый рабочий стол");
        element.tabIndex = 0;
        const fit = () => {
          if (host.current && display.getWidth())
            display.scale(
              Math.min(
                host.current.clientWidth / display.getWidth(),
                host.current.clientHeight / display.getHeight(),
                1,
              ),
            );
        };
        display.onresize = fit;
        resize = new ResizeObserver(fit);
        resize.observe(host.current);
        client.onstatechange = (state) => {
          if (disposed) return;
          if (state !== 3) setStatus(state === 5 ? "disconnected" : "connecting");
        };
        let frameReady = false;
        client.onsync = () => {
          if (frameReady) return;
          display.flush(() => {
            if (!disposed && display.getWidth() > 0 && display.getHeight() > 0) {
              const canvas = display.flatten();
              const ctx = canvas.getContext("2d");
              if (
                ctx?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
                  .data[3]
              ) {
                frameReady = true;
                setStatus("connected");
              }
            }
          });
        };
        client.onerror = (e) => {
          if (!disposed) {
            setError(e.message || "Не удалось подключиться к рабочему столу");
            setStatus("error");
          }
        };
        mouse = new G.Mouse(element);
        touch =
          touchMode === "trackpad"
            ? new G.Mouse.Touchpad(element)
            : new G.Mouse.Touchscreen(element);
        const move = (e: { state: MouseState }) => {
          display.showCursor(true);
          activeClient.sendMouseState(e.state, true);
        };
        mouse.onEach(["mousedown", "mousemove", "mouseup"], move);
        touch.onEach(["mousedown", "mousemove", "mouseup"], move);
        const sink = new G.InputSink();
        sinkRef.current = sink;
        inputHost.current.replaceChildren(sink.getElement());
        sink.getElement().setAttribute("aria-label", "Клавиатура удалённого рабочего стола");
        keyboard = new G.Keyboard(pane.current ?? element);
        keyboard.onkeydown = (key) => {
          activeClient.sendKeyEvent(1, key);
          return false;
        };
        keyboard.onkeyup = (key) => {
          activeClient.sendKeyEvent(0, key);
          release();
        };
        client.connect("width=1280&height=800");
      })
      .catch((e) => {
        if (!disposed) {
          setError(messageOf(e));
          setStatus("error");
        }
      });
    const blur = () => {
      keyboard?.reset();
      mouse?.reset();
      touch?.reset();
      release();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        blur();
        setRequested(false);
      }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", blur);
    return () => {
      disposed = true;
      blur();
      resize?.disconnect();
      client?.disconnect();
      clientRef.current = undefined;
      sinkRef.current = undefined;
      host.current?.replaceChildren();
      inputHost.current?.replaceChildren();
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [requested, visible, projectId, touchMode, release]);
  const stroke = (code: number) => {
    clientRef.current?.sendKeyEvent(1, code);
    clientRef.current?.sendKeyEvent(0, code);
    release();
  };
  const modifier = (code: number) => {
    if (modifiers.current.has(code)) {
      clientRef.current?.sendKeyEvent(0, code);
      modifiers.current.delete(code);
    } else {
      clientRef.current?.sendKeyEvent(1, code);
      modifiers.current.add(code);
    }
    setHeld([...modifiers.current]);
  };
  const snapshot = async () => {
    const display = clientRef.current?.getDisplay();
    if (!display || !threadId) return;
    setSnapshotBusy(true);
    try {
      await new Promise<void>((resolve) => display.flush(resolve));
      await api(`/threads/${threadId}/screenshots`, {
        method: "POST",
        key: crypto.randomUUID(),
        body: { png: display.flatten().toDataURL("image/png").split(",")[1] },
      });
      onSnapshot();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSnapshotBusy(false);
    }
  };
  return (
    <section
      className={`remote-pane pane ${full ? "remote-expanded" : ""}`}
      data-visible={visible}
      aria-label="Remote"
      ref={pane}
    >
      <div className="pane-heading">
        <span>
          <Icon name="remote" />
          Remote
        </span>
        <div className="button-row">
          <span className={`small ${status === "connected" ? "success-text" : "muted"}`}>
            {status === "connected"
              ? "Подключено"
              : status === "connecting"
                ? "Подключаемся…"
                : "Рабочий стол"}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={full ? "Свернуть Remote" : "Развернуть Remote"}
            onClick={() => setFull((v) => !v)}
          >
            <Icon name={full ? "close" : "expand"} />
          </button>
        </div>
      </div>
      {!requested ? (
        <div className="empty-state remote-empty">
          <div className="empty-symbol">
            <Icon name="remote" size={32} />
          </div>
          <h2>Твой компьютер рядом.</h2>
          <p>
            Открой рабочий стол, чтобы
            <br />
            быстро проверить или поправить что-то.
          </p>
          <button
            type="button"
            className="primary"
            disabled={!available}
            onClick={() => setRequested(true)}
          >
            <Icon name="remote" />
            Подключиться
          </button>
          <span className="small muted remote-help">Доступ через личный сервер</span>
        </div>
      ) : (
        <>
          <div className="remote-display" ref={host} />
          {status !== "connected" && (
            <div className="remote-status">
              {error || "Соединение с рабочим столом…"}
              {["error", "disconnected"].includes(status) && (
                <button type="button" className="secondary" onClick={() => setRequested(false)}>
                  Вернуться
                </button>
              )}
            </div>
          )}
          <div className="remote-toolbar">
            <button
              type="button"
              className="secondary"
              onClick={() => sinkRef.current?.focus()}
              disabled={status !== "connected"}
              aria-label="Открыть клавиатуру"
            >
              <Icon name="keyboard" />
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => stroke(0xff1b)}
              disabled={status !== "connected"}
            >
              Esc
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => stroke(0xff09)}
              disabled={status !== "connected"}
            >
              Tab
            </button>
            {[
              [0xffe3, "Ctrl"],
              [0xffe9, "Alt"],
              [0xffeb, "Win"],
            ].map(([code, label]) => (
              <button
                type="button"
                key={code}
                className={`secondary ${held.includes(Number(code)) ? "selected" : ""}`}
                onClick={() => modifier(Number(code))}
                disabled={status !== "connected"}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="remote-options">
            <button
              type="button"
              className="text-button"
              onClick={() => setTouchMode((m) => (m === "trackpad" ? "touch" : "trackpad"))}
            >
              <Icon name="pointer" size={15} />
              {touchMode === "trackpad" ? "Трекпад" : "Касание"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => void snapshot()}
              disabled={!threadId || snapshotBusy || status !== "connected"}
            >
              <Icon name="image" size={15} />
              {snapshotBusy ? "Сохраняем…" : "Снимок"}
            </button>
            <button type="button" className="text-button" onClick={() => setRequested(false)}>
              Отключить
            </button>
          </div>
          {error && status === "connected" && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div ref={inputHost} className="remote-input-host" />
        </>
      )}
    </section>
  );
}

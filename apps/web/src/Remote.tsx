import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import { RemoteInput, type RemoteInputMode, type RemoteMouseState } from "./remoteInput";

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
  sendMouseState: (state: RemoteMouseState, scaled: boolean) => void;
  sendKeyEvent: (pressed: number, code: number) => void;
  getDisplay: () => Display;
  onstatechange: (state: number) => void;
  onsync: () => void;
  onerror: (error: { message: string }) => void;
}
interface Keyboard {
  onkeydown: ((key: number) => boolean) | null;
  onkeyup: ((key: number) => void) | null;
  reset: () => void;
}
interface Guac {
  Client: new (tunnel: unknown) => Client;
  WebSocketTunnel: new (
    url: string,
  ) => { onerror: (e: { message: string }) => void; onstatechange: (state: number) => void };
  Keyboard: new (element: HTMLElement) => Keyboard;
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
function savedMode(profile: string): RemoteInputMode {
  try {
    const value = localStorage.getItem(`codex-remote-mode-${profile}`);
    if (value === "trackpad" || value === "touch") return value;
  } catch {}
  return profile === "phone" ? "trackpad" : "touch";
}
export function Remote({
  projectId,
  threadId,
  visible,
  available,
  onSnapshot,
  onImmersiveChange,
  onBack,
}: {
  projectId: string;
  threadId: string;
  visible: boolean;
  available: boolean;
  onSnapshot: () => void;
  onImmersiveChange: (value: boolean) => void;
  onBack: () => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    inputHost = useRef<HTMLDivElement>(null),
    pane = useRef<HTMLElement>(null),
    cursor = useRef<HTMLSpanElement>(null);
  const clientRef = useRef<Client | undefined>(undefined),
    sinkRef = useRef<HTMLTextAreaElement | undefined>(undefined),
    keyboardRef = useRef<Keyboard | undefined>(undefined),
    inputRef = useRef<RemoteInput | undefined>(undefined),
    modifiers = useRef(new Set<number>());
  const profile = useRef(
    Math.min(window.innerWidth, window.innerHeight) < 600 ? "phone" : "tablet",
  );
  const [requested, setRequested] = useState(false),
    [status, setStatus] = useState("idle"),
    [error, setError] = useState(""),
    [full, setFull] = useState(false),
    [compact, setCompact] = useState(window.innerWidth < 1100 || window.innerHeight < 600),
    [controls, setControls] = useState(false),
    [touchMode, setTouchMode] = useState<RemoteInputMode>(() => savedMode(profile.current)),
    [keyboardActive, setKeyboardActive] = useState(false),
    [snapshotBusy, setSnapshotBusy] = useState(false),
    [held, setHeld] = useState<number[]>([]),
    [zoom, setZoom] = useState(1),
    [sensitivity, setSensitivity] = useState(1);
  const modeRef = useRef(touchMode),
    sensitivityRef = useRef(sensitivity),
    zoomAction = useRef<(factor: number, reset?: boolean) => void>(() => {});
  modeRef.current = touchMode;
  sensitivityRef.current = sensitivity;
  const release = useCallback(() => {
    for (const key of modifiers.current) clientRef.current?.sendKeyEvent(0, key);
    modifiers.current.clear();
    setHeld([]);
  }, []);
  useEffect(() => {
    const update = () => setCompact(window.innerWidth < 1100 || window.innerHeight < 600);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    onImmersiveChange(visible && (full || (requested && compact)));
    return () => onImmersiveChange(false);
  }, [visible, full, requested, compact, onImmersiveChange]);
  useEffect(() => {
    if (!visible) {
      setRequested(false);
      setFull(false);
      setControls(false);
    }
  }, [visible]);
  useEffect(() => {
    inputRef.current?.reset();
    try {
      localStorage.setItem(`codex-remote-mode-${profile.current}`, touchMode);
    } catch {}
  }, [touchMode]);
  useEffect(() => {
    if (!requested || !visible || !host.current) return;
    let disposed = false,
      renderStage: HTMLElement | undefined,
      keyboardSink: HTMLTextAreaElement | undefined,
      client: Client | undefined,
      resize: ResizeObserver | undefined,
      keyboard: Keyboard | undefined,
      input: RemoteInput | undefined,
      raf = 0,
      pending: RemoteMouseState | undefined,
      lastButtons = "";
    setStatus("connecting");
    setError("");
    setZoom(1);
    void loadGuacamole()
      .then((G) => {
        if (disposed || !host.current || !inputHost.current) return;
        const surface = host.current,
          url =
            (location.protocol === "https:" ? "wss://" : "ws://") +
            location.host +
            "/api/projects/" +
            encodeURIComponent(projectId) +
            "/remote";
        const tunnel = new G.WebSocketTunnel(url);
        tunnel.onerror = (e) => {
          if (!disposed) {
            setError(e.message || "Связь с рабочим столом прервалась");
            setStatus("error");
          }
        };
        tunnel.onstatechange = (state) => {
          if (!disposed && state === 2) setStatus("disconnected");
        };
        client = new G.Client(tunnel);
        clientRef.current = client;
        const activeClient = client,
          display = client.getDisplay(),
          element = display.getElement(),
          stage = document.createElement("div");
        renderStage = stage;
        stage.className = "remote-canvas";
        stage.append(element);
        surface.replaceChildren(stage);
        const view = {
          zoom: 1,
          panX: 0,
          panY: 0,
          scale: 1,
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          centered: false,
          kind: modeRef.current === "trackpad" ? "trackpad" : "direct",
        };
        const drawCursor = () => {
          if (cursor.current) {
            cursor.current.style.left = `${view.left + view.x * view.scale}px`;
            cursor.current.style.top = `${view.top + view.y * view.scale}px`;
            cursor.current.dataset.visible = String(view.kind === "trackpad");
          }
        };
        const layout = () => {
          const w = display.getWidth(),
            h = display.getHeight();
          if (!w || !h) return;
          view.scale = Math.min(surface.clientWidth / w, surface.clientHeight / h, 1) * view.zoom;
          const maxX = Math.max(0, (w * view.scale - surface.clientWidth) / 2),
            maxY = Math.max(0, (h * view.scale - surface.clientHeight) / 2);
          view.panX = Math.max(-maxX, Math.min(maxX, view.panX));
          view.panY = Math.max(-maxY, Math.min(maxY, view.panY));
          view.left = (surface.clientWidth - w * view.scale) / 2 + view.panX;
          view.top = (surface.clientHeight - h * view.scale) / 2 + view.panY;
          display.scale(view.scale);
          stage.style.left = `${view.left}px`;
          stage.style.top = `${view.top}px`;
          stage.style.width = `${w * view.scale}px`;
          stage.style.height = `${h * view.scale}px`;
          surface.dataset.zoom = String(view.zoom);
          drawCursor();
        };
        const zoomAround = (
          ratio: number,
          previous: { x: number; y: number },
          current: { x: number; y: number },
        ) => {
          const rect = surface.getBoundingClientRect(),
            point = {
              x: (previous.x - rect.left - view.left) / view.scale,
              y: (previous.y - rect.top - view.top) / view.scale,
            };
          view.zoom = Math.max(1, Math.min(4, view.zoom * ratio));
          const w = display.getWidth(),
            h = display.getHeight(),
            scale = Math.min(surface.clientWidth / w, surface.clientHeight / h, 1) * view.zoom;
          view.panX =
            current.x - rect.left - (surface.clientWidth - w * scale) / 2 - point.x * scale;
          view.panY =
            current.y - rect.top - (surface.clientHeight - h * scale) / 2 - point.y * scale;
          layout();
          setZoom(view.zoom);
        };
        zoomAction.current = (factor, reset = false) => {
          if (reset) {
            view.zoom = 1;
            view.panX = 0;
            view.panY = 0;
            layout();
            setZoom(1);
            return;
          }
          const rect = surface.getBoundingClientRect(),
            center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          zoomAround(factor, center, center);
        };
        const flushMouse = () => {
          raf = 0;
          if (pending && !disposed) {
            activeClient.sendMouseState(pending, false);
            pending = undefined;
          }
        };
        input = new RemoteInput(surface, {
          mode: () => modeRef.current,
          scale: () => view.scale,
          sensitivity: () => sensitivityRef.current,
          direct: (x, y) => {
            const rect = surface.getBoundingClientRect();
            return {
              x: (x - rect.left - view.left) / view.scale,
              y: (y - rect.top - view.top) / view.scale,
            };
          },
          clamp: (x, y) => ({
            x: Math.round(Math.max(0, Math.min(Math.max(0, display.getWidth() - 1), x))),
            y: Math.round(Math.max(0, Math.min(Math.max(0, display.getHeight() - 1), y))),
          }),
          send: (state) => {
            if (disposed) return;
            const buttons = [state.left, state.middle, state.right, state.up, state.down].join(",");
            if (buttons !== lastButtons) {
              if (raf) cancelAnimationFrame(raf);
              flushMouse();
              activeClient.sendMouseState(state, false);
              lastButtons = buttons;
            } else {
              pending = state;
              if (!raf) raf = requestAnimationFrame(flushMouse);
            }
          },
          pointer: (kind) => {
            view.kind = kind;
            display.showCursor(kind === "mouse");
            drawCursor();
          },
          position: (point) => {
            view.x = point.x;
            view.y = point.y;
            if (view.zoom > 1 && view.kind === "trackpad") {
              const x = view.left + view.x * view.scale,
                y = view.top + view.y * view.scale;
              if (x < 36) view.panX += 36 - x;
              else if (x > surface.clientWidth - 36) view.panX -= x - surface.clientWidth + 36;
              if (y < 36) view.panY += 36 - y;
              else if (y > surface.clientHeight - 36) view.panY -= y - surface.clientHeight + 36;
              layout();
            } else drawCursor();
          },
          zoom: zoomAround,
          pan: (dx, dy) => {
            view.panX += dx;
            view.panY += dy;
            layout();
          },
        });
        inputRef.current = input;
        display.onresize = () => {
          layout();
          if (!view.centered && display.getWidth()) {
            view.centered = true;
            input?.setPosition(display.getWidth() / 2, display.getHeight() / 2);
          }
        };
        resize = new ResizeObserver(layout);
        resize.observe(surface);
        display.showCursor(false);
        client.onstatechange = (state) => {
          if (!disposed && state !== 3) setStatus(state === 5 ? "disconnected" : "connecting");
        };
        let frameReady = false;
        client.onsync = () => {
          if (frameReady) return;
          display.flush(() => {
            if (disposed || !display.getWidth() || !display.getHeight()) return;
            const canvas = display.flatten(),
              ctx = canvas.getContext("2d");
            if (
              ctx?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
                .data[3]
            ) {
              frameReady = true;
              setStatus("connected");
              layout();
            }
          });
        };
        client.onerror = (e) => {
          if (!disposed) {
            setError(e.message || "Не удалось подключиться");
            setStatus("error");
          }
        };
        // Keep focus inside the user gesture: InputSink.focus() defers it and iOS can reject it.
        const sinkElement = document.createElement("textarea");
        keyboardSink = sinkElement;
        sinkRef.current = sinkElement;
        sinkElement.className = "remote-keyboard-input";
        sinkElement.rows = 1;
        sinkElement.tabIndex = -1;
        sinkElement.inputMode = "text";
        sinkElement.addEventListener("focus", () => setKeyboardActive(true));
        sinkElement.addEventListener("blur", () => {
          setKeyboardActive(false);
          keyboard?.reset();
          release();
        });
        sinkElement.addEventListener("keypress", () => {
          sinkElement.value = "";
        });
        // Guacamole removes its input listener on compositionstart without restoring it.
        // Keep it attached, and suppress a browser's duplicate final input after the commit.
        let committedText = "";
        sinkElement.addEventListener("compositionstart", (event) => {
          committedText = "";
          event.stopPropagation();
        });
        sinkElement.addEventListener("compositionend", (event) => {
          committedText = event.data;
          sinkElement.value = "";
          window.setTimeout(() => {
            committedText = "";
          }, 0);
        });
        sinkElement.addEventListener("input", (event) => {
          if (!event.isComposing) {
            if (committedText && event.data === committedText) event.stopPropagation();
            committedText = "";
            sinkElement.value = "";
          }
        });
        sinkElement.setAttribute("aria-label", "Клавиатура удалённого рабочего стола");
        sinkElement.setAttribute("autocapitalize", "off");
        sinkElement.setAttribute("autocomplete", "off");
        sinkElement.setAttribute("autocorrect", "off");
        sinkElement.setAttribute("spellcheck", "false");
        inputHost.current.replaceChildren(sinkElement);
        keyboardRef.current ??= new G.Keyboard(pane.current ?? surface);
        keyboard = keyboardRef.current;
        const keyboardFocused = () =>
          surface.contains(document.activeElement) ||
          !!inputHost.current?.contains(document.activeElement);
        keyboard.onkeydown = (key) => {
          if (!keyboardFocused()) return true;
          activeClient.sendKeyEvent(1, key);
          return false;
        };
        keyboard.onkeyup = (key) => {
          activeClient.sendKeyEvent(0, key);
          if (![0xffe3, 0xffe9, 0xffeb].includes(key)) release();
        };
        client.connect(
          "width=" +
            Math.max(320, Math.round(surface.clientWidth)) +
            "&height=" +
            Math.max(240, Math.round(surface.clientHeight)),
        );
      })
      .catch((e) => {
        if (!disposed) {
          setError(messageOf(e));
          setStatus("error");
        }
      });
    const blur = () => {
      keyboard?.reset();
      input?.reset();
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
      blur();
      input?.dispose();
      if (keyboard) {
        keyboard.onkeydown = null;
        keyboard.onkeyup = null;
      }
      sinkRef.current?.blur();
      setKeyboardActive(false);
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      pending = undefined;
      resize?.disconnect();
      client?.disconnect();
      clientRef.current = undefined;
      sinkRef.current = undefined;
      inputRef.current = undefined;
      renderStage?.remove();
      keyboardSink?.remove();
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [requested, visible, projectId, release]);
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
      setControls(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSnapshotBusy(false);
    }
  };
  const expand = () => {
    setFull((value) => !value);
    if (!full && pane.current?.requestFullscreen)
      void pane.current.requestFullscreen().catch(() => {});
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  };
  useEffect(() => {
    const change = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  const connected = status === "connected";
  return (
    <section
      className={`remote-pane pane ${full ? "remote-expanded" : ""} ${requested ? "remote-session" : ""}`}
      data-visible={visible}
      data-input-mode={touchMode}
      aria-label="Remote"
      ref={pane}
    >
      {!requested ? (
        <div key="remote-empty" className="empty-state remote-empty">
          <div className="empty-symbol">
            <Icon name="remote" size={32} />
          </div>
          <span className="eyebrow">Рабочий стол</span>
          <h2>Компьютер под рукой.</h2>
          <p>
            На телефоне — трекпад.
            <br />
            На планшете — касание и стилус.
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
          <span className="small muted remote-help">Управление по защищённому соединению</span>
        </div>
      ) : (
        <>
          <div key="remote-screen" className="remote-screen">
            <div
              className="remote-display"
              data-ready={connected}
              ref={host}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: This application surface accepts remote keyboard input.
              tabIndex={0}
              role="application"
              aria-label="Удалённый рабочий стол"
            />
            <span className="remote-cursor" ref={cursor} aria-hidden="true" />
          </div>
          <div className="remote-topbar">
            <button
              type="button"
              className="remote-fab"
              aria-label="Назад к чату"
              onClick={() => {
                setRequested(false);
                setFull(false);
                if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
                onBack();
              }}
            >
              <Icon name="back" />
            </button>
            <span className="remote-connection-label">
              <span className={`status-dot ${connected ? "online" : "checking"}`} />
              {connected ? "Подключено" : "Соединение…"}
            </span>
          </div>
          {!connected && (
            <div className="remote-status" role="status">
              {status === "connecting" && <span className="spinner" />}
              <p>
                {error ||
                  (status === "disconnected" ? "Соединение завершено" : "Подключаем рабочий стол…")}
              </p>
              {["error", "disconnected"].includes(status) && (
                <button type="button" className="secondary" onClick={() => setRequested(false)}>
                  Подключиться снова
                </button>
              )}
            </div>
          )}
          <div className="remote-dock">
            <button
              type="button"
              className={`remote-fab ${keyboardActive ? "selected" : ""}`}
              aria-label={keyboardActive ? "Скрыть клавиатуру" : "Открыть клавиатуру"}
              aria-pressed={keyboardActive}
              disabled={!connected}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const field = sinkRef.current;
                if (!field) return;
                if (document.activeElement === field) field.blur();
                else {
                  field.focus({ preventScroll: true });
                  field.setSelectionRange(0, 0);
                }
              }}
            >
              <Icon name="keyboard" />
            </button>
            <button
              type="button"
              className="remote-fab"
              aria-label={full ? "Свернуть Remote" : "Развернуть Remote"}
              onClick={expand}
            >
              <Icon name="expand" />
            </button>
            <button
              type="button"
              className={`remote-fab ${controls ? "selected" : ""}`}
              aria-label="Управление Remote"
              aria-expanded={controls}
              onClick={() => setControls((value) => !value)}
            >
              <Icon name="more" />
            </button>
          </div>
          {controls && (
            <fieldset className="remote-control-panel" aria-label="Настройки Remote">
              <div className="remote-control-heading">
                <strong>Управление</strong>
                <button
                  type="button"
                  className="remote-fab"
                  aria-label="Скрыть управление"
                  onClick={() => setControls(false)}
                >
                  <Icon name="close" size={18} />
                </button>
              </div>
              <div className="remote-mode-switch">
                {(["trackpad", "touch"] as const).map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    className={mode === touchMode ? "selected" : ""}
                    aria-pressed={mode === touchMode}
                    onClick={() => setTouchMode(mode)}
                  >
                    <Icon name={mode} />
                    {mode === "trackpad" ? "Трекпад" : "Касание"}
                  </button>
                ))}
              </div>
              <div className="remote-zoom-controls">
                <button
                  type="button"
                  aria-label="Уменьшить рабочий стол"
                  onClick={() => zoomAction.current(1 / 1.4)}
                >
                  <Icon name="minus" />
                </button>
                <button
                  type="button"
                  onClick={() => zoomAction.current(1, true)}
                  aria-label="Вписать рабочий стол"
                >
                  {Math.round(zoom * 100)}% · Вписать
                </button>
                <button
                  type="button"
                  aria-label="Увеличить рабочий стол"
                  onClick={() => zoomAction.current(1.4)}
                >
                  <Icon name="plus" />
                </button>
              </div>
              <div className="remote-key-row">
                <button
                  type="button"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => stroke(0xff1b)}
                  disabled={!connected}
                >
                  Esc
                </button>
                <button
                  type="button"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => stroke(0xff09)}
                  disabled={!connected}
                >
                  Tab
                </button>
                {(
                  [
                    [0xffe3, "Ctrl"],
                    [0xffe9, "Alt"],
                    [0xffeb, "Win"],
                  ] as const
                ).map(([code, label]) => (
                  <button
                    type="button"
                    key={code}
                    onPointerDown={(e) => e.preventDefault()}
                    className={held.includes(code) ? "selected" : ""}
                    aria-pressed={held.includes(code)}
                    disabled={!connected}
                    onClick={() => modifier(code)}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => stroke(0xff0d)}
                  disabled={!connected}
                >
                  ↵
                </button>
              </div>
              <details className="remote-gesture-help">
                <summary>
                  <Icon name="help" size={16} />
                  Жесты и точность
                </summary>
                <p>
                  {touchMode === "trackpad"
                    ? "Один палец двигает указатель, касание нажимает. Два пальца прокручивают; касание двумя пальцами — правая кнопка. Двойное касание с удержанием перетаскивает."
                    : "Касание нажимает в выбранной точке. Движение пальцем перетаскивает. Стилус управляет напрямую. Два пальца двигают увеличенный экран."}{" "}
                  Щипок меняет масштаб.
                </p>
                {touchMode === "trackpad" && (
                  <label>
                    Скорость указателя
                    <input
                      aria-label="Скорость указателя"
                      type="range"
                      min="0.5"
                      max="2"
                      step="0.1"
                      value={sensitivity}
                      onChange={(e) => setSensitivity(Number(e.target.value))}
                    />
                  </label>
                )}
              </details>
              <div className="remote-panel-actions">
                <button
                  type="button"
                  disabled={!threadId || snapshotBusy || !connected}
                  onClick={() => void snapshot()}
                >
                  <Icon name="image" size={17} />
                  {snapshotBusy ? "Сохраняем…" : "Снимок"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRequested(false);
                    setControls(false);
                  }}
                >
                  Отключить
                </button>
              </div>
            </fieldset>
          )}
          {error && connected && (
            <p className="remote-inline-error" role="alert">
              {error}
            </p>
          )}
          <div ref={inputHost} className="remote-input-host" />
        </>
      )}
    </section>
  );
}

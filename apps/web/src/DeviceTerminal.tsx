import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { workspaceSocket } from "./accountStorage.ts";
import { ApiError, api } from "./api";
import { Icon } from "./icons";
import "@xterm/xterm/css/xterm.css";

export function DeviceTerminal({ id, onExit }: { id: string; onExit: () => void }) {
  const host = useRef<HTMLElement>(null),
    termRef = useRef<Terminal | null>(null),
    socketRef = useRef<WebSocket | null>(null),
    exitRef = useRef(onExit);
  exitRef.current = onExit;
  const [status, setStatus] = useState("Подключаемся…"),
    [failed, setFailed] = useState(false),
    [connected, setConnected] = useState(false);
  const retryRef = useRef(() => {});
  useEffect(() => {
    if (!host.current) return;
    let stopped = false,
      socket: WebSocket | undefined,
      ready = false,
      ended = false,
      connecting = false,
      attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined,
      deadline: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      scrollback: 2000,
      allowProposedApi: false,
      convertEol: false,
      screenReaderMode: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    termRef.current = term;
    // Never let remote OSC sequences write the device clipboard.
    const clipboard = term.parser.registerOscHandler(52, () => true);
    const theme = () => {
      const css = getComputedStyle(document.documentElement);
      term.options.theme = {
        background: css.getPropertyValue("--paper").trim() || "#11151b",
        foreground: css.getPropertyValue("--ink").trim() || "#dce4ed",
        cursor: css.getPropertyValue("--accent").trim() || "#bed1ec",
        selectionBackground: "#71869e66",
      };
    };
    theme();
    const themes = new MutationObserver(theme);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const resize = () => {
      if (!host.current?.clientWidth || !host.current?.clientHeight) return;
      fit.fit();
      if (socket?.readyState === 1)
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: Math.min(300, Math.max(2, term.cols)),
            rows: Math.min(150, Math.max(2, term.rows)),
          }),
        );
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    resize();
    const data = term.onData((value) => {
      if (!ready || socket?.readyState !== 1) return;
      for (let i = 0; i < value.length; i += 1024)
        socket.send(JSON.stringify({ type: "input", data: value.slice(i, i + 1024) }));
    });
    const cancelTimers = () => {
      clearTimeout(timer);
      clearTimeout(deadline);
    };
    const fail = (message: string, permanent = false) => {
      if (stopped || ended) return;
      connecting = false;
      ready = false;
      setConnected(false);
      clearTimeout(deadline);
      if (!permanent && attempts < 3) {
        setStatus("Соединение…");
        setFailed(false);
        clearTimeout(timer);
        timer = setTimeout(() => void connect(), 800 * 2 ** attempts++);
      } else {
        setStatus(message);
        setFailed(true);
      }
    };
    const connect = async () => {
      if (stopped || ended || connecting || document.hidden) return;
      connecting = true;
      ready = false;
      setConnected(false);
      setFailed(false);
      setStatus("Соединение…");
      const previous = socket;
      socket = undefined;
      socketRef.current = null;
      previous?.close();
      try {
        const { ticket } = await api<{ ticket: string }>(`/device-terminals/${id}/ticket`, {
          method: "POST",
          signal: abort.signal,
          timeoutMs: 15000,
        });
        if (stopped) return;
        const url = new URL(`/api/device-terminals/${id}/socket`, location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const current = workspaceSocket(url);
        socket = current;
        socketRef.current = current;
        deadline = setTimeout(() => {
          if (!ready) current.close();
        }, 12000);
        current.onopen = () => current.send(JSON.stringify({ ticket }));
        current.onmessage = (e) => {
          if (stopped || socket !== current) return;
          const msg = JSON.parse(e.data);
          if (msg.type === "ready") {
            connecting = false;
            clearTimeout(deadline);
            ready = msg.state === "open";
            ended = !ready;
            setConnected(ready);
            setFailed(false);
            setStatus(ready ? "Подключено" : "Сессия завершена");
            // Every attach replays the server's bounded screen. Replace it, never append twice.
            term.write("", () => term.reset());
            resize();
            timer = setTimeout(() => {
              attempts = 0;
            }, 10000);
          }
          if (msg.type === "output" && typeof msg.data === "string")
            term.write(msg.data, () => {
              if (!stopped && socket === current && current.readyState === 1)
                current.send(JSON.stringify({ type: "ack", length: msg.data.length }));
            });
          if (msg.type === "exit") {
            ended = true;
            ready = false;
            cancelTimers();
            setConnected(false);
            setFailed(false);
            setStatus(
              msg.exitCode === null ? "Сессия завершена" : `Завершено · код ${msg.exitCode}`,
            );
            exitRef.current();
          }
        };
        current.onclose = (e) => {
          if (socket === current && !stopped && !ended) {
            clearTimeout(timer);
            fail("Не удалось восстановить связь с терминалом.", e.code === 1008);
          }
        };
        current.onerror = () => current.close();
      } catch (e) {
        if (stopped) return;
        const permanent = e instanceof ApiError && [401, 403, 404, 410].includes(e.status);
        if (e instanceof ApiError && e.status === 410) {
          ended = true;
          setStatus(e.message);
          setConnected(false);
          setFailed(false);
        } else fail(e instanceof Error ? e.message : "Нет связи с терминалом", permanent);
      }
    };
    retryRef.current = () => {
      attempts = 0;
      cancelTimers();
      void connect();
    };
    const wake = () => {
      if (!document.hidden && !ready && !connecting && !ended) retryRef.current();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    void connect();
    return () => {
      stopped = true;
      cancelTimers();
      retryRef.current = () => {};
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      abort.abort();
      socket?.close();
      socketRef.current = null;
      data.dispose();
      clipboard.dispose();
      observer.disconnect();
      themes.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [id]);
  const input = (data: string) => {
    if (connected && socketRef.current?.readyState === 1)
      socketRef.current.send(JSON.stringify({ type: "input", data }));
    termRef.current?.focus();
  };
  return (
    <div className="device-terminal">
      <div className="device-terminal-status">
        <span className={connected ? "online" : ""}>{status}</span>
        {failed && (
          <button
            type="button"
            className="icon-button"
            title="Подключиться снова"
            aria-label="Подключиться снова"
            onClick={() => retryRef.current()}
          >
            <Icon name="refresh" size={17} />
          </button>
        )}
      </div>
      <section className="device-terminal-screen" ref={host} aria-label="Терминал устройства" />
      <div className="device-terminal-keys" role="toolbar" aria-label="Клавиши терминала">
        <button
          type="button"
          onClick={() => termRef.current?.focus()}
          aria-label="Открыть клавиатуру"
        >
          <Icon name="keyboard" />
        </button>
        {[
          ["Esc", "\u001b"],
          ["Tab", "\t"],
          ["Ctrl C", "\u0003"],
          ["↑", "\u001b[A"],
          ["↓", "\u001b[B"],
          ["←", "\u001b[D"],
          ["→", "\u001b[C"],
        ].map(([label, key]) => (
          <button type="button" key={label} disabled={!connected} onClick={() => input(key ?? "")}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

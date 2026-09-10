import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import "@xterm/xterm/css/xterm.css";

export function DeviceTerminal({ id, onExit }: { id: string; onExit: () => void }) {
  const host = useRef<HTMLElement>(null),
    termRef = useRef<Terminal | null>(null),
    socketRef = useRef<WebSocket | null>(null),
    exitRef = useRef(onExit);
  exitRef.current = onExit;
  const [status, setStatus] = useState("Подключаемся…"),
    [retry, setRetry] = useState(0),
    [connected, setConnected] = useState(false);
  useEffect(() => {
    void retry;
    if (!host.current) return;
    let stopped = false,
      socket: WebSocket | undefined;
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
      if (socket?.readyState !== 1) return;
      for (let i = 0; i < value.length; i += 1024)
        socket.send(JSON.stringify({ type: "input", data: value.slice(i, i + 1024) }));
    });
    setConnected(false);
    setStatus("Подключаемся…");
    void api<{ ticket: string }>(`/device-terminals/${id}/ticket`, {
      method: "POST",
      signal: abort.signal,
    })
      .then(({ ticket }) => {
        if (stopped) return;
        const url = new URL(`/api/device-terminals/${id}/socket`, location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(url);
        socketRef.current = socket;
        socket.onopen = () => socket?.send(JSON.stringify({ ticket }));
        socket.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === "ready") {
            setConnected(msg.state === "open");
            setStatus(msg.state === "open" ? "Подключено" : "Сессия завершена");
            resize();
          }
          if (msg.type === "output" && typeof msg.data === "string")
            term.write(msg.data, () => {
              if (!stopped && socket?.readyState === 1)
                socket.send(JSON.stringify({ type: "ack", length: msg.data.length }));
            });
          if (msg.type === "exit") {
            setConnected(false);
            setStatus(
              msg.exitCode === null ? "Сессия завершена" : `Завершено · код ${msg.exitCode}`,
            );
            exitRef.current();
          }
        };
        socket.onclose = () => {
          if (!stopped) {
            setConnected(false);
            setStatus("Соединение закрыто");
          }
        };
        socket.onerror = () => {
          if (!stopped) setStatus("Не удалось подключиться");
        };
      })
      .catch((e) => {
        if (!stopped) setStatus(e.message);
      });
    return () => {
      stopped = true;
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
  }, [id, retry]);
  const input = (data: string) => {
    if (connected && socketRef.current?.readyState === 1)
      socketRef.current.send(JSON.stringify({ type: "input", data }));
    termRef.current?.focus();
  };
  return (
    <div className="device-terminal">
      <div className="device-terminal-status">
        <span className={connected ? "online" : ""}>{status}</span>
        <button
          type="button"
          className="icon-button"
          title="Подключиться снова"
          aria-label="Подключиться снова"
          onClick={() => setRetry((v) => v + 1)}
        >
          <Icon name="refresh" size={17} />
        </button>
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

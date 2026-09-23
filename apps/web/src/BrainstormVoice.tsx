import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceUrl } from "./accountStorage";
import { messageOf } from "./api";

export function BrainstormVoice({ roomId, closed }: { roomId: string; closed: boolean }) {
  const [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [muted, setMuted] = useState(true),
    [deafened, setDeafened] = useState(false),
    [error, setError] = useState("");
  const [peers, setPeers] = useState<
    { id: number; name: string; muted: boolean; deafened: boolean }[]
  >([]);
  const active = useRef<{
      socket: WebSocket;
      context: AudioContext;
      stream: MediaStream;
      node: AudioWorkletNode;
    } | null>(null),
    generation = useRef(0),
    live = useRef(true);
  const leave = useCallback(() => {
    generation.current++;
    const current = active.current;
    active.current = null;
    if (current) {
      current.stream.getTracks().forEach((t) => {
        t.stop();
      });
      current.socket.close();
      current.node.disconnect();
      void current.context.close();
    }
    if (live.current) {
      setConnected(false);
      setBusy(false);
      setPeers([]);
    }
  }, []);
  // All microphone resources belong to this mounted room, including late getUserMedia replies.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      leave();
    };
  }, [leave]);
  useEffect(() => {
    if (closed) leave();
  }, [closed, leave]);
  const join = async () => {
    if (active.current || busy) return;
    const serial = ++generation.current;
    setBusy(true);
    setError("");
    let context: AudioContext | null = null,
      stream: MediaStream | null = null,
      socket: WebSocket | null = null;
    try {
      context = new AudioContext();
      await context.resume();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      await context.audioWorklet.addModule("/brainstorm-audio.js");
      if (serial !== generation.current) throw Error("cancelled");
      const node = new AudioWorkletNode(context, "brainstorm-audio", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      context.createMediaStreamSource(stream).connect(node);
      node.connect(context.destination);
      const url = new URL(workspaceUrl(`/api/team/brainstorm/${roomId}/voice`), location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      const current = { socket, context, stream, node };
      active.current = current;
      let opened = false;
      const timeout = setTimeout(() => {
        if (!opened && active.current === current) {
          setError("Не удалось подключиться к разговору.");
          leave();
        }
      }, 12000);
      socket.onopen = () => {
        opened = true;
        clearTimeout(timeout);
        if (active.current !== current) return;
        setBusy(false);
        setConnected(true);
        setMuted(true);
        setDeafened(false);
      };
      socket.onclose = () => {
        clearTimeout(timeout);
        if (active.current === current) {
          setError("Голосовая связь прервалась. Подключитесь снова.");
          leave();
        }
      };
      socket.onerror = () => {
        if (active.current === current) {
          setError("Голосовая связь недоступна.");
          leave();
        }
      };
      socket.onmessage = (e) => {
        if (active.current !== current) return;
        if (e.data instanceof ArrayBuffer) {
          if (e.data.byteLength !== 1284) return;
          const id = new DataView(e.data).getUint32(0, true),
            buffer = e.data.slice(4);
          node.port.postMessage({ type: "pcm", id, buffer }, [buffer]);
        } else {
          try {
            const value = JSON.parse(e.data);
            if (value.type === "peers" && Array.isArray(value.peers))
              setPeers(value.peers.slice(0, 8));
          } catch {}
        }
      };
      node.port.onmessage = ({ data }) => {
        if (
          active.current === current &&
          socket?.readyState === WebSocket.OPEN &&
          socket.bufferedAmount < 16000
        )
          socket.send(data.buffer);
      };
      stream.getAudioTracks().forEach((t) => {
        t.enabled = false;
        t.onended = () => {
          if (active.current === current) leave();
        };
      });
    } catch (e) {
      stream?.getTracks().forEach((t) => {
        t.stop();
      });
      socket?.close();
      if (context && context.state !== "closed") void context.close();
      if (serial === generation.current && live.current) {
        leave();
        setError(
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "Разрешите микрофон для голосового разговора."
            : messageOf(e),
        );
      }
    }
  };
  const state = (mute: boolean, deafen: boolean) => {
    setMuted(mute);
    setDeafened(deafen);
    const c = active.current;
    if (!c) return;
    c.stream.getAudioTracks().forEach((t) => {
      t.enabled = !mute;
    });
    c.node.port.postMessage({ type: "state", muted: mute, deafened: deafen });
    if (c.socket.readyState === WebSocket.OPEN)
      c.socket.send(JSON.stringify({ type: "state", muted: mute, deafened: deafen }));
  };
  return (
    <div className="brainstorm-voice">
      {!connected ? (
        <button
          className="secondary"
          type="button"
          aria-label="Голосовой разговор"
          disabled={closed || busy}
          onClick={() => void join()}
        >
          {busy ? "Подключаемся…" : "Голос"}
        </button>
      ) : (
        <>
          <div className="brainstorm-voice-controls">
            <button
              className="secondary"
              type="button"
              aria-pressed={!muted}
              onClick={() => state(!muted, deafened)}
            >
              {muted ? "Включить микрофон" : "Микрофон включён"}
            </button>
            <button
              className="secondary"
              type="button"
              aria-pressed={!deafened}
              onClick={() => state(muted, !deafened)}
            >
              {deafened ? "Включить звук" : "Выключить звук"}
            </button>
            <button className="secondary" type="button" onClick={leave}>
              Выйти
            </button>
          </div>
          <small>
            {peers.map((p) => `${p.name}${p.muted ? " · микр. выкл." : ""}`).join("; ")}
          </small>
        </>
      )}
      {error && <small role="status">{error}</small>}
    </div>
  );
}

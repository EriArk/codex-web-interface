import type { GptMessage } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, messageOf } from "./api";
import { CollapsibleCode } from "./CollapsibleCode";
import { DownloadLink } from "./DownloadLink";
import { Icon } from "./icons";
import { MarkdownTable } from "./MarkdownTable";

type Version = {
  nodeId: string;
  messageId: string;
  current: boolean;
  text: string;
  createdAt: number;
};
export function GptVersions({
  nativeId,
  messageId,
  onClose,
  onContinue,
}: {
  nativeId: string;
  messageId: string;
  onClose: () => void;
  onContinue: (currentNode: string, targetMessageId: string) => void;
}) {
  const [items, setItems] = useState<Version[]>([]),
    [selected, setSelected] = useState(""),
    [messages, setMessages] = useState<GptMessage[]>([]),
    [current, setCurrent] = useState(""),
    [older, setOlder] = useState(false),
    [truncated, setTruncated] = useState(false),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    serial = useRef(0),
    alive = useRef(true);
  const base = `/gpt/conversations/${encodeURIComponent(nativeId)}/messages/${encodeURIComponent(messageId)}/versions`;
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController(),
      focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    api<{ currentNode: string; items: Version[]; truncated?: boolean }>(base, {
      signal: controller.signal,
    })
      .then((v) => {
        if (alive.current) {
          setItems(v.items);
          setTruncated(v.truncated === true);
          setCurrent(v.currentNode);
          setBusy(false);
        }
      })
      .catch((e) => {
        if (alive.current) {
          setError(messageOf(e));
          setBusy(false);
        }
      });
    return () => {
      alive.current = false;
      serial.current++;
      controller.abort();
      dialog.current?.close();
      focus?.focus({ preventScroll: true });
    };
  }, [base]);
  const choose = async (target: string) => {
    const version = ++serial.current;
    setSelected(target);
    setBusy(true);
    setError("");
    setMessages([]);
    try {
      const value = await api<{ currentNode: string; messages: GptMessage[]; hasOlder: boolean }>(
        base + "?targetMessageId=" + encodeURIComponent(target),
      );
      if (alive.current && version === serial.current) {
        setMessages(value.messages);
        setCurrent(value.currentNode);
        setOlder(value.hasOlder);
      }
    } catch (e) {
      if (alive.current && version === serial.current) setError(messageOf(e));
    } finally {
      if (alive.current && version === serial.current) setBusy(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="quick-capture-dialog gpt-versions-dialog"
      tabIndex={-1}
      aria-label="Версии сообщения"
      onCancel={onClose}
    >
      <header>
        <Icon name="history" />
        <h2>Версии сообщения</h2>
        <button type="button" className="icon-button" aria-label="Закрыть версии" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="quick-capture-content">
        <p>
          Просмотр сохраняет текущий чат. Продолжение создаёт отдельную ветку ChatGPT с твоим первым
          сообщением.
        </p>
        <div className="gpt-version-list">
          {items.map((item, index) => (
            <button
              type="button"
              className="secondary"
              aria-pressed={selected === item.messageId}
              key={item.messageId}
              onClick={() => void choose(item.messageId)}
            >
              <strong>
                Версия {index + 1}
                {item.current ? " · текущая" : ""}
              </strong>
              <span>{item.text || "Сообщение с вложением"}</span>
            </button>
          ))}
        </div>
        {!busy && items.length < 2 && <p>Других доступных версий у этого сообщения нет.</p>}
        {busy && <p role="status">Загружаем версию…</p>}
        {error && <p role="alert">{error}</p>}
        {!!messages.length && (
          <section className="gpt-version-preview" aria-label="Просмотр версии">
            {older && <p>Показаны последние 20 сообщений выбранной версии.</p>}
            {messages.map((message) => (
              <article key={message.id}>
                <b>{message.role === "user" ? "Вы" : "GPT"}</b>
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{ pre: CollapsibleCode, table: MarkdownTable }}
                >
                  {message.text}
                </Markdown>
                {message.files.map((file) => (
                  <DownloadLink key={file.id} href={file.url} name={file.name}>
                    {file.name}
                  </DownloadLink>
                ))}
                {message.unsupported?.length && <p>Часть содержимого доступна в ChatGPT.</p>}
              </article>
            ))}
          </section>
        )}
        <footer>
          <button
            type="button"
            className="primary"
            disabled={busy || !!error || !messages.length}
            onClick={() => onContinue(current, selected)}
          >
            Продолжить в новом чате
          </button>
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}

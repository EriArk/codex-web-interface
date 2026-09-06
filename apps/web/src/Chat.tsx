import { type FormEvent, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { AttachmentList, useAttachments } from "./AttachmentPicker";
import { ComposerOptions, useTurnSettings } from "./ComposerOptions";
import { Icon } from "./icons";
import type { Approval, Result, TurnSettings } from "./types";
import type { ChatState } from "./useWorkspace";

const positions = new Map<string, number>();
const MessageText = memo(function MessageText({ text }: { text: string }) {
  return (
    <Markdown
      components={{ a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
    >
      {text}
    </Markdown>
  );
});
const time = (date: string) =>
  date ? new Date(date).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" }) : "";
export const statusLabel = (status: string) =>
  ({
    running: "Codex работает",
    starting: "Запускаем задачу",
    waiting_approval: "Нужен твой ответ",
    completed: "Готово",
    interrupted: "Остановлено",
    failed: "Нужна проверка",
    unknown: "Проверь состояние диалога",
    idle: "Готов к работе",
  })[status] ?? "Готов к работе";
function ApprovalCard({
  approval,
  busy,
  onDecision,
  onAnswer,
}: {
  approval: Approval;
  busy: boolean;
  onDecision: (id: string, decision: "accept" | "decline") => void;
  onAnswer: (id: string, answers: Record<string, string[]>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <section className="approval" aria-label="Запрос Codex">
      <div className="eyebrow">Твоё решение</div>
      {approval.kind === "question" ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onAnswer(
              approval.id,
              Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [v]])),
            );
          }}
        >
          {(approval.questions ?? []).map((q) => (
            <fieldset key={q.id}>
              <legend>{q.question}</legend>
              {q.options.map((option) => (
                <label className="choice" key={option.label}>
                  <input
                    type="radio"
                    name={q.id}
                    checked={answers[q.id] === option.label}
                    onChange={() => setAnswers((v) => ({ ...v, [q.id]: option.label }))}
                  />
                  <span>
                    {option.label}
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
              <input
                aria-label={`Свой ответ: ${q.question}`}
                type={q.isSecret ? "password" : "text"}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((v) => ({ ...v, [q.id]: e.target.value }))}
                placeholder="Можно написать свой ответ"
                required
                maxLength={8000}
              />
            </fieldset>
          ))}
          <button type="submit" className="primary" disabled={busy}>
            Ответить
            <Icon name="send" />
          </button>
        </form>
      ) : (
        <>
          <h3>
            {approval.kind === "files"
              ? "Разрешить изменение файлов?"
              : approval.kind === "permissions"
                ? "Разрешить доступ?"
                : "Разрешить выполнение команды?"}
          </h3>
          <pre>{approval.description}</pre>
          {approval.permissions !== undefined && (
            <pre>{JSON.stringify(approval.permissions, null, 2)}</pre>
          )}
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => onDecision(approval.id, "decline")}
            >
              Отклонить
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => onDecision(approval.id, "accept")}
            >
              <Icon name="check" />
              Разрешить
            </button>
          </div>
        </>
      )}
    </section>
  );
}
export function Chat({
  projectId,
  threadId,
  state,
  visible,
  busy,
  results,
  focusTurn,
  onSend,
  onStop,
  onOlder,
  onCreate,
  onDecision,
  onAnswer,
  onResult,
  onReconnect,
  onLatest,
}: {
  projectId: string;
  threadId: string;
  state: ChatState;
  visible: boolean;
  busy: boolean;
  results: Result[];
  focusTurn: string;
  onSend: (text: string, settings: TurnSettings, attachments: string[]) => Promise<boolean>;
  onStop: () => void;
  onOlder: () => Promise<void>;
  onCreate: () => void;
  onDecision: (id: string, d: "accept" | "decline") => void;
  onAnswer: (id: string, a: Record<string, string[]>) => void;
  onResult: (id: string) => void;
  onReconnect: () => void;
  onLatest: () => void;
}) {
  const options = useTurnSettings(projectId, threadId, state.thread.settings);
  const attachments = useAttachments(threadId),
    fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true),
    previousThread = useRef(""),
    pendingHeight = useRef<number | undefined>(undefined);
  const [draft, setDraft] = useState(""),
    [newMessages, setNewMessages] = useState(false);
  const active = ["running", "starting", "waiting_approval"].includes(state.thread.status);
  useEffect(() => {
    try {
      setDraft(sessionStorage.getItem(`codex-draft-${threadId}`) ?? "");
    } catch {
      setDraft("");
    }
  }, [threadId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll positioning runs after message DOM changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !visible) return;
    if (previousThread.current !== threadId) {
      previousThread.current = threadId;
      el.scrollTop = positions.get(threadId) ?? el.scrollHeight;
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      return;
    }
    if (pendingHeight.current !== undefined && !state.loadingOlder) {
      el.scrollTop += el.scrollHeight - pendingHeight.current;
      pendingHeight.current = undefined;
      return;
    }
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
      setNewMessages(false);
    } else setNewMessages(true);
  }, [threadId, state.messages, state.loadingOlder, visible]);
  useEffect(() => {
    if (!visible || !focusTurn) return;
    requestAnimationFrame(() => {
      const target = scroller.current?.querySelector<HTMLElement>(
        `[data-turn="${CSS.escape(focusTurn)}"]`,
      );
      target?.scrollIntoView({ block: "center" });
      target?.classList.add("message-focus");
      setTimeout(() => target?.classList.remove("message-focus"), 2000);
    });
  }, [focusTurn, visible]);
  const saveDraft = (value: string) => {
    setDraft(value);
    try {
      sessionStorage.setItem(`codex-draft-${threadId}`, value);
    } catch {
      /* Storage may be unavailable in private mode. */
    }
  };
  const send = async () => {
    if (
      (!draft.trim() && !attachments.files.length) ||
      busy ||
      active ||
      attachments.busy ||
      options.saving ||
      state.loading ||
      !options.selection
    )
      return;
    const value = draft;
    if (
      await onSend(
        value,
        options.selection,
        attachments.files.map((f) => f.id),
      )
    ) {
      saveDraft("");
      attachments.clear();
      composer.current?.focus();
    }
  };
  const older = async () => {
    pendingHeight.current = scroller.current?.scrollHeight;
    await onOlder();
  };
  return (
    <section className="chat-pane pane" aria-label="Чат" data-visible={visible}>
      <div className="pane-heading">
        <span>
          <Icon name="chat" />
          Чат
        </span>
        <span className="small muted">
          {threadId ? statusLabel(state.thread.status) : "Начни с диалога"}
        </span>
      </div>
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          positions.set(threadId, el.scrollTop);
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          if (atBottom.current) setNewMessages(false);
        }}
      >
        {(state.contextTurn || state.hasNewer) && (
          <div className="history-loader">
            <span className="small muted">
              {state.contextTurn ? "Фрагмент диалога" : "В Codex появились новые сообщения"}
            </span>
            <button type="button" className="secondary" onClick={onLatest}>
              К последним сообщениям
            </button>
          </div>
        )}
        {!threadId ? (
          <div className="empty-state chat-empty">
            <div className="empty-symbol">
              <Icon name="chat" size={30} />
            </div>
            <div className="eyebrow">Рабочее пространство</div>
            <h2>С чего начнём?</h2>
            <p>
              Открой диалог или создай новый.
              <br />
              Код и инструменты уже на твоём компьютере.
            </p>
            <button type="button" className="primary" onClick={onCreate} disabled={busy}>
              <Icon name="plus" />
              Новый диалог
            </button>
          </div>
        ) : state.loading ? (
          <div className="empty-state">
            <span className="spinner" />
            Открываем диалог…
          </div>
        ) : (
          <>
            {state.hasMore && (
              <div className="history-loader">
                <button
                  type="button"
                  className="secondary"
                  disabled={state.loadingOlder}
                  onClick={() => void older()}
                >
                  {state.loadingOlder ? "Загружаем…" : "Загрузить предыдущие"}
                </button>
                <small>По 20 сообщений за раз</small>
              </div>
            )}
            {!state.messages.length && (
              <div className="empty-state chat-empty">
                <div className="empty-symbol">
                  <Icon name="folder" size={30} />
                </div>
                <h2>Новый диалог, чистый лист.</h2>
                <p>
                  Опиши задачу внизу.
                  <br />
                  Проверки и снимки появятся в результатах.
                </p>
              </div>
            )}
            {state.messages.map((message) => (
              <article
                className={
                  "message " +
                  message.role +
                  " " +
                  (message.phase === "commentary" ? "commentary-message" : "")
                }
                key={message.id}
                data-turn={message.turnId ?? ""}
                data-message={message.id}
              >
                <div className="message-meta">
                  <span className="avatar">{message.role === "user" ? "Я" : "C"}</span>
                  <strong>{message.role === "user" ? "Вы" : "Codex"}</strong>
                  <time>{time(message.createdAt)}</time>
                  {message.phase === "plan" && <span className="badge">План</span>}
                  {message.phase === "commentary" && <span className="small muted">В работе</span>}
                </div>
                <div className="message-body">
                  <MessageText text={message.text} />
                  {!message.text && !message.attachments?.length && (
                    <span className="typing">•••</span>
                  )}
                  <AttachmentList files={message.attachments ?? []} />
                </div>
                {message.role === "assistant" &&
                  message.phase !== "commentary" &&
                  results.some((r) => r.turnId === message.turnId) && (
                    <button
                      type="button"
                      className="result-chip"
                      onClick={() =>
                        onResult(results.find((r) => r.turnId === message.turnId)?.id ?? "")
                      }
                    >
                      <Icon name="results" size={15} />
                      Результаты этого хода
                      <Icon name="chevron" size={14} />
                    </button>
                  )}
              </article>
            ))}
            {state.approvals.map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                busy={busy}
                onDecision={onDecision}
                onAnswer={onAnswer}
              />
            ))}
            {active && !state.approvals.length && (
              <div className="working">
                <span className="pulse" />
                {statusLabel(state.thread.status)}
              </div>
            )}
          </>
        )}
      </div>
      {newMessages && (
        <button
          type="button"
          className="new-message-button secondary"
          onClick={() => {
            atBottom.current = true;
            setNewMessages(false);
            if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
          }}
        >
          К новым сообщениям ↓
        </button>
      )}
      {threadId && state.error && (
        <div className="notice error-notice" role="alert">
          <span>{state.error}</span>
          <button
            type="button"
            onClick={onReconnect}
            className="icon-button"
            aria-label="Восстановить соединение"
          >
            <Icon name="refresh" />
          </button>
        </div>
      )}
      {threadId && state.thread.status === "unknown" && (
        <button type="button" className="secondary recovery-button" onClick={onReconnect}>
          <Icon name="refresh" />
          Восстановить диалог
        </button>
      )}
      <form
        className="composer"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (!busy && !active) void attachments.add(e.dataTransfer.files);
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <ComposerOptions
          options={options}
          disabled={!threadId || state.loading || busy || active}
        />
        <AttachmentList
          files={attachments.files}
          disabled={busy || active || attachments.busy}
          onRemove={(id) => void attachments.remove(id)}
        />
        {(attachments.error || attachments.busy) && (
          <div className="composer-error" role="status">
            {attachments.busy ? "Загружаем вложение…" : attachments.error}
          </div>
        )}
        <div className="composer-input">
          <input
            ref={fileInput}
            className="file-input"
            type="file"
            multiple
            aria-label="Выбрать файлы или изображения"
            disabled={!threadId || busy || active || attachments.busy}
            onChange={(e) => {
              if (e.target.files) void attachments.add(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="icon-button attach-button"
            aria-label="Добавить файлы или изображения"
            disabled={
              !threadId || busy || active || attachments.busy || attachments.files.length >= 8
            }
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="plus" />
          </button>
          <textarea
            ref={composer}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                if (!busy && !active) void attachments.add(e.clipboardData.files);
              }
            }}
            rows={2}
            value={draft}
            onChange={(e) => saveDraft(e.target.value)}
            placeholder={threadId ? "Что нужно сделать?" : "Создай диалог, чтобы начать"}
            aria-label="Сообщение Codex"
            disabled={!threadId}
            maxLength={32000}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {active ? (
            <button
              type="button"
              className="stop-button"
              onClick={onStop}
              disabled={busy}
              aria-label="Остановить Codex"
            >
              <Icon name="stop" />
            </button>
          ) : (
            <button
              type="submit"
              className="send-button"
              disabled={
                !threadId ||
                (!draft.trim() && !attachments.files.length) ||
                busy ||
                attachments.busy ||
                state.loading ||
                options.loading ||
                options.saving ||
                !options.selection ||
                state.thread.status === "unknown"
              }
              aria-label="Отправить сообщение"
            >
              <Icon name="send" />
            </button>
          )}
        </div>
        <div className="composer-hint">
          <span>Enter — новая строка</span>
          <span>⌘ / Ctrl + Enter — отправить</span>
        </div>
      </form>
    </section>
  );
}

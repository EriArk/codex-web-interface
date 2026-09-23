import { hasUnreadCompletion, type ResultCategory, type ThreadActivity } from "@codex-web/shared";
import {
  type FormEvent,
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AccessPicker } from "./AccessPicker";
import {
  type ArtifactRequest,
  artifactSource,
  messageCode,
  useArtifactComponents,
} from "./ArtifactMarkdown";
import { AttachmentList, useAttachments } from "./AttachmentPicker";
import { accountSessionStorage as sessionStorage, workspaceMediaUrl } from "./accountStorage.ts";
import { api } from "./api";
import { ComposerOptions, useTurnSettings } from "./ComposerOptions";
import { ConnectionRecovery, type RecoveryOutcome } from "./ConnectionRecovery";
import { ContextUsage } from "./ContextUsage";
import { CopyButton } from "./CopyButton";
import { useDictation } from "./Dictation";
import { Icon } from "./icons";
import { MarkdownTable } from "./MarkdownTable";
import { MessageQueue, useMessageQueue } from "./MessageQueue";
import { SpeechButton, useSpeechScope } from "./MessageSpeech";
import { NativePlan } from "./NativePlan";
import { clearAcknowledgedSend, matchesPendingSend } from "./pendingSend";
import { TurnDetails } from "./TurnDetails";
import { useCompletionPosition } from "./useCompletionPosition";
import { useGrowingComposer } from "./useGrowingComposer";
import "./taskBoundary.css";
import { ElicitationCard } from "./ElicitationCard";
import type { Approval, Message, Result, TurnSettings } from "./types";
import { UpdateNotice } from "./UpdateNotice";
import type { ChatState } from "./useWorkspace";
import { useWebHandoff } from "./WebHandoff";
import { useThreadReviews, WorkReviewLink } from "./WorkReviewLink";

const positions = new Map<string, number>();
const MessageText = memo(function MessageText({
  text,
  onArtifact,
  resolveImage,
  complete,
}: {
  text: string;
  onArtifact?: (source: string) => void;
  resolveImage?: (source: string) => Promise<string | undefined>;
  complete?: boolean;
}) {
  const artifacts = useArtifactComponents(onArtifact, resolveImage);
  return (
    <Markdown
      urlTransform={(url) => (onArtifact && artifactSource(url) ? url : defaultUrlTransform(url))}
      remarkPlugins={[remarkGfm]}
      components={{
        pre: messageCode(text, onArtifact, complete),
        table: MarkdownTable,
        ...artifacts,
      }}
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
function endsTask(
  message: Message,
  next: Message | undefined,
  activeTurn: string | null,
  status: string,
): boolean {
  return (
    !!message.turnId &&
    message.turnId !== activeTurn &&
    next?.turnId !== message.turnId &&
    (!!next ||
      message.phase === "final_answer" ||
      ["completed", "interrupted", "failed"].includes(status))
  );
}
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
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  if (approval.kind === "elicitation" && approval.elicitation)
    return (
      <ElicitationCard
        key={approval.id}
        id={approval.id}
        form={approval.elicitation}
        disabled={busy}
      />
    );
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
                    checked={!custom[q.id] && answers[q.id] === option.label}
                    onChange={() => {
                      setCustom((v) => ({ ...v, [q.id]: false }));
                      setAnswers((v) => ({ ...v, [q.id]: option.label }));
                    }}
                  />
                  <span>
                    {option.label}
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
              {q.options.length > 0 && (
                <label className="choice">
                  <input
                    type="radio"
                    name={q.id}
                    checked={custom[q.id] === true}
                    onChange={() => {
                      setCustom((v) => ({ ...v, [q.id]: true }));
                      setAnswers((v) => ({ ...v, [q.id]: "" }));
                    }}
                  />
                  <span>Свой вариант</span>
                </label>
              )}
              {(!q.options.length || custom[q.id]) && (
                <input
                  autoComplete="off"
                  aria-label={`Свой ответ: ${q.question}`}
                  type={q.isSecret ? "password" : "text"}
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers((v) => ({ ...v, [q.id]: e.target.value }))}
                  placeholder="Можно написать свой ответ"
                  required
                  maxLength={8000}
                />
              )}
            </fieldset>
          ))}
          <button
            type="submit"
            className="primary"
            disabled={busy || !(approval.questions ?? []).every((q) => answers[q.id]?.trim())}
          >
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
  machineId,
  projectId,
  threadId,
  state,
  sending,
  sendError,
  writeBlocked,
  visible,
  busy,
  results,
  focusTurn,
  focusMessage,
  onSend,
  onStop,
  onOlder,
  onCreate,
  onDecision,
  onAnswer,
  onResult,
  onArtifact,
  onReconnect,
  onLatest,
  completion,
  canMarkSeen,
  speechVisible,
  onCapture,
}: {
  onCapture?: (message: Message) => void;
  completion?: ThreadActivity;
  canMarkSeen: boolean;
  speechVisible: boolean;
  machineId?: string;
  projectId: string;
  threadId: string;
  state: ChatState;
  sending: boolean;
  sendError: string;
  writeBlocked: boolean;
  visible: boolean;
  busy: boolean;
  results: Result[];
  focusTurn: string;
  focusMessage?: string;
  onSend: (text: string, settings: TurnSettings, attachments: string[]) => Promise<boolean>;
  onStop: () => void;
  onOlder: () => Promise<void>;
  onCreate: () => void;
  onDecision: (id: string, d: "accept" | "decline") => void;
  onAnswer: (id: string, a: Record<string, string[]>) => void;
  onResult: (id: string, category?: ResultCategory) => void;
  onArtifact?: (request: ArtifactRequest) => void;
  onReconnect: () => Promise<RecoveryOutcome>;
  onLatest: () => void;
}) {
  const speechScope = `codex:${threadId}`;
  const reviews = useThreadReviews("codex", threadId);
  useSpeechScope(speechScope, visible && speechVisible);
  const handoff = useWebHandoff(machineId, threadId);
  const queue = useMessageQueue(threadId);
  const options = useTurnSettings(projectId, threadId, state.thread.settings);
  const attachments = useAttachments(threadId),
    fileInput = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true),
    previousThread = useRef(""),
    pendingHeight = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = scroller.current,
      body = content.current;
    if (!el || !body || !visible) return;
    // Fonts, result chips and the software keyboard can resize a settled chat.
    // Keep following its end only while the reader has not scrolled away.
    const resize = new ResizeObserver(() => {
      if (atBottom.current && pendingHeight.current === undefined) el.scrollTop = el.scrollHeight;
    });
    resize.observe(el);
    resize.observe(body);
    return () => resize.disconnect();
  }, [visible]);
  const seenRequest = useRef("");
  useEffect(() => {
    const el = scroller.current;
    if (
      !el ||
      !completion ||
      !hasUnreadCompletion(completion) ||
      !visible ||
      !canMarkSeen ||
      state.loading ||
      state.contextTurn ||
      state.hasNewer ||
      state.lastSeq < completion.completedSeq
    )
      return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const key = `${threadId}:${completion.completedSeq}`;
    const check = () => {
      clearTimeout(timer);
      if (
        document.visibilityState !== "visible" ||
        el.scrollHeight - el.scrollTop - el.clientHeight >= 100 ||
        seenRequest.current === key
      )
        return;
      timer = setTimeout(() => {
        if (
          document.visibilityState !== "visible" ||
          el.scrollHeight - el.scrollTop - el.clientHeight >= 100
        )
          return;
        seenRequest.current = key;
        void api(`/threads/${threadId}/seen`, {
          method: "POST",
          body: { completedSeq: completion.completedSeq },
        }).catch(() => {
          seenRequest.current = "";
          if (!disposed) timer = setTimeout(check, 5000);
        });
      }, 1000);
    };
    check();
    document.addEventListener("visibilitychange", check);
    el.addEventListener("scroll", check, { passive: true });
    return () => {
      disposed = true;
      clearTimeout(timer);
      el.removeEventListener("scroll", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [
    threadId,
    completion,
    visible,
    canMarkSeen,
    state.loading,
    state.contextTurn,
    state.hasNewer,
    state.lastSeq,
  ]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Collapse details when switching conversations.
  useEffect(() => {
    setDetailsOpen(false);
  }, [threadId]);
  const [draft, setDraft] = useState(""),
    [newMessages, setNewMessages] = useState(false);
  const active = ["running", "starting", "waiting_approval"].includes(state.thread.status);
  const external = state.thread.activitySource === "external";
  useLayoutEffect(() => {
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
  const liveTurn = useRef("");
  const liveScope = useRef("");
  if (liveScope.current !== threadId) {
    liveScope.current = threadId;
    liveTurn.current = "";
  }
  if (active && state.thread.activeTurnId) liveTurn.current = state.thread.activeTurnId;
  const finalMessage = state.messages.findLast(
    (m) =>
      m.turnId === liveTurn.current &&
      m.role === "assistant" &&
      m.phase !== "commentary" &&
      m.phase !== "analysis",
  );
  const completionLocked = useCompletionPosition({
    scope: threadId,
    enabled:
      visible &&
      speechVisible &&
      !state.contextTurn &&
      !state.hasNewer &&
      !focusMessage &&
      !focusTurn,
    following: atBottom,
    scroller,
    content,
    entries: liveTurn.current
      ? [
          {
            id: liveTurn.current,
            active,
            complete: state.thread.status === "completed",
            target: finalMessage?.id ?? "",
          },
        ]
      : [],
  });
  useEffect(() => {
    if (!visible || (!focusTurn && !focusMessage)) return;
    atBottom.current = false;
    requestAnimationFrame(() => {
      const target = scroller.current?.querySelector<HTMLElement>(
        focusMessage
          ? `[data-message="${CSS.escape(focusMessage)}"]`
          : `[data-turn="${CSS.escape(focusTurn)}"]`,
      );
      target?.scrollIntoView({ block: "center" });
      target?.classList.add("message-focus");
      setTimeout(() => target?.classList.remove("message-focus"), 2000);
    });
  }, [focusTurn, focusMessage, visible]);
  useGrowingComposer(composer, draft);
  const saveDraft = (value: string) => {
    setDraft(value);
    try {
      sessionStorage.setItem(`codex-draft-${threadId}`, value);
      clearAcknowledgedSend("codex:" + threadId);
    } catch {
      /* Storage may be unavailable in private mode. */
    }
  };
  const dictation = useDictation(
    "codex:" + threadId,
    !!threadId && visible && speechVisible && !handoff.pending && !busy,
    draft,
    saveDraft,
    32000,
    (text) => send(text),
  );
  const pendingRetry = matchesPendingSend(
    "codex:" + threadId,
    JSON.stringify({
      threadId,
      text: draft,
      settings: options.selection,
      attachments: attachments.files.map((f) => f.id),
    }),
  );
  const send = async (dictated?: string) => {
    const value = dictated ?? draft;
    if (
      (dictation.locked && dictated === undefined) ||
      (!value.trim() && !attachments.files.length) ||
      busy ||
      queue.busy ||
      handoff.pending ||
      (active && !external && !pendingRetry && !queue.state.available) ||
      attachments.busy ||
      options.saving ||
      (state.loading && !(active && queue.state.available)) ||
      !options.selection
    )
      return;
    const selection = options.selection,
      fileIds = attachments.files.map((f) => f.id);
    if (
      await handoff.run((returned) =>
        active && !external && !returned && !pendingRetry
          ? queue.add(value, fileIds)
          : onSend(value, selection, fileIds),
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
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          positions.set(threadId, el.scrollTop);
          if (!completionLocked.current)
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          if (atBottom.current) setNewMessages(false);
        }}
      >
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
        <div className="chat-content" ref={content}>
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
                </div>
              )}
              {!state.messages.length &&
                !state.approvals.length &&
                !state.hasMore &&
                !state.error && (
                  <div className="empty-state chat-empty">
                    <div className="empty-symbol">
                      <Icon name="folder" size={30} />
                    </div>
                    <h2>Новый диалог, чистый лист.</h2>
                  </div>
                )}
              {state.messages.map((message, index) => (
                <Fragment key={message.id}>
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
                      {message.phase === "commentary" && (
                        <span className="small muted">В работе</span>
                      )}
                      <span className="message-actions">
                        {message.role === "assistant" && (
                          <SpeechButton id={`${speechScope}:${message.id}`} text={message.text} />
                        )}
                        {onCapture && message.text.trim() && (
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Сохранить в заметки"
                            onClick={() => onCapture(message)}
                          >
                            <Icon name="file" size={17} />
                          </button>
                        )}
                        <CopyButton text={message.text} />
                      </span>
                    </div>
                    <div className="message-body">
                      <MessageText
                        text={message.text}
                        complete={
                          message.phase !== "commentary" &&
                          message.turnId !== state.thread.activeTurnId
                        }
                        resolveImage={
                          message.role === "assistant"
                            ? async (source) =>
                                (
                                  await api<Result>(
                                    `/threads/${encodeURIComponent(threadId)}/results/reveal`,
                                    {
                                      method: "POST",
                                      body: {
                                        source,
                                        messageId: message.id,
                                        turnId: message.turnId,
                                      },
                                    },
                                  )
                                ).payload.url
                            : undefined
                        }
                        onArtifact={
                          message.role === "assistant" && onArtifact
                            ? (source) =>
                                onArtifact({
                                  scope: threadId,
                                  endpoint: `/threads/${encodeURIComponent(threadId)}/results/reveal`,
                                  reference: {
                                    source,
                                    messageId: message.id,
                                    turnId: message.turnId,
                                  },
                                })
                            : undefined
                        }
                      />
                      {!message.text && !message.attachments?.length && (
                        <span className="typing">•••</span>
                      )}
                      <AttachmentList
                        files={[
                          ...(message.attachments ?? []),
                          ...(message.images ?? []).map((image) => ({
                            ...image,
                            threadId,
                            messageId: message.id,
                            mime: "image/png",
                            bytes: 0,
                            image: true,
                            previewUrl: image.url,
                            createdAt: "",
                          })),
                        ]}
                      />
                      {message.role === "assistant" &&
                        message.phase !== "commentary" &&
                        !/!\[[^\]]*\]\(/.test(message.text) &&
                        !state.messages
                          .slice(index + 1)
                          .some(
                            (next) => next.role === "assistant" && next.turnId === message.turnId,
                          ) && (
                          <div className="message-file-links">
                            {results
                              .filter(
                                (result) =>
                                  result.type === "image" &&
                                  result.turnId === message.turnId &&
                                  (!result.threadId || result.threadId === threadId) &&
                                  result.payload.url,
                              )
                              .map((result) => (
                                <span
                                  key={result.id}
                                  className={
                                    /^https?:\/\//i.test(result.payload.url!)
                                      ? "message-web-image"
                                      : "message-generated-image"
                                  }
                                >
                                  <button
                                    type="button"
                                    aria-label={result.title}
                                    onClick={() =>
                                      onArtifact
                                        ? onArtifact({ scope: threadId, result })
                                        : onResult(result.id)
                                    }
                                  >
                                    <img
                                      src={workspaceMediaUrl(result.payload.url)}
                                      alt={result.title}
                                      loading="lazy"
                                      referrerPolicy="no-referrer"
                                    />
                                  </button>
                                </span>
                              ))}
                          </div>
                        )}
                    </div>
                    {message.role === "assistant" &&
                      message.phase === "plan" &&
                      state.messages.findLast((m) => m.phase === "plan")?.id === message.id && (
                        <NativePlan
                          key={threadId + ":" + message.id}
                          threadId={threadId}
                          messageId={message.id}
                          revision={`${state.thread.status}:${state.thread.activeTurnId ?? ""}:${state.messages.at(-1)?.id ?? ""}`}
                          visible={visible}
                          disabled={busy || writeBlocked || queue.busy}
                        />
                      )}
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
                  {endsTask(
                    message,
                    state.messages[index + 1],
                    state.thread.activeTurnId,
                    state.thread.status,
                  ) && (
                    <div className="task-boundary">
                      <hr aria-label="Конец задачи" />
                      <span aria-hidden="true">Конец задачи</span>
                      <div className="task-boundary-line" aria-hidden="true" />
                      {reviews
                        .filter((r) => r.turnId === message.turnId)
                        .map((r) => (
                          <WorkReviewLink key={r.id} scope={r.scope} id={r.id} state={r.state} />
                        ))}
                    </div>
                  )}
                </Fragment>
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
            </>
          )}
        </div>
      </div>
      <UpdateNotice visible={visible} busy={busy || attachments.busy} />
      {threadId && (
        <ConnectionRecovery
          key={threadId}
          needed={state.thread.status === "unknown"}
          error={state.error}
          disabled={busy || !visible}
          onRecover={onReconnect}
        />
      )}
      {(sending || queue.busy || active) && (
        <div
          className={`turn-status ${state.approvals.length ? "needs-answer" : ""}`}
          role="status"
          aria-live="polite"
        >
          <button
            type="button"
            className="turn-status-toggle"
            aria-label="Ход работы"
            aria-expanded={detailsOpen}
            aria-controls="turn-details"
            onClick={() => setDetailsOpen((v) => !v)}
          >
            <span
              className={state.approvals.length ? "status-dot attention" : "spinner"}
              role="img"
              aria-label={state.approvals.length ? "Нужен ответ" : "Codex работает"}
            />
            <span>
              {queue.busy
                ? "Передаём сообщение…"
                : sending
                  ? attachments.files.length
                    ? "Передаём вложения…"
                    : "Отправляем сообщение…"
                  : state.approvals.length
                    ? "Codex ждёт твоего ответа"
                    : state.thread.activitySource === "external"
                      ? "Codex работает в другом клиенте"
                      : state.progress || statusLabel(state.thread.status)}
            </span>
            <span className="details-chevron">
              <Icon name="chevron" size={14} />
            </span>
          </button>
          {active && (draft.trim() || attachments.files.length > 0) && (
            <button
              type="button"
              className="text-button"
              aria-label="Остановить Codex"
              disabled={busy || state.thread.activitySource === "external"}
              onClick={onStop}
            >
              Остановить
            </button>
          )}
          {state.approvals.length > 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                scroller.current?.querySelector(".approval")?.scrollIntoView({ block: "center" })
              }
            >
              К вопросу ↑
            </button>
          )}
        </div>
      )}
      {detailsOpen && (sending || queue.busy || active) && (
        <TurnDetails threadId={threadId} turnId={state.thread.activeTurnId} />
      )}
      {handoff.panel}
      <ContextUsage key={`context:${threadId}`} threadId={threadId} active={active} />
      {sendError && (
        <div className="send-error" role="alert">
          <span>{sendError}</span>
          {writeBlocked && (
            <button
              type="button"
              className="secondary"
              disabled={busy || attachments.busy}
              onClick={onReconnect}
            >
              Проверить доступ
            </button>
          )}
        </div>
      )}
      {active && !queue.state.available && queue.state.message && (
        <div className="composer-error" role="status">
          {queue.state.message}
        </div>
      )}
      <MessageQueue key={threadId} queue={queue} turnId={state.thread.activeTurnId} />
      {dictation.panel}
      <form
        className="composer"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (!busy && !handoff.pending && !queue.busy) void attachments.add(e.dataTransfer.files);
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <ComposerOptions
          options={options}
          disabled={!threadId || state.loading || busy || active}
          effortDisabled={!threadId || (state.loading && !active) || busy}
        />
        <AttachmentList
          files={attachments.files}
          disabled={busy || handoff.pending || queue.busy || attachments.busy}
          onRemove={(id) => void attachments.remove(id)}
        />
        {(attachments.error || attachments.busy) && (
          <div className="composer-error" role="status">
            {attachments.busy ? attachments.progress || "Загружаем вложение…" : attachments.error}
          </div>
        )}
        {(state.loading || options.loading || sending || queue.busy) && (
          <div className="composer-loading" role="status" aria-label="Загрузка чата Codex">
            <span className="spinner" aria-hidden="true" />
          </div>
        )}
        <div className="composer-input">
          <input
            ref={fileInput}
            className="file-input"
            type="file"
            multiple
            aria-label="Выбрать файлы или изображения"
            disabled={!threadId || busy || handoff.pending || queue.busy || attachments.busy}
            onChange={(e) => {
              if (e.target.files) void attachments.add(e.target.files);
              e.target.value = "";
            }}
          />
          <div className="composer-tools">
            <button
              type="button"
              className="icon-button attach-button"
              aria-label="Добавить файлы или изображения"
              disabled={
                !threadId ||
                busy ||
                handoff.pending ||
                queue.busy ||
                attachments.busy ||
                attachments.files.length >= 8
              }
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="plus" />
            </button>
            <AccessPicker
              options={options}
              disabled={
                !threadId ||
                state.loading ||
                busy ||
                (active && state.thread.activitySource === "external")
              }
            />
          </div>
          <textarea
            ref={composer}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                if (!busy && !handoff.pending && !queue.busy)
                  void attachments.add(e.clipboardData.files);
              }
            }}
            rows={2}
            value={draft}
            onChange={(e) => saveDraft(e.target.value)}
            placeholder={threadId ? "Что нужно сделать?" : "Создай диалог, чтобы начать"}
            aria-label="Сообщение Codex"
            disabled={!threadId || handoff.pending}
            maxLength={32000}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-submit">
            {dictation.button}
            {active && !draft.trim() && !attachments.files.length ? (
              <button
                type="button"
                className="stop-button"
                onClick={onStop}
                disabled={busy || state.thread.activitySource === "external"}
                aria-label="Остановить Codex"
              >
                <Icon name="stop" />
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                disabled={
                  dictation.locked ||
                  !threadId ||
                  (!draft.trim() && !attachments.files.length) ||
                  busy ||
                  queue.busy ||
                  handoff.pending ||
                  (active && !external && !pendingRetry && !queue.state.available) ||
                  attachments.busy ||
                  (state.loading && !(active && queue.state.available)) ||
                  options.loading ||
                  options.saving ||
                  !options.selection ||
                  state.thread.status === "unknown"
                }
                aria-label={active && !pendingRetry ? "Добавить в очередь" : "Отправить сообщение"}
              >
                <Icon name={active && !pendingRetry ? "plus" : "send"} />
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}

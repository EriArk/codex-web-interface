import type {
  Capabilities,
  GitHubActivitySource,
  IntakeState,
  NotebookLink,
  ProjectAction,
  ResultItem,
  TurnSettings,
} from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivitySourceWindow } from "./ActivitySourceWindow";
import type { ArtifactRequest } from "./ArtifactMarkdown";
import { accountLocalStorage as storage } from "./accountStorage";
import { api, messageOf } from "./api";
import { ApprovalCard, MessageText } from "./Chat";
import { ComposerOptions } from "./ComposerOptions";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { ProjectActionPanel } from "./ProjectAction";
import { ResultFeed } from "./ResultFeed";
import type { Approval } from "./types";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./intake.css";

type Props = {
  projectId: string;
  name: string;
  sources?: string[];
  onWork?: (target: NotebookLink) => void;
};
export function IntakeButton(props: Props & { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={props.className ?? "secondary"}
        onClick={() => setOpen(true)}
      >
        <Icon name="search" size={16} />
        {props.label ?? "Разобрать входящее"}
      </button>
      {open && <IntakeWindow key={props.projectId} {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
export function IntakeWindow({
  projectId,
  name,
  sources = [],
  onWork,
  onClose,
}: Props & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const path = `/projects/${encodeURIComponent(projectId)}/intake`,
    draftKey = `intake-draft:${projectId}`,
    sendKey = `intake-send:${projectId}`;
  const [data, setData] = useState<IntakeState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => storage.getItem(draftKey) ?? ""),
    [refs, setRefs] = useState(() =>
      sources.length ? sources.join(" ") : (storage.getItem(`intake-refs:${projectId}`) ?? ""),
    );
  const [caps, setCaps] = useState<Capabilities>(),
    [settings, setSettings] = useState<TurnSettings>();
  const [review, setReview] = useState<{ messageId: string; text: string } | null>(() => {
      try {
        return JSON.parse(storage.getItem(`intake-review:${projectId}`) ?? "null");
      } catch {
        return null;
      }
    }),
    [action, setAction] = useState<ProjectAction | null>(null);
  const [source, setSource] = useState<(GitHubActivitySource & { repositoryId: number }) | null>(
      null,
    ),
    [native, setNative] = useState("");
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false),
    [artifact, setArtifact] = useState<ArtifactRequest | null>(null);
  const live = useRef(true),
    lock = useRef(false),
    scroll = useRef<HTMLDivElement>(null),
    before = useRef<IntakeState["before"]>(null);
  const merge = useCallback((next: IntakeState, older = false) => {
    if (!live.current) return;
    setData((old) => ({
      ...next,
      messages:
        old && old.threadId === next.threadId && old.revision === next.revision
          ? [
              ...new Map(
                (older
                  ? [...next.messages, ...old.messages]
                  : [...old.messages, ...next.messages]
                ).map((m) => [m.id, m]),
              ).values(),
            ]
          : next.messages,
    }));
  }, []);
  useEffect(() => {
    storage.setItem(`intake-refs:${projectId}`, refs);
  }, [refs, projectId]);
  useEffect(() => {
    storage.setItem(`intake-review:${projectId}`, JSON.stringify(review));
  }, [review, projectId]);
  useEffect(() => {
    storage.setItem(draftKey, draft);
  }, [draft, draftKey]);
  useEffect(() => {
    live.current = true;
    let reading = false;
    void api<Capabilities>(`/projects/${projectId}/capabilities`)
      .then((v) => {
        if (live.current) {
          setCaps(v);
          setSettings((s) => s ?? v.defaults);
        }
      })
      .catch((e) => live.current && setError(messageOf(e)));
    void api<IntakeState>(path)
      .then(async (s) => {
        merge(s);
        if (s.threadId) {
          const h = await api<IntakeState>(path + "/history", { method: "POST", body: {} });
          before.current = h.before;
          merge(h);
        }
      })
      .catch((e) => live.current && setError(messageOf(e)));
    const timer = setInterval(async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        merge(await api<IntakeState>(path));
      } catch {
      } finally {
        reading = false;
      }
    }, 2500);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [path, projectId, merge]);
  const act = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (live.current) setError(messageOf(e));
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  const send = () =>
    act(async () => {
      if (!data || !settings) return;
      const body = {
        text: draft,
        sources: refs.trim() ? refs.trim().split(/[\s,]+/) : [],
        revision: data.revision,
        settings,
      };
      const value = JSON.stringify(body);
      let saved: { key: string; value: string } | null = null;
      try {
        saved = JSON.parse(storage.getItem(sendKey) ?? "null");
      } catch {}
      const key = saved?.value === value ? saved.key : crypto.randomUUID();
      storage.setItem(sendKey, JSON.stringify({ key, value }));
      if (JSON.parse(storage.getItem(sendKey) ?? "null")?.key !== key)
        throw Error("Не удалось сохранить квитанцию отправки.");
      const next = await api<IntakeState>(path + "/send", { method: "POST", key, body });
      if (live.current) {
        merge(next);
        setDraft("");
        storage.removeItem(sendKey);
        requestAnimationFrame(() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight }));
      }
    });
  const onAction = useCallback(
    (value: ProjectAction) => {
      setAction(value);
      storage.setItem(`intake-action:${projectId}`, value.id);
    },
    [projectId],
  );
  useEffect(() => {
    const id = storage.getItem(`intake-action:${projectId}`);
    if (id)
      void api<ProjectAction>(`/workspace/actions/${id}`)
        .then((v) => live.current && setAction(v))
        .catch(() => {});
  }, [projectId]);
  const prepare = () =>
    act(async () => {
      if (!review || !data) return;
      const body = { ...review, revision: data.revision };
      const value = JSON.stringify(body),
        storeKey = `intake-handoff:${projectId}`;
      let saved: { key: string; value: string } | null = null;
      try {
        saved = JSON.parse(storage.getItem(storeKey) ?? "null");
      } catch {}
      const key = saved?.value === value ? saved.key : crypto.randomUUID();
      storage.setItem(storeKey, JSON.stringify({ key, value }));
      if (JSON.parse(storage.getItem(storeKey) ?? "null")?.key !== key)
        throw Error("Не удалось сохранить квитанцию передачи.");
      const result = await api<ProjectAction>(path + "/handoff", { method: "POST", key, body });
      if (live.current) {
        onAction(result);
        setReview(null);
      }
    });
  const running =
    !!data && ["running", "starting", "waiting_approval", "unknown"].includes(data.status);
  return (
    <dialog
      ref={dialog}
      className="intake-window workspace-window"
      aria-label={`Разбор · ${name}`}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="panel-heading notebook-heading">
        <div>
          <h2>Разбор входящего</h2>
          <small>{name} · Только чтение</small>
        </div>
        {data?.threadId && (
          <button
            type="button"
            className="icon-button"
            aria-label="Результаты разбора"
            onClick={() => {
              setArtifact(null);
              setResultsOpen(true);
            }}
          >
            <Icon name="folder" />
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Закрыть разбор" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="intake-scroll shared-scroll" ref={scroll}>
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {!data && <p role="status">Загружаю…</p>}
        {data && !data.threadId && !data.creationUnknown && (
          <p className="muted">
            Опиши задачу или выбери источники. Codex изучит код и подготовит план. Реализация
            запускается отдельно.
          </p>
        )}
        {before.current !== null && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const page = await api<IntakeState>(path + "/history", {
                  method: "POST",
                  body: { before: String(before.current) },
                });
                before.current = page.before;
                merge(page, true);
              })
            }
          >
            Ранее
          </button>
        )}
        {data?.messages.map((m) => (
          <article className="intake-message" key={m.id}>
            <header>
              <strong>{m.role === "user" ? "Вы" : "Codex · разбор"}</strong>
              <CopyButton text={m.text} />
            </header>
            <MessageText
              text={m.text}
              complete={!running}
              onArtifact={
                m.role === "assistant"
                  ? (source) => {
                      setArtifact({
                        scope: data.threadId!,
                        endpoint: `/threads/${data.threadId}/results/reveal`,
                        reference: { source, messageId: m.id, turnId: m.turnId },
                      });
                      setResultsOpen(true);
                    }
                  : undefined
              }
              resolveImage={
                m.role === "assistant"
                  ? async (source) =>
                      (
                        await api<ResultItem>(`/threads/${data.threadId}/results/reveal`, {
                          method: "POST",
                          body: { source, messageId: m.id, turnId: m.turnId },
                        })
                      ).payload.url as string | undefined
                  : undefined
              }
            />
            {m.role === "assistant" && !running && (
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setReview({ messageId: m.id, text: m.text });
                  setAction(null);
                }}
              >
                Подготовить к работе
              </button>
            )}
          </article>
        ))}
        {!!data?.requests.some((r) => r.sources.length) && (
          <details className="intake-sources">
            <summary>Источники</summary>
            {[
              ...new Map(data.requests.flatMap((r) => r.sources).map((s) => [s.key, s])).values(),
            ].map((s) => (
              <button
                className="secondary"
                type="button"
                key={s.key}
                onClick={() => {
                  const [kind, n] = s.key.split(":");
                  setSource({
                    key: s.key,
                    repositoryId: s.repositoryId,
                    kind: kind as GitHubActivitySource["kind"],
                    title: s.title,
                    url: s.url,
                    ...(kind === "commit" ? { sha: n } : { number: Number(n) }),
                    at: "",
                    author: null,
                    authorName: "",
                  });
                }}
              >
                {s.title}
              </button>
            ))}
          </details>
        )}
        {data?.approvals.map((value) => {
          const a = value as unknown as Approval;
          return a.kind === "question" ? (
            <ApprovalCard
              key={a.id}
              approval={a}
              busy={busy}
              onDecision={() => {}}
              onAnswer={(id, answers) =>
                void act(async () => {
                  await api(`/approvals/${id}/answers`, {
                    method: "POST",
                    key: crypto.randomUUID(),
                    body: { answers },
                  });
                  merge(await api<IntakeState>(path));
                })
              }
            />
          ) : (
            <button
              key={a.id}
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api(`/approvals/${a.id}${a.kind === "elicitation" ? "/elicitation" : ""}`, {
                    method: "POST",
                    key: crypto.randomUUID(),
                    body:
                      a.kind === "elicitation" ? { action: "decline" } : { decision: "decline" },
                  });
                  merge(await api<IntakeState>(path));
                })
              }
            >
              Продолжить без дополнительного доступа
            </button>
          );
        })}
        {review && (
          <section className="intake-review">
            <h3>Передача в рабочий чат</h3>
            <p className="muted">
              Проверь интерпретацию, план, открытые вопросы и критерии проверки.
            </p>
            <textarea
              aria-label="Пакет для работы"
              value={review.text}
              maxLength={6000}
              rows={10}
              onChange={(e) => setReview({ ...review, text: e.target.value })}
            />
            <div className="intake-actions">
              <button
                type="button"
                disabled={busy || !review.text.trim() || review.text.length > 6000}
                onClick={() => void prepare()}
              >
                Проверить передачу
              </button>
              <button type="button" className="secondary" onClick={() => setReview(null)}>
                Отмена
              </button>
            </div>
          </section>
        )}
        {action && (
          <ProjectActionPanel
            initial={action}
            onChange={onAction}
            onOpen={(target) => {
              onWork?.(target);
              onClose();
            }}
            onClose={() => {
              setAction(null);
              storage.removeItem(`intake-action:${projectId}`);
            }}
          />
        )}
        {(data?.creationUnknown || data?.status === "missing") && (
          <details open>
            <summary>Восстановить привязку</summary>
            <p>Укажи точный native ID отдельного чата этого проекта.</p>
            <input
              aria-label="Идентификатор чата Intake"
              value={native}
              onChange={(e) => setNative(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || !native.trim()}
              onClick={() =>
                void act(async () =>
                  merge(
                    await api<IntakeState>(path + "/recover", {
                      method: "POST",
                      body: { nativeId: native.trim(), revision: data.revision, confirm: true },
                    }),
                  ),
                )
              }
            >
              Привязать чат
            </button>
            {!data.creationUnknown && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (!replaceConfirmed) {
                    setReplaceConfirmed(true);
                    return;
                  }
                  void act(async () => {
                    const s = await api<IntakeState>(path + "/recover", {
                      method: "POST",
                      body: { nativeId: null, revision: data.revision, confirm: true },
                    });
                    if (live.current) setData(s);
                  });
                }}
              >
                {replaceConfirmed
                  ? "Подтвердить новый разбор · прежняя история сохранится"
                  : "Начать новый разбор"}
              </button>
            )}
          </details>
        )}
      </div>
      <form
        className="intake-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {running && (
          <div className="intake-actions">
            <small role="status">
              {data?.status === "unknown" ? "Проверь состояние отправки" : "Codex изучает задачу…"}
            </small>
            {data?.threadId && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (data.status === "unknown")
                      merge(await api<IntakeState>(path + "/resume", { method: "POST", body: {} }));
                    else
                      await api(`/threads/${data.threadId}/interrupt`, {
                        method: "POST",
                        key: crypto.randomUUID(),
                        body: {},
                      });
                  })
                }
              >
                {data?.status === "unknown" ? "Проверить" : "Остановить"}
              </button>
            )}
          </div>
        )}
        <details>
          <summary>Issues, PR и коммиты{refs ? ` · ${refs.split(/[\s,]+/).length}` : ""}</summary>
          <label>
            До пяти источников
            <input
              aria-label="Источники разбора"
              value={refs}
              placeholder="#42 или ссылка GitHub"
              onChange={(e) => setRefs(e.target.value)}
            />
          </label>
        </details>
        <ComposerOptions
          analysisOnly
          disabled={busy || running}
          options={{
            caps,
            selection: settings,
            loading: !caps,
            saving: false,
            error: "",
            change: async (v) => setSettings({ ...v, mode: "default", access: "workspace" }),
            reload: () => {
              void api<Capabilities>(`/projects/${projectId}/capabilities`).then(setCaps);
            },
          }}
        />
        <div className="intake-input">
          <textarea
            aria-label="Сообщение для разбора"
            value={draft}
            maxLength={12000}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Что нужно изучить?"
          />
          <button
            type="submit"
            className="icon-button"
            aria-label="Отправить на разбор"
            disabled={busy || running || !data || !settings || !draft.trim()}
          >
            <Icon name="send" />
          </button>
        </div>
      </form>
      {source && (
        <ActivitySourceWindow
          personalProjectId={projectId}
          target={{ projectId, repositoryId: source.repositoryId, source }}
          onClose={() => setSource(null)}
        />
      )}
      {resultsOpen && data?.threadId && (
        <IntakeResults
          threadId={data.threadId}
          artifact={artifact}
          onClose={() => setResultsOpen(false)}
        />
      )}
    </dialog>
  );
}
function IntakeResults({
  threadId,
  artifact,
  onClose,
}: {
  threadId: string;
  artifact: ArtifactRequest | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const overlay = useCallback(() => {}, []);
  return (
    <dialog
      ref={dialog}
      className="workspace-window intake-window intake-results"
      aria-label="Результаты разбора"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="panel-heading notebook-heading">
        <h2>Результаты разбора</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть результаты разбора"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <ResultFeed
        endpoint={`/threads/${threadId}/results`}
        revision={threadId}
        visible
        reveal={artifact}
        onOverlayChange={overlay}
      />
    </dialog>
  );
}

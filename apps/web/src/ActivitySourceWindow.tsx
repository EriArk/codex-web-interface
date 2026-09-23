import type {
  CollaborationSpace,
  GitHubActivitySource,
  GitHubWorkObservation,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { SharedMarkdown } from "./SharedMaterialEditor";
import { GitHubRecord } from "./TeamGitHubPanel";
import { useWorkspaceDialog } from "./useWorkspaceDialog";

export type ActivitySourceTarget = {
  projectId: string;
  repositoryId: number;
  source: GitHubActivitySource;
};
export function ActivitySourceWindow({
  space,
  target,
  onClose,
}: {
  space: CollaborationSpace;
  target: ActivitySourceTarget;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const [value, setValue] = useState<GitHubWorkObservation | null>(null),
    [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const scope = JSON.stringify([
    space.id,
    space.revision,
    target.projectId,
    target.repositoryId,
    target.source.key,
  ]);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    const [spaceId, , projectId, repositoryId, source] = JSON.parse(scope);
    void api<GitHubWorkObservation>(`/team/spaces/${spaceId}/activity/source`, {
      method: "POST",
      body: { projectId, repositoryId, source, page },
    })
      .then((next) => {
        if (live)
          setValue((old) =>
            page > 1 && old
              ? {
                  ...next,
                  commentsPage: [...(old.commentsPage ?? []), ...(next.commentsPage ?? [])],
                }
              : next,
          );
      })
      .catch((e) => {
        if (live) {
          setValue(null);
          setError(messageOf(e));
        }
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [scope, page]);
  return (
    <dialog
      ref={dialog}
      className="space-dialog workspace-window activity-source-dialog"
      aria-label="GitHub · событие"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="panel-heading notebook-heading">
        <h2>
          {target.source.kind === "commit"
            ? "Коммит"
            : target.source.kind === "pr"
              ? "Pull Request"
              : "Issue"}{" "}
          ·{" "}
          {target.source.kind === "commit"
            ? target.source.sha?.slice(0, 7)
            : `#${target.source.number}`}
        </h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть событие"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="space-dialog-body shared-scroll" aria-busy={busy}>
        {!value && busy && <p>Загружаем событие…</p>}
        {error && <p role="status">{error}</p>}
        {value?.record && <GitHubRecord record={value.record} external={false} />}
        {value?.commit && (
          <section className="activity-commit">
            <h3>{value.commit.message.split(/\r?\n/)[0]}</h3>
            <div className="github-sha">
              <code>{value.commit.sha}</code>
              <CopyButton text={value.commit.sha} label="Скопировать SHA" />
            </div>
            {value.commit.message.includes("\n") && (
              <p className="activity-commit-message">
                {value.commit.message.slice(value.commit.message.indexOf("\n") + 1)}
              </p>
            )}
            {value.commit.files.map((file) => (
              <details key={file.path}>
                <summary>
                  {file.path}{" "}
                  <small>
                    +{file.additions} −{file.deletions}
                  </small>
                </summary>
                {file.patch ? (
                  <>
                    <CopyButton text={file.patch} label="Скопировать изменения" />
                    <pre>
                      <code>{file.patch}</code>
                    </pre>
                  </>
                ) : (
                  <p>Текстовые изменения для этого файла недоступны.</p>
                )}
              </details>
            ))}
            {value.commit.truncated && (
              <small>Показана ограниченная выборка файлов и изменений.</small>
            )}
          </section>
        )}
        {!!value?.commentsPage?.length && (
          <section className="activity-source-comments" aria-label="Комментарии GitHub">
            <h3>Комментарии</h3>
            {value.commentsPage.map((comment) => (
              <article key={comment.id}>
                <strong>@{comment.author.login}</strong>
                <SharedMarkdown text={comment.body} />
              </article>
            ))}
          </section>
        )}
        {value?.nextPage && (
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => setPage(value.nextPage!)}
          >
            Ещё комментарии
          </button>
        )}
      </div>
    </dialog>
  );
}

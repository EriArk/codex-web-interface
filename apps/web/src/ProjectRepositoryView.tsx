import type { ProjectGit, ProjectReleases, ProjectRepository } from "@codex-web/shared";
import { type ReactNode, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, messageOf } from "./api";
import { CollapsibleCode } from "./CollapsibleCode";
import { CopyButton } from "./CopyButton";
import { DownloadLink } from "./DownloadLink";
import { Icon } from "./icons";
import { MarkdownTable } from "./MarkdownTable";

export function projectDocumentPath(source: string, href: string): string | null {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return null;
  try {
    const parts = source.split("/").slice(0, -1);
    for (const part of decodeURIComponent(href.split(/[?#]/)[0]!).split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else if (
        /[\\:]/.test(part) ||
        Array.from(part).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        return null;
      else parts.push(part);
    }
    return parts.join("/") || null;
  } catch {
    return null;
  }
}
function ProjectMarkdown({
  text,
  projectId,
  source,
  remote,
}: {
  text: string;
  projectId: string;
  source?: string;
  remote?: string;
}) {
  const link = (href: string | undefined, children: ReactNode) => {
    if (href && /^https?:\/\//i.test(href))
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    const local = source && href ? projectDocumentPath(source, href) : null;
    if (local)
      return (
        <DownloadLink
          className="inspector-document-link"
          href={`/api/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(local)}`}
          name={local.split("/").at(-1)}
        >
          {children}
        </DownloadLink>
      );
    if (remote && href?.startsWith("/"))
      return (
        <a href={new URL(href, remote).href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    return <span>{children}</span>;
  };
  return (
    <div className="inspector-markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CollapsibleCode,
          table: MarkdownTable,
          a: ({ href, children }) => link(href, children),
          img: ({ src, alt }) =>
            link(
              typeof src === "string" ? src : undefined,
              <>
                <Icon name="image" size={15} />
                {alt || "Изображение"}
              </>,
            ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
const date = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString("ru", { day: "numeric", month: "short", year: "numeric" })
    : "";

export function ProjectRepositoryView({
  projectId,
  projectName,
  git,
  revision,
  changes,
  section,
  onSection,
  visible,
}: {
  projectId: string;
  projectName: string;
  git: ProjectGit | null;
  revision: number;
  changes: ReactNode;
  section: "overview" | "changes" | "releases";
  onSection: (value: "overview" | "changes" | "releases") => void;
  visible: boolean;
}) {
  const [repository, setRepository] = useState<ProjectRepository | null>(null),
    [error, setError] = useState("");
  const [releases, setReleases] = useState<ProjectReleases | null>(null),
    [releaseError, setReleaseError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh repeats this scoped read.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setError("");
    setReleaseError("");
    void api<ProjectRepository>(`/projects/${encodeURIComponent(projectId)}/git/repository`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setRepository(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      });
    return () => controller.abort();
  }, [projectId, revision, visible]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh repeats this scoped read.
  useEffect(() => {
    if (!visible || section !== "releases") return;
    const controller = new AbortController();
    setReleaseError("");
    void api<ProjectReleases>(`/projects/${encodeURIComponent(projectId)}/git/releases`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setReleases(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setReleaseError(messageOf(e));
      });
    return () => controller.abort();
  }, [projectId, section, revision, visible]);
  const remote = repository?.remote;
  return (
    <div className="repository-view">
      <section className="repository-summary" aria-label="Репозиторий проекта">
        <div className="repository-identity">
          <span className="repository-symbol">
            <Icon name="repository" size={25} />
          </span>
          <div>
            <small>
              {remote?.owner ?? "Проект"}
              {repository?.subdirectory ? " · " + repository.subdirectory : ""}
            </small>
            <h2>{projectName}</h2>
          </div>
          {remote && (
            <a
              className="icon-button"
              href={remote.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Открыть репозиторий на GitHub"
            >
              <Icon name="external" />
            </a>
          )}
        </div>
        {remote && remote.repo !== projectName && (
          <p className="repository-address">
            {remote.owner}/{remote.repo}
          </p>
        )}
        {git?.repository && (
          <>
            <div className="repository-branch">
              <Icon name="branch" size={16} />
              <strong>{git.detached ? "Отдельный коммит" : git.branch}</strong>
              <span className={`repository-health ${git.dirty ? "changed" : ""}`}>
                <Icon name={git.dirty ? "edit" : "check"} size={13} />
                {git.dirty ? "Есть изменения" : "Без изменений"}
              </span>
            </div>
            {git.upstream && (
              <small className="muted">
                {git.upstream} · ↑ {git.ahead ?? 0} · ↓ {git.behind ?? 0}
              </small>
            )}
            <div className="repository-counts">
              <span>
                <strong>{git.stagedCount ?? 0}</strong> в индексе
              </span>
              <span>
                <strong>{git.workingCount ?? 0}</strong> изменено
              </span>
              <span>
                <strong>{git.untrackedCount ?? 0}</strong> новых
              </span>
            </div>
          </>
        )}
        {git && !git.repository && <p className="muted">В этой папке нет Git-репозитория</p>}
      </section>
      <nav className="inspector-tabs repository-tabs" aria-label="Информация Git">
        {(
          [
            ["overview", "Обзор"],
            ["changes", "Изменения"],
            ["releases", "Релизы"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={section === id}
            className={section === id ? "active" : ""}
            onClick={() => onSection(id)}
          >
            {label}
            {id === "changes" && !!git?.changes.length && <small>{git.changes.length}</small>}
          </button>
        ))}
      </nav>
      {section === "changes" && (
        <>
          {git?.summary && git.dirty && (
            <p className="repository-diff-summary">
              Рабочая копия{" "}
              <b>
                +{git.summary.working.added} / −{git.summary.working.removed}
              </b>{" "}
              · Индекс{" "}
              <b>
                +{git.summary.staged.added} / −{git.summary.staged.removed}
              </b>
            </p>
          )}
          {changes}
          {git?.repository && !git.changes.length && (
            <p className="inspector-empty">Нет изменений файлов</p>
          )}
          {!!git?.hiddenCount && <p className="muted">Скрыты служебные пути: {git.hiddenCount}</p>}
        </>
      )}
      {section === "overview" && (
        <div className="repository-overview">
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          {!repository && !error && (
            <p role="status">
              <span className="spinner" /> Читаю сведения о проекте…
            </p>
          )}
          {repository && (
            <section className="repository-card repository-readme" aria-label="README проекта">
              <header>
                <span>
                  <Icon name="file" size={17} />
                  README
                </span>
                {repository.readme && (
                  <CopyButton text={repository.readme.text} label="Копировать README" />
                )}
              </header>
              {repository.readme ? (
                <>
                  <ProjectMarkdown
                    text={repository.readme.text}
                    source={repository.readme.path}
                    projectId={projectId}
                  />
                  {repository.readme.truncated && (
                    <p className="muted">Показано начало README — 128 КБ</p>
                  )}
                  <DownloadLink
                    href={`/api/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(repository.readme.path)}`}
                    name={repository.readme.path.split("/").at(-1)}
                  >
                    Открыть {repository.readme.path}
                  </DownloadLink>
                </>
              ) : (
                <p className="inspector-empty">README в проекте пока нет</p>
              )}
            </section>
          )}
          {!!git?.commits.length && (
            <details className="repository-card inspector-commits">
              <summary>
                <Icon name="history" size={17} />
                Последние коммиты <small>{git.commits.length}</small>
              </summary>
              <ul>
                {git.commits.map((commit) => (
                  <li key={commit.id}>
                    <div>
                      {remote ? (
                        <a
                          href={`${remote.url}/commit/${commit.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <code>{commit.id}</code>
                        </a>
                      ) : (
                        <code>{commit.id}</code>
                      )}
                      <CopyButton text={commit.id} label={`Копировать коммит ${commit.id}`} />
                    </div>
                    <span>{commit.subject}</span>
                    <small>
                      {commit.author} · <time dateTime={commit.date}>{date(commit.date)}</time>
                    </small>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!repository?.branches.length && (
            <details className="repository-card repository-refs">
              <summary>
                <Icon name="branch" size={17} />
                Ветки <small>{repository.branches.length}</small>
              </summary>
              <ul>
                {repository.branches.map((branch) => (
                  <li key={branch.name}>
                    <strong>
                      {branch.name}
                      {branch.current && <Icon name="check" size={14} />}
                    </strong>
                    {branch.upstream && <small>{branch.upstream}</small>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!repository?.tags.length && (
            <details className="repository-card repository-refs">
              <summary>
                <Icon name="tag" size={17} />
                Теги <small>{repository.tags.length}</small>
              </summary>
              <ul>
                {repository.tags.map((tag) => (
                  <li key={tag.name}>
                    <strong>{tag.name}</strong>
                    <small>
                      {date(tag.date)}
                      {tag.subject ? " · " + tag.subject : ""}
                    </small>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {section === "releases" && (
        <div className="repository-releases">
          {releaseError && (
            <p className="notice" role="alert">
              {releaseError}
            </p>
          )}
          {!releases && !releaseError && (
            <p role="status">
              <span className="spinner" /> Загружаю релизы…
            </p>
          )}
          {releases?.state === "no-remote" && (
            <p className="inspector-empty">
              Для релизов нужен репозиторий GitHub, связанный с этим проектом.
            </p>
          )}
          {releases?.state === "unavailable" && (
            <p className="notice">Не удалось получить релизы. Проверь доступ к GitHub.</p>
          )}
          {releases?.state === "ok" && !releases.items.length && (
            <p className="inspector-empty">Опубликованных релизов пока нет</p>
          )}
          {releases?.items.map((release, index) => (
            <details
              className="repository-card repository-release"
              key={release.id}
              open={index === 0}
            >
              <summary>
                <Icon name="tag" size={18} />
                <span>
                  {release.name}
                  <small>
                    {release.tag} · {date(release.publishedAt)}
                    {release.prerelease ? " · Предварительный" : ""}
                    {release.draft ? " · Черновик" : ""}
                  </small>
                </span>
              </summary>
              <ProjectMarkdown
                text={release.body || "Без описания"}
                projectId={projectId}
                remote={remote?.url}
              />
              <div className="inspector-actions">
                <a
                  href={release.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="secondary"
                >
                  <Icon name="external" size={16} />
                  Открыть релиз
                </a>
                {!!release.assets && <small className="muted">Файлов: {release.assets}</small>}
              </div>
              {release.truncated && <p className="muted">Полное описание — на странице релиза.</p>}
            </details>
          ))}
          {releases?.url && (
            <a
              className="repository-all-releases"
              href={releases.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Все релизы на GitHub <Icon name="external" size={15} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

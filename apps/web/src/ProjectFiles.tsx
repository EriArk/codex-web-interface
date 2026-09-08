import type { ProjectDiff, ProjectDirectory, ProjectGit } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { api, messageOf } from "./api";
import { CopyButton } from "./CopyButton";
import { DownloadLink } from "./DownloadLink";
import { Icon } from "./icons";
import "./project-files.css";

export function ProjectFiles({
  projectId,
  visible,
  focus,
  onBack,
}: {
  projectId: string;
  visible: boolean;
  focus: { path: string; version: number; projectId: string };
  onBack: () => void;
}) {
  const [mode, setMode] = useState<"files" | "git">("files"),
    [path, setPath] = useState(""),
    [input, setInput] = useState(""),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState(""),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const [directory, setDirectory] = useState<ProjectDirectory | null>(null),
    [git, setGit] = useState<ProjectGit | null>(null),
    [selected, setSelected] = useState(""),
    [staged, setStaged] = useState(false),
    [diff, setDiff] = useState<ProjectDiff | null>(null),
    [saved, setSaved] = useState<{ url: string; name: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const open = (next: string) => {
    setPath(next);
    setInput(next);
    setOffset(0);
    setSelected("");
    setFilter("");
    setSearch("");
  };
  useEffect(() => {
    if (!focus.version || focus.projectId !== projectId) return;
    setMode("files");
    setPath(focus.path.split("/").slice(0, -1).join("/"));
    setInput(focus.path.split("/").slice(0, -1).join("/"));
    setOffset(0);
    setSelected(focus.path);
  }, [focus, projectId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh repeats only this read.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    if (mode === "files") setDirectory(null);
    else setGit(null);
    const endpoint =
      mode === "files"
        ? `${base}/files?path=${encodeURIComponent(path)}&offset=${offset}&search=${encodeURIComponent(filter)}`
        : `${base}/git`;
    void api<ProjectDirectory | ProjectGit>(endpoint, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (mode === "files") setDirectory(data as ProjectDirectory);
        else setGit(data as ProjectGit);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [base, path, mode, offset, filter, visible, revision]);
  useEffect(() => {
    setDiff(null);
    setSaved(null);
    if (!selected || !visible) return;
    const controller = new AbortController();
    void api<{ url: string; name: string } | null>(
      `${base}/files/saved?path=${encodeURIComponent(selected)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setSaved(value);
      })
      .catch(() => {});
    if (mode === "git")
      void api<ProjectDiff>(
        `${base}/git/diff?path=${encodeURIComponent(selected)}&staged=${staged ? 1 : 0}`,
        { signal: controller.signal },
      )
        .then((value) => {
          if (!controller.signal.aborted) setDiff(value);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(messageOf(e));
        });
    return () => controller.abort();
  }, [base, selected, staged, mode, visible]);
  const download = (file: string, label = "Открыть файл") => (
    <DownloadLink
      href={`/api${base}/files/content?path=${encodeURIComponent(file)}`}
      name={file.split("/").at(-1)}
    >
      <Icon name="file" />
      {label}
    </DownloadLink>
  );
  return (
    <section className="project-files pane" data-visible={visible} aria-label="Файлы и Git">
      <header className="inspector-heading">
        <button
          type="button"
          className="icon-button"
          aria-label="Вернуться к чату"
          onClick={onBack}
        >
          <Icon name="back" />
        </button>
        <strong>Файлы и Git</strong>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          aria-label="Обновить файлы и Git"
          onClick={() => {
            setRevision((v) => v + 1);
            setSelected("");
          }}
        >
          <Icon name="refresh" />
        </button>
      </header>
      <div className="inspector-tabs">
        {(
          [
            ["files", "Файлы"],
            ["git", "Git"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={mode === id}
            className={mode === id ? "active" : ""}
            onClick={() => {
              setMode(id);
              setSelected("");
              setError("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="inspector-scroll">
        {mode === "files" && (
          <>
            <form
              className="inspector-path"
              onSubmit={(e) => {
                e.preventDefault();
                open(input);
              }}
            >
              <button
                type="button"
                className="icon-button"
                disabled={!path}
                aria-label="Папка выше"
                onClick={() => open(path.split("/").slice(0, -1).join("/"))}
              >
                <Icon name="arrow-up" />
              </button>
              <input
                aria-label="Путь в проекте"
                value={input}
                placeholder="Корень проекта"
                onChange={(e) => setInput(e.target.value)}
              />
              <button type="submit" className="icon-button" aria-label="Открыть папку">
                <Icon name="chevron" />
              </button>
            </form>
            <form
              className="inspector-path"
              onSubmit={(e) => {
                e.preventDefault();
                setFilter(search);
                setOffset(0);
              }}
            >
              <input
                aria-label="Найти в папке"
                placeholder="Найти в папке…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button type="submit" className="icon-button" aria-label="Найти файл">
                <Icon name="search" />
              </button>
            </form>
          </>
        )}
        {busy && (
          <p role="status">
            <span className="spinner" /> Загружаю…
          </p>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {selected && (
          <section className="inspector-selected" aria-label="Выбранный файл">
            <div className="inspector-file-title">
              <strong>{selected}</strong>
              <CopyButton text={selected} label="Копировать путь" />
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть файл"
                onClick={() => setSelected("")}
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="inspector-actions">
              {download(selected)}
              {saved && (
                <DownloadLink href={saved.url} name={saved.name}>
                  Сохранённый результат
                </DownloadLink>
              )}
            </div>
            {mode === "git" && (
              <>
                <div className="inspector-tabs">
                  <button
                    type="button"
                    aria-pressed={!staged}
                    className={!staged ? "active" : ""}
                    onClick={() => setStaged(false)}
                  >
                    Рабочая копия
                  </button>
                  <button
                    type="button"
                    aria-pressed={staged}
                    className={staged ? "active" : ""}
                    onClick={() => setStaged(true)}
                  >
                    Индекс
                  </button>
                </div>
                {diff ? (
                  <>
                    <CopyButton text={diff.text} label="Копировать diff" />
                    <pre className="inspector-diff">
                      {diff.text || "Нет текстового diff. Новый файл можно открыть выше."}
                    </pre>
                    {diff.truncated && <small>Показано начало diff — 256 КБ</small>}
                  </>
                ) : (
                  !error && (
                    <p role="status">
                      <span className="spinner" /> Читаю diff…
                    </p>
                  )
                )}
              </>
            )}
          </section>
        )}
        {mode === "files" && directory && (
          <>
            <ul className="inspector-list">
              {directory.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="inspector-entry"
                    onClick={() =>
                      entry.kind === "directory" ? open(entry.path) : setSelected(entry.path)
                    }
                  >
                    <Icon name={entry.kind === "directory" ? "folder" : "file"} />
                    <span>{entry.name}</span>
                    {entry.kind === "file" && <small>{Math.ceil(entry.size / 1024)} КБ</small>}
                  </button>
                  <CopyButton text={entry.path} label={`Копировать путь ${entry.name}`} />
                </li>
              ))}
            </ul>
            {!directory.entries.length && <p className="muted">Файлов не найдено</p>}
            <div className="inspector-actions">
              {offset > 0 && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setOffset((v) => Math.max(0, v - 100))}
                >
                  Назад
                </button>
              )}
              {directory.nextOffset !== null && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setOffset(directory.nextOffset ?? 0)}
                >
                  Ещё файлы
                </button>
              )}
            </div>
            {directory.truncated && (
              <small>Проверены первые 5000 записей. Открой нужную папку по пути.</small>
            )}
          </>
        )}
        {mode === "git" &&
          git &&
          (git.repository ? (
            <>
              <div className="inspector-git-state">
                <strong>{git.detached ? "Отдельный коммит" : git.branch}</strong>
                {!!(git.ahead || git.behind) && (
                  <small>
                    ↑ {git.ahead} · ↓ {git.behind}
                  </small>
                )}
                <span className="muted">
                  {git.dirty
                    ? `Индекс ${git.stagedCount} · Изменены ${git.workingCount} · Новые ${git.untrackedCount}`
                    : "Нет изменений"}
                </span>
                {git.summary && git.dirty && (
                  <small>
                    Рабочая копия +{git.summary.working.added} / −{git.summary.working.removed} ·
                    Индекс +{git.summary.staged.added} / −{git.summary.staged.removed}
                  </small>
                )}
                {!!git.hiddenCount && <small>Скрыты служебные пути: {git.hiddenCount}</small>}
              </div>
              <ul className="inspector-list">
                {git.changes.map((change) => (
                  <li key={change.path}>
                    <button
                      type="button"
                      className="inspector-entry"
                      onClick={() => {
                        if (change.path.endsWith("/")) {
                          setMode("files");
                          open(change.path.slice(0, -1));
                          return;
                        }
                        setSelected(change.path);
                        setStaged(change.index !== " " && change.index !== "?");
                        setError("");
                      }}
                    >
                      <code className="git-status" title="Индекс / рабочая копия">
                        {change.index}
                        {change.working}
                      </code>
                      <span>
                        {change.path}
                        {change.previousPath && <small> ← {change.previousPath}</small>}
                      </span>
                      <Icon name="chevron" />
                    </button>
                  </li>
                ))}
              </ul>
              <details className="inspector-commits">
                <summary>Последние коммиты</summary>
                <ul>
                  {git.commits.map((commit) => (
                    <li key={commit.id}>
                      <code>{commit.id}</code>
                      <span>{commit.subject}</span>
                      <time dateTime={commit.date}>
                        {new Date(commit.date).toLocaleDateString("ru")}
                      </time>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          ) : (
            <p className="muted">В этой папке нет Git-репозитория</p>
          ))}
      </div>
    </section>
  );
}

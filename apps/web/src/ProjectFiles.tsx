import type { ProjectDiff, ProjectDirectory, ProjectGit } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { CopyButton } from "./CopyButton";
import { DownloadLink } from "./DownloadLink";
import { GuiPreviewButton } from "./GuiPreviewHost";
import { Icon } from "./icons";
import { DeliveryButton } from "./ProjectDeliveryHost";
import { ProjectFilePreview } from "./ProjectFilePreview";
import { ProjectRepositoryView } from "./ProjectRepositoryView";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./project-files.css";
import "./workspace-window.css";
import "./project-tools.css";

const fileSize = (size: number) =>
  size < 1024
    ? `${size} Б`
    : size < 1048576
      ? `${Math.ceil(size / 1024)} КБ`
      : `${(size / 1048576).toFixed(1)} МБ`;
const fileDate = (value: number) =>
  new Date(value).toLocaleDateString("ru", { day: "numeric", month: "short" });

export function ProjectFiles({
  projectId,
  projectName,
  threadId,
  visible,
  mode,
  focus,
  onBack,
  onOpenFiles,
}: {
  projectId: string;
  projectName: string;
  threadId?: string;
  visible: boolean;
  mode: "files" | "git";
  focus: { path: string; version: number; projectId: string };
  onBack: () => void;
  onOpenFiles: (path: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog, visible);
  const [section, setSection] = useState<"overview" | "changes" | "releases">("overview");
  const [path, setPath] = useState(""),
    [input, setInput] = useState(""),
    [editingPath, setEditingPath] = useState(false),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("");
  const [sort, setSort] = useState<"name" | "modified" | "size">("name"),
    [reveal, setReveal] = useState(""),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const [directory, setDirectory] = useState<ProjectDirectory | null>(null),
    [git, setGit] = useState<ProjectGit | null>(null),
    [selected, setSelected] = useState("");
  const [staged, setStaged] = useState(false),
    [diff, setDiff] = useState<ProjectDiff | null>(null),
    [saved, setSaved] = useState<{ url: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [fileError, setFileError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const readScope = useRef(""),
    detailScope = useRef("");
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const open = (next: string) => {
    setEditingPath(false);
    setPath(next);
    setInput(next);
    setOffset(0);
    setSelected("");
    setFilter("");
    setSearch("");
    setReveal("");
  };
  useEffect(() => {
    if (mode !== "files" || !focus.version || focus.projectId !== projectId) return;
    const parent = focus.path.split("/").slice(0, -1).join("/");
    setPath(parent);
    setInput(parent);
    setOffset(0);
    setFilter("");
    setSearch("");
    setReveal(focus.path.split("/").at(-1) ?? "");
    setSelected(focus.path.endsWith("/") ? "" : focus.path);
  }, [focus, projectId, mode]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh repeats this scoped read.
  useEffect(() => {
    if (!visible || !projectId) return;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    const query = new URLSearchParams({
      path,
      offset: String(offset),
      search: filter,
      sort,
      ...(reveal ? { reveal } : {}),
    });
    const scope = `${base}/${mode}?${query}`;
    if (scope !== readScope.current) {
      if (mode === "files") setDirectory(null);
      else setGit(null);
      readScope.current = scope;
    }
    void api<ProjectDirectory | ProjectGit>(
      mode === "files" ? `${base}/files?${query}` : `${base}/git`,
      { signal: controller.signal },
    )
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
  }, [base, path, mode, offset, filter, sort, reveal, visible, revision, projectId]);
  useEffect(() => {
    if (!visible || !reveal || !directory) return;
    const row = Array.from(
      scroller.current?.querySelectorAll<HTMLElement>("[data-file-path]") ?? [],
    ).find((el) => el.dataset.filePath === focus.path);
    row?.scrollIntoView({ block: "nearest" });
  }, [directory, visible, reveal, focus.path]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh repeats this scoped read.
  useEffect(() => {
    const scope = `${base}/${mode}/${selected}?staged=${staged}`;
    if (detailScope.current !== scope) {
      detailScope.current = scope;
      setDiff(null);
      setSaved(null);
    }
    setFileError("");
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
          if (!controller.signal.aborted) setFileError(messageOf(e));
        });
    return () => controller.abort();
  }, [base, selected, staged, mode, visible, revision]);
  const select = (value: string) => {
    setSelected((old) => (old === value ? "" : value));
    setFileError("");
  };
  const download = (file: string) => (
    <DownloadLink
      href={`/api${base}/files/content?path=${encodeURIComponent(file)}`}
      name={file.split("/").at(-1)}
    >
      <Icon name="file" />
      Открыть файл
    </DownloadLink>
  );
  const selectedPanel = () => (
    <section className="inspector-selected" aria-label="Выбранный файл">
      <div className="inspector-actions">
        {download(selected)}
        {mode === "git" && <CopyButton text={selected} label="Копировать путь" />}
        <button
          type="button"
          className="icon-button inspector-file-close"
          aria-label="Закрыть файл"
          onClick={() => setSelected("")}
        >
          <Icon name="close" />
        </button>
        {saved && (
          <DownloadLink href={saved.url} name={saved.name}>
            Сохранённый результат
          </DownloadLink>
        )}
      </div>
      {fileError && (
        <p className="notice" role="alert">
          {fileError}
        </p>
      )}
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
            !fileError && (
              <p role="status">
                <span className="spinner" /> Читаю diff…
              </p>
            )
          )}
        </>
      )}
    </section>
  );
  const changeList = (
    <ul className="inspector-list inspector-changes">
      {git?.changes.map((change) => (
        <li
          key={change.path}
          data-file-path={change.path}
          className={selected === change.path ? "selected" : ""}
        >
          <div className="inspector-row">
            <button
              type="button"
              className="inspector-entry"
              aria-expanded={selected === change.path}
              onClick={() => {
                if (change.path.endsWith("/")) {
                  onOpenFiles(change.path);
                  return;
                }
                select(change.path);
                setStaged(change.index !== " " && change.index !== "?");
              }}
            >
              <code className="git-status" title="Индекс / рабочая копия">
                {change.index}
                {change.working}
              </code>
              <span>
                {change.path}
                {change.previousPath && <small>← {change.previousPath}</small>}
              </span>
              <Icon name="chevron" size={16} />
            </button>
          </div>
          {selected === change.path && selectedPanel()}
        </li>
      ))}
    </ul>
  );
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="project-files notebook-dialog workspace-window project-tool-window"
      data-tool={mode}
      aria-label={mode === "files" ? "Файлы проекта" : "Git проекта"}
      onCancel={onBack}
    >
      <header className="inspector-heading notebook-heading">
        <Icon name={mode === "files" ? "folder" : "branch"} />
        <div>
          <strong>{mode === "files" ? "Файлы" : "Git"}</strong>
          <small>{projectName}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          aria-label={mode === "files" ? "Обновить файлы" : "Обновить Git"}
          onClick={() => setRevision((value) => value + 1)}
        >
          <Icon name="refresh" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={mode === "files" ? "Закрыть файлы" : "Закрыть Git"}
          onClick={onBack}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="project-tool-actions">
        {mode === "files" && (
          <span className="inspector-readonly">
            <Icon name="lock" size={16} />
            Только чтение
          </span>
        )}
        {visible && (
          <GuiPreviewButton projectId={projectId} projectName={projectName} threadId={threadId} />
        )}
        {mode === "git" && visible && (
          <DeliveryButton projectId={projectId} projectName={projectName} />
        )}
      </div>
      <div className="inspector-workspace">
        <div className="inspector-scroll" ref={scroller}>
          {mode === "files" && (
            <>
              {editingPath ? (
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
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Отменить ввод пути"
                    onClick={() => setEditingPath(false)}
                  >
                    <Icon name="close" />
                  </button>
                  <button type="submit" className="icon-button" aria-label="Открыть папку">
                    <Icon name="chevron" />
                  </button>
                </form>
              ) : (
                <div className="inspector-location">
                  <button
                    type="button"
                    className="icon-button"
                    disabled={!path}
                    aria-label="Папка выше"
                    onClick={() => open(path.split("/").slice(0, -1).join("/"))}
                  >
                    <Icon name="arrow-up" />
                  </button>
                  <nav className="inspector-breadcrumbs" aria-label="Папки проекта">
                    <button type="button" onClick={() => open("")} aria-label="Корень проекта">
                      <Icon name="folder" size={16} />
                      Корень
                    </button>
                    {path
                      .split("/")
                      .filter(Boolean)
                      .map((part, index) => (
                        <span
                          key={path
                            .split("/")
                            .slice(0, index + 1)
                            .join("/")}
                        >
                          <Icon name="chevron" size={13} />
                          <button
                            type="button"
                            onClick={() =>
                              open(
                                path
                                  .split("/")
                                  .slice(0, index + 1)
                                  .join("/"),
                              )
                            }
                          >
                            {part}
                          </button>
                        </span>
                      ))}
                  </nav>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Ввести путь"
                    onClick={() => {
                      setInput(path);
                      setEditingPath(true);
                    }}
                  >
                    <Icon name="edit" size={17} />
                  </button>
                </div>
              )}
              <form
                className="inspector-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  setFilter(search);
                  setOffset(0);
                  setReveal("");
                  setSelected("");
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
              <div className="inspector-list-tools">
                <small>
                  {directory
                    ? `${directory.total ?? directory.entries.length} элементов`
                    : "Файлы проекта"}
                </small>
                <select
                  aria-label="Порядок файлов"
                  value={sort}
                  onChange={(e) => {
                    setSort(e.target.value as typeof sort);
                    setOffset(0);
                    setReveal("");
                    setSelected("");
                  }}
                >
                  <option value="name">По имени</option>
                  <option value="modified">По дате</option>
                  <option value="size">По размеру</option>
                </select>
              </div>
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
          {mode === "files" && directory && (
            <>
              <ul className="inspector-list">
                {directory.entries.map((entry) => (
                  <li
                    key={entry.path}
                    data-file-path={entry.path}
                    className={selected === entry.path ? "selected" : ""}
                  >
                    <div className="inspector-row">
                      <button
                        type="button"
                        className="inspector-entry"
                        aria-expanded={entry.kind === "file" ? selected === entry.path : undefined}
                        onClick={() =>
                          entry.kind === "directory" ? open(entry.path) : select(entry.path)
                        }
                      >
                        <span className={`inspector-file-icon ${entry.kind}`}>
                          <Icon name={entry.kind === "directory" ? "folder" : "file"} />
                        </span>
                        <span>
                          {entry.name}
                          <small>
                            {entry.kind === "file" ? fileSize(entry.size) + " · " : ""}
                            {fileDate(entry.modifiedAt)}
                          </small>
                        </span>
                        {entry.kind === "directory" && <Icon name="chevron" size={15} />}
                      </button>
                      <CopyButton text={entry.path} label={`Копировать путь ${entry.name}`} />
                    </div>
                    {selected === entry.path && selectedPanel()}
                  </li>
                ))}
              </ul>
              {!directory.entries.length && <p className="inspector-empty">Файлов не найдено</p>}
              <div className="inspector-actions">
                {(directory.offset ?? offset) > 0 && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setOffset(Math.max(0, (directory.offset ?? offset) - 100));
                      setReveal("");
                      setSelected("");
                    }}
                  >
                    Назад
                  </button>
                )}
                {directory.nextOffset !== null && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setOffset(directory.nextOffset ?? 0);
                      setReveal("");
                      setSelected("");
                    }}
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
          {mode === "git" && (
            <ProjectRepositoryView
              visible={visible}
              projectId={projectId}
              projectName={projectName}
              git={git}
              revision={revision}
              section={section}
              onSection={setSection}
              changes={changeList}
            />
          )}
        </div>
        {mode === "files" && (
          <ProjectFilePreview
            key={`${selected}:${revision}`}
            projectId={projectId}
            path={selected}
            size={directory?.entries.find((entry) => entry.path === selected)?.size}
            visible={visible}
          />
        )}
      </div>
    </dialog>
  );
}

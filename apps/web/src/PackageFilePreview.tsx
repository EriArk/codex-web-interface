/* biome-ignore-all lint/suspicious/noArrayIndexKey: Immutable document coordinates are stable; page/search changes remount the content pane. */
import { useEffect, useRef, useState } from "react";
import { FilePreview } from "./FilePreview";
import { FileViewerDialog } from "./FileViewerDialog";
import { Icon } from "./icons";
import type { OfficeBlock, OfficeDocument } from "./officePackage";
import type { ArchiveEntry } from "./packageArchive";
import "./package-preview.css";

type Reply = {
  entries?: ArchiveEntry[];
  office?: OfficeDocument;
  entry?: Uint8Array<ArrayBuffer>;
  error?: string;
};
function usePackage(file: File) {
  const [result, setResult] = useState<Reply>({}),
    [busy, setBusy] = useState(false);
  const worker = useRef<Worker | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stop = () => {
    worker.current?.terminate();
    worker.current = null;
    clearTimeout(timer.current);
  };
  const read = (entry?: string, done?: (bytes: Uint8Array<ArrayBuffer>) => void) => {
    stop();
    setBusy(true);
    setResult((r) => ({ ...r, error: undefined }));
    const w = new Worker(new URL("./packagePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    const fail = (message: string) => {
      stop();
      setBusy(false);
      setResult((r) => ({ ...r, error: message }));
    };
    timer.current = setTimeout(
      () => fail("Просмотр занял слишком много времени. Оригинал можно скачать."),
      15000,
    );
    w.onerror = () => fail("Не удалось прочитать файл. Оригинал можно скачать.");
    w.onmessage = (event: MessageEvent<Reply>) => {
      stop();
      setBusy(false);
      if (event.data.entry && done) done(event.data.entry);
      else setResult((r) => ({ ...r, ...event.data }));
    };
    w.postMessage({ file, entry });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: A parser job is owned by these exact immutable bytes.
  useEffect(() => {
    setResult({});
    read();
    return stop;
  }, [file]);
  return { result, busy, read };
}
function sizeLabel(size: number) {
  return new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(size / 1024) + " КБ";
}
function ExtractedFile({ file, onClose }: { file: File; onClose: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const value = URL.createObjectURL(new Blob([file], { type: "application/octet-stream" }));
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return (
    <FileViewerDialog
      name={file.name}
      file={file}
      onClose={onClose}
      actions={
        <a className="secondary" href={url} download={file.name}>
          Скачать
        </a>
      }
    >
      {url && <FilePreview file={file} objectUrl={url} full />}
    </FileViewerDialog>
  );
}
export default function PackageFilePreview({ file }: { file: File }) {
  const { result, busy, read } = usePackage(file);
  const [folder, setFolder] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0),
    [opened, setOpened] = useState<File | null>(null);
  if (result.office) return <OfficePreview doc={result.office} />;
  const entries = result.entries ?? [],
    folders = new Set<string>();
  const files = entries.filter((entry) => {
    if (search.trim())
      return (
        !entry.directory &&
        entry.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
      );
    if (entry.blocked) return !folder;
    if (!entry.name.startsWith(folder)) return false;
    const rest = entry.name.slice(folder.length),
      slash = rest.indexOf("/");
    if (slash >= 0) {
      folders.add(folder + rest.slice(0, slash + 1));
      return false;
    }
    return !entry.directory;
  });
  const items = [
    ...[...folders].sort().map((name) => ({ name, directory: true, size: 0, blocked: "" })),
    ...files,
  ];
  return (
    <div className="package-viewer">
      <div className="package-tools">
        <button
          type="button"
          className="icon-button"
          aria-label="На уровень выше"
          disabled={!folder || busy}
          onClick={() => {
            setFolder(
              folder.split("/").slice(0, -2).join("/") + (folder.split("/").length > 2 ? "/" : ""),
            );
            setPage(0);
          }}
        >
          <Icon name="chevron" style={{ transform: "rotate(180deg)" }} />
        </button>
        <span className="package-path" title={folder || "Содержимое архива"}>
          {folder || "Содержимое архива"}
        </span>
        <input
          type="search"
          aria-label="Поиск в архиве"
          placeholder="Найти файл"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
      </div>
      <div className="package-scroll" aria-busy={busy}>
        {busy && <p role="status">Читаю архив…</p>}
        {result.error && <p role="status">{result.error}</p>}
        <div className="archive-list">
          {items.slice(page * 100, (page + 1) * 100).map((entry) => (
            <button
              key={entry.name}
              type="button"
              className="archive-entry"
              disabled={busy || !!entry.blocked}
              title={entry.blocked || entry.name}
              onClick={() => {
                if (entry.directory) {
                  setFolder(entry.name);
                  setPage(0);
                } else
                  read(entry.name, (data) =>
                    setOpened(new File([data], entry.name.split("/").at(-1) || "Файл")),
                  );
              }}
            >
              <Icon name={entry.directory ? "folder" : "file"} />
              <span>
                {search ? entry.name : entry.name.slice(folder.length).replace(/\/$/, "")}
                <small>
                  {entry.blocked || (entry.directory ? "Папка" : sizeLabel(entry.size))}
                </small>
              </span>
              <Icon name="chevron" />
            </button>
          ))}
        </div>
        {!busy && !result.error && items.length === 0 && <p>Файлов не найдено.</p>}
      </div>
      <PageNavigation
        page={page}
        count={Math.ceil(items.length / 100)}
        onChange={setPage}
        label={`${entries.filter((e) => !e.directory).length} файлов`}
      />
      {opened && <ExtractedFile file={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}
function PageNavigation({
  page,
  count,
  onChange,
  label,
}: {
  page: number;
  count: number;
  onChange: (page: number) => void;
  label?: string;
}) {
  if (count <= 1) return label ? <div className="package-summary">{label}</div> : null;
  return (
    <div className="package-pages">
      <span>{label}</span>
      <button
        type="button"
        className="icon-button"
        aria-label="Предыдущая страница"
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
      >
        <Icon name="chevron" style={{ transform: "rotate(180deg)" }} />
      </button>
      <output>
        {page + 1} / {Math.max(1, count)}
      </output>
      <button
        type="button"
        className="icon-button"
        aria-label="Следующая страница"
        disabled={page + 1 >= count}
        onClick={() => onChange(page + 1)}
      >
        <Icon name="chevron" />
      </button>
    </div>
  );
}
function columnName(number: number): string {
  return number > 26
    ? columnName(Math.floor((number - 1) / 26)) + String.fromCharCode(65 + ((number - 1) % 26))
    : String.fromCharCode(64 + number);
}
function Block({ block, urls }: { block: OfficeBlock; urls: string[] }) {
  if (block.kind === "image")
    return (
      <img
        className="office-image"
        src={urls[block.media]}
        alt="Изображение документа"
        loading="lazy"
      />
    );
  if (block.kind === "table")
    return (
      <div className="office-table-scroll">
        <table>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  const runs = block.runs.map((run, i) => (
    <span
      key={i}
      style={{
        fontWeight: run.bold ? 700 : undefined,
        fontStyle: run.italic ? "italic" : undefined,
      }}
    >
      {run.text}
    </span>
  ));
  return block.heading ? <h2>{runs}</h2> : <p>{runs.length ? runs : <br />}</p>;
}
function OfficePreview({ doc }: { doc: OfficeDocument }) {
  const [selected, setSelected] = useState(0),
    [page, setPage] = useState(0),
    [zoom, setZoom] = useState(100),
    [query, setQuery] = useState(""),
    [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const values = doc.media.map((m) => URL.createObjectURL(new Blob([m.bytes], { type: m.type })));
    setUrls(values);
    return () => {
      for (const url of values) URL.revokeObjectURL(url);
    };
  }, [doc]);
  const current = doc.pages[selected]!,
    filter = query.trim().toLocaleLowerCase();
  const rows = current.rows?.filter(
    (row) =>
      !filter ||
      row.cells.some((c) => (c.value + (c.formula ?? "")).toLocaleLowerCase().includes(filter)),
  );
  const blocks = current.blocks.filter(
    (block) =>
      !filter ||
      block.kind === "image" ||
      (block.kind === "paragraph"
        ? block.runs.map((r) => r.text).join("")
        : block.rows.flat().join(" ")
      )
        .toLocaleLowerCase()
        .includes(filter),
  );
  const count = Math.ceil((rows?.length ?? blocks.length) / 100);
  return (
    <div className="package-viewer office-viewer">
      <div className="office-tools">
        <select
          aria-label={doc.kind === "xlsx" ? "Лист" : "Страница документа"}
          value={selected}
          onChange={(e) => {
            setSelected(Number(e.target.value));
            setPage(0);
          }}
        >
          {doc.pages.map((p, i) => (
            <option key={i} value={i}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Размер текста"
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
        >
          {[80, 100, 125, 150, 200].map((n) => (
            <option key={n} value={n}>
              {n}%
            </option>
          ))}
        </select>
        <input
          type="search"
          aria-label="Поиск в документе"
          placeholder="Найти текст"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
      </div>
      <div className="package-scroll" key={`${selected}:${page}:${query}`}>
        {rows ? (
          <div className="office-table-scroll">
            <table className="office-sheet" style={{ fontSize: `${zoom}%` }}>
              <thead>
                <tr>
                  <th scope="col">№</th>
                  {Array.from({ length: current.columns ?? 0 }, (_, i) => (
                    <th scope="col" key={i}>
                      {columnName(i + 1)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(page * 100, (page + 1) * 100).map((row, index) => {
                  const cells = new Map(row.cells.map((c) => [c.column, c]));
                  return (
                    <tr key={index}>
                      <th scope="row">{row.number}</th>
                      {Array.from({ length: current.columns ?? 0 }, (_, i) => {
                        const c = cells.get(i + 1);
                        return (
                          <td key={i}>
                            {c?.value}
                            {c?.formula && (
                              <details className="office-formula">
                                <summary aria-label={`Формула ${columnName(i + 1)}${row.number}`}>
                                  ƒ
                                </summary>
                                <code>={c.formula}</code>
                              </details>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <article className="office-document" style={{ fontSize: `${zoom}%` }}>
            <small>{"Содержимое документа"}</small>
            {blocks.slice(page * 100, (page + 1) * 100).map((block, i) => (
              <Block key={i} block={block} urls={urls} />
            ))}
          </article>
        )}
        {(rows?.length ?? blocks.length) === 0 && <p>Нет содержимого по этому выбору.</p>}
      </div>
      <details className="office-notes">
        <summary>О просмотре{doc.truncated ? " · Показана часть документа" : ""}</summary>
        <p>
          {doc.kind === "xlsx"
            ? "Показаны сохранённые значения ячеек и формулы без пересчёта. Числовые форматы, диаграммы и оформление Excel не воспроизводятся."
            : "Просмотр текста, таблиц и встроенных PNG/JPEG. Сложная верстка и фигуры не воспроизводятся."}{" "}
          Внешние ресурсы не загружаются. Оригинал доступен для скачивания.
        </p>
      </details>
      <PageNavigation
        page={page}
        count={count}
        onChange={setPage}
        label={rows ? `${rows.length} строк` : undefined}
      />
    </div>
  );
}

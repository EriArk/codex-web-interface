import { Component, lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { api } from "./api";

const PdfPreview = lazy(() => import("./PdfFilePreview"));
const textExtensions =
  /\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|yaml|yml|toml|ini|cfg|py|js|jsx|ts|tsx|css|scss|sql|sh|ps1|c|cpp|h|rs|go|java|rb|php|bat|env)$/i;
export function previewKind(file: File): "image" | "pdf" | "html" | "text" | "card" {
  if (
    /^image\/(png|jpeg|gif|webp|avif)$/.test(file.type) ||
    /\.(png|jpe?g|gif|webp|avif)$/i.test(file.name)
  )
    return "image";
  if (
    (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) &&
    file.size <= 12 * 1024 * 1024
  )
    return "pdf";
  if (/\.(html?|svg)$/i.test(file.name) || ["text/html", "image/svg+xml"].includes(file.type))
    return file.size <= 262144 ? "html" : "card";
  if (
    file.type.startsWith("text/") ||
    textExtensions.test(file.name) ||
    file.type === "application/json"
  )
    return "text";
  return "card";
}
function FileCard({ file }: { file: File }) {
  const type = file.name.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toUpperCase() || "Файл";
  return (
    <div className="file-type-card">
      <strong>{type}</strong>
      <span>
        {new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(file.size / 1024)} КБ
      </span>
    </div>
  );
}
class PreviewBoundary extends Component<{ children: ReactNode; file: File }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <FileCard file={this.props.file} /> : this.props.children;
  }
}
function TextOrHtml({ file, html }: { file: File; html: boolean }) {
  const [text, setText] = useState(""),
    [url, setUrl] = useState(""),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let resource = "";
    void (async () => {
      const value = await file.slice(0, html ? 262144 : 65536).text();
      if (controller.signal.aborted) return;
      if (value.includes(String.fromCharCode(0))) throw Error("binary");
      if (!html) {
        setText(value);
        return;
      }
      const data = await api<{ url: string }>("/previews/file", {
        method: "POST",
        body: { html: value },
        timeoutMs: 15000,
      });
      if (!/^\/api\/previews\/file\/[0-9a-f-]{36}$/.test(data.url)) throw Error("invalid frame");
      resource = data.url;
      if (controller.signal.aborted) {
        void api(resource.slice(4), { method: "DELETE" }).catch(() => {});
        return;
      }
      setUrl(resource);
    })().catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => {
      controller.abort();
      if (resource) void api(resource.slice(4), { method: "DELETE" }).catch(() => {});
    };
  }, [file, html]);
  if (failed) return <FileCard file={file} />;
  if (html)
    return url ? (
      <iframe
        className="file-html"
        title={"Предпросмотр " + file.name}
        src={url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    ) : (
      <p role="status">
        <span className="spinner" /> Загружаю предпросмотр…
      </p>
    );
  return (
    <>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded text pane must support keyboard scrolling. */}
      <pre className="file-text" tabIndex={0}>
        {text}
      </pre>
      {file.size > 65536 && <small>Показано начало файла</small>}
    </>
  );
}
export function FilePreview({ file, objectUrl }: { file: File; objectUrl: string }) {
  const kind = previewKind(file),
    [badImage, setBadImage] = useState(false);
  return (
    <PreviewBoundary file={file}>
      <div className="file-preview" data-kind={kind}>
        {kind === "image" ? (
          badImage ? (
            <FileCard file={file} />
          ) : (
            <img
              className="download-image"
              src={objectUrl}
              alt={file.name}
              onError={() => setBadImage(true)}
            />
          )
        ) : kind === "pdf" ? (
          <Suspense
            fallback={
              <p role="status">
                <span className="spinner" /> Загружаю предпросмотр…
              </p>
            }
          >
            <PdfPreview file={file} />
          </Suspense>
        ) : kind === "text" || kind === "html" ? (
          <TextOrHtml file={file} html={kind === "html"} />
        ) : (
          <FileCard file={file} />
        )}
      </div>
    </PreviewBoundary>
  );
}

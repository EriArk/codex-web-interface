import { Component, lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { workspaceMediaUrl } from "./accountStorage.ts";
import { api } from "./api";
import { CopyButton } from "./CopyButton";
import { previewKind, technicalFormat } from "./filePreviewRegistry";
import { ReadableFilePreview } from "./ReadableFilePreview";
import VectorPreview, { ImageViewport } from "./VectorFilePreview";

export { previewKind } from "./filePreviewRegistry";

const ModelPreview = lazy(() => import("./ModelFilePreview"));
const DxfPreview = lazy(() => import("./DxfFilePreview"));

const PdfPreview = lazy(() => import("./PdfFilePreview"));
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
        src={workspaceMediaUrl(url)}
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
      <CopyButton text={text} label="Копировать показанный текст" />
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded text pane must support keyboard scrolling. */}
      <pre className="file-text" tabIndex={0}>
        {text}
      </pre>
      {file.size > 65536 && <small>Показано начало файла</small>}
    </>
  );
}
export function FilePreview({
  file,
  objectUrl,
  source,
  full = false,
}: {
  file: File;
  objectUrl: string;
  source?: string;
  full?: boolean;
}) {
  const kind = previewKind(file),
    [badImage, setBadImage] = useState(false);
  return (
    <PreviewBoundary file={file}>
      <div className="file-preview" data-kind={kind}>
        {kind === "image" && full ? (
          <ImageViewport url={objectUrl} name={file.name} />
        ) : kind === "technical" ? (
          <Suspense fallback={<p role="status">Открываю просмотрщик…</p>}>
            {technicalFormat(file) === "svg" ? (
              <VectorPreview file={file} />
            ) : technicalFormat(file) === "dxf" ? (
              <DxfPreview file={file} />
            ) : (
              <ModelPreview file={file} source={source} />
            )}
          </Suspense>
        ) : kind === "audio" ? (
          // biome-ignore lint/a11y/useMediaCaption: The viewer opens an existing file without a supplied caption track.
          <audio src={objectUrl} controls preload="metadata" />
        ) : kind === "video" ? (
          // biome-ignore lint/a11y/useMediaCaption: The viewer opens an existing file without a supplied caption track.
          <video src={objectUrl} controls playsInline preload="metadata" />
        ) : kind === "image" ? (
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
        ) : kind === "text" ? (
          <ReadableFilePreview file={file} />
        ) : kind === "html" ? (
          <TextOrHtml file={file} html={kind === "html"} />
        ) : (
          <FileCard file={file} />
        )}
      </div>
    </PreviewBoundary>
  );
}

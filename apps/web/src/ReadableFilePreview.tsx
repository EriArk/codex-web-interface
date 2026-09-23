import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";

export function ReadableFilePreview({ file }: { file: File }) {
  const [text, setText] = useState(""),
    [wrap, setWrap] = useState(true),
    [raw, setRaw] = useState(false);
  const markdown = /\.(md|markdown)$/i.test(file.name);
  useEffect(() => {
    let live = true;
    void file
      .slice(0, 65536)
      .text()
      .then((value) => {
        if (live) setText(value.includes("\0") ? "Этот файл содержит двоичные данные." : value);
      });
    return () => {
      live = false;
    };
  }, [file]);
  return (
    <div className="readable-file">
      <fieldset className="file-view-tools" aria-label="Вид текста">
        <button
          type="button"
          className="secondary"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          Перенос строк
        </button>
        {markdown && (
          <button
            type="button"
            className="secondary"
            aria-pressed={raw}
            onClick={() => setRaw(!raw)}
          >
            Исходный текст
          </button>
        )}
        <CopyButton text={text} label="Копировать показанный текст" />
      </fieldset>
      {markdown && !raw && text.length <= 32768 ? (
        <div className="file-document">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            disallowedElements={["img"]}
            components={{ a: ({ children }) => <span>{children}</span> }}
          >
            {text}
          </ReactMarkdown>
        </div>
      ) : (
        <pre className="file-text" data-wrap={wrap}>
          {text}
        </pre>
      )}
      {file.size > 65536 && (
        <small>Показано начало файла · исходный файл доступен для скачивания</small>
      )}
    </div>
  );
}

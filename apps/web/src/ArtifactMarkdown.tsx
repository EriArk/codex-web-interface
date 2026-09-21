import { CHAT_BLOCK_LINES, textBlockLines, type ResultItem } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";
import { pageWorkspace, workspaceMediaUrl } from "./accountStorage";
import { CollapsibleCode, textOf } from "./CollapsibleCode";
import { CopyButton } from "./CopyButton";
import "./message-artifacts.css";

function MessageImage({
  source,
  alt,
  onOpen,
  resolveImage,
}: {
  source: string;
  alt: string;
  onOpen?: (source: string) => void;
  resolveImage?: (source: string) => Promise<string | undefined>;
}) {
  const native = artifactSource(source);
  const direct = source.startsWith("/api/") || source.startsWith("data:image/");
  const remote = !native && /^https?:\/\//i.test(source);
  const [url, setUrl] = useState(direct || remote ? source : "");
  const host = useRef<HTMLSpanElement>(null),
    resolver = useRef(resolveImage);
  resolver.current = resolveImage;
  useEffect(() => {
    let alive = true;
    if (direct || remote) {
      setUrl(source);
      return;
    }
    setUrl("");
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void resolver
          .current?.(source)
          .then((value) => {
            if (alive && value) setUrl(value);
          })
          .catch(() => {});
      },
      { rootMargin: "200px" },
    );
    if (host.current) observer.observe(host.current);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [source, direct, remote]);
  const content = url ? (
    <img src={workspaceMediaUrl(url)} alt={alt} loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <>
      <Icon name="image" size={16} />
      {alt || "Изображение"}
    </>
  );
  return (
    <span ref={host} className={remote ? "message-web-image" : "message-generated-image"}>
      {native && onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(source)}
          aria-label={alt || "Открыть изображение"}
        >
          {content}
        </button>
      ) : remote ? (
        <a href={source} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      ) : (
        content
      )}
    </span>
  );
}

/** Keep the source position of each exported block inside the original message. */
export function messageCode(
  text: string,
  onOpen?: (source: string) => void,
  complete = true,
): Components["pre"] {
  return ({ node, children }) => {
    const body = textOf(children);
    const raw = text.slice(node?.position?.start.offset, node?.position?.end.offset);
    const opening = /^( {0,3})(`{3,}|~{3,})[^\r\n]*\r?\n/.exec(raw);
    const closed =
      opening &&
      new RegExp(
        "(?:^|\\n) {0,3}" + opening[2]![0] + "{" + opening[2]!.length + ",}[ \\t]*\\r?$",
      ).test(raw);
    const closing =
      opening &&
      new RegExp(
        "(?:^|\\n) {0,3}" + opening[2]![0] + "{" + opening[2]!.length + ",}[ \\t]*\\r?$",
      ).exec(raw);
    const exact =
      opening && closing
        ? raw.slice(opening[0].length, closing.index + (raw[closing.index] === "\n" ? 1 : 0))
        : body;
    const reveal = async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exact));
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      onOpen?.(`text-block:${node!.position!.start.offset}:${hash}`);
    };
    if (
      onOpen &&
      complete &&
      closed &&
      node?.position?.start.column === 1 &&
      textBlockLines(body) > CHAT_BLOCK_LINES
    )
      return (
        <div className="copyable-block message-block-link">
          <button type="button" className="result-chip" onClick={() => void reveal()}>
            <Icon name="file" size={16} />
            Блок в результатах · {textBlockLines(body)} строк
            <Icon name="chevron" size={14} />
          </button>
          <CopyButton text={exact} label="Копировать блок" />
        </div>
      );
    if (textBlockLines(body) <= CHAT_BLOCK_LINES)
      return (
        <div className="copyable-block message-short-block">
          <pre>{children}</pre>
          <CopyButton text={exact} label="Копировать блок" />
        </div>
      );
    return <CollapsibleCode>{children}</CollapsibleCode>;
  };
}
import { DownloadLink, isDownloadUrl } from "./DownloadLink";
import { Icon } from "./icons";

export type ArtifactRequest = { scope: string } & (
  | { result: ResultItem }
  | { endpoint: string; reference: { source: string; messageId: string; turnId?: string | null } }
);
export type ArtifactSelection = { request: ArtifactRequest; item?: ResultItem; error?: string };

export function artifactSource(raw: string): string | undefined {
  if (!raw || raw.startsWith("#")) return;
  if (/^(?:https?:)?\/\//i.test(raw) || raw.startsWith("/api/")) {
    try {
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return;
      const workspace = url.searchParams.get("workspace");
      if (workspace && workspace !== pageWorkspace) return "unavailable:workspace";
      url.searchParams.delete("workspace");
      return url.pathname + url.search;
    } catch {
      return;
    }
  }
  if (/^(?:\/api\/|sandbox:|data:image\/|file:|\/?[a-z]:[\\/])/i.test(raw)) return raw;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && /\.[a-z0-9]{1,12}(?::\d+(?::\d+)?)?$/i.test(raw))
    return raw;
}

/** Intercept only artifact references in assistant Markdown, never global clicks. */
export function artifactComponents(
  onOpen?: (source: string) => void,
  resolveImage?: (source: string) => Promise<string | undefined>,
): Components {
  return {
    a: ({ node, ...props }) => {
      const href = String(props.href ?? "");
      const source = artifactSource(String(node?.properties.href ?? props.href ?? ""));
      if (onOpen && source)
        return (
          <button type="button" className="download-text" onClick={() => onOpen(source)}>
            {props.children}
          </button>
        );
      if (isDownloadUrl(props.href))
        return (
          <DownloadLink href={props.href} className="download-text">
            {props.children}
          </DownloadLink>
        );
      return props.href ? (
        <a
          {...props}
          className={props.title === "Источник" ? "source-link" : undefined}
          target={href.startsWith("#") ? undefined : "_blank"}
          rel="noopener noreferrer"
          onClick={(event) => {
            if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
              return;
            const url = new URL(href, location.href);
            if (!["http:", "https:"].includes(url.protocol) || url.origin === location.origin)
              return;
            event.preventDefault();
            window.open(url.href, "_blank", "popup=yes,width=1100,height=800,noopener,noreferrer");
          }}
        />
      ) : (
        <span>{props.children}</span>
      );
    },
    img: ({ node, ...props }) => {
      return (
        <MessageImage
          source={String(node?.properties.src ?? props.src ?? "")}
          alt={props.alt ?? ""}
          onOpen={onOpen}
          resolveImage={resolveImage}
        />
      );
    },
  };
}

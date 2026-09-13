import type { ResultItem } from "@codex-web/shared";
import type { Components } from "react-markdown";
import { pageWorkspace } from "./accountStorage";
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
export function artifactComponents(onOpen?: (source: string) => void): Components {
  return {
    a: ({ node, ...props }) => {
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
          target="_blank"
          rel="noopener noreferrer"
        />
      ) : (
        <span>{props.children}</span>
      );
    },
    img: ({ node, ...props }) => {
      const source = artifactSource(String(node?.properties.src ?? props.src ?? ""));
      return onOpen && source ? (
        <button
          type="button"
          className="result-chip"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(source);
          }}
        >
          <Icon name="image" size={16} />
          {props.alt || "Изображение в результатах"}
          <Icon name="chevron" size={14} />
        </button>
      ) : (
        <img {...props} alt={props.alt ?? ""} loading="lazy" />
      );
    },
  };
}

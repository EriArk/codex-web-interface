import {
  emptyResultCounts,
  type ResultCategory,
  type ResultItem,
  type ResultPage,
  resultCategory,
} from "@codex-web/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ArtifactRequest, ArtifactSelection } from "./ArtifactMarkdown";
import { ApiError, api, messageOf } from "./api";
import { Results } from "./Results";

export function ResultFeed({
  endpoint,
  revision,
  visible,
  focusId = "",
  focusCategory = "all",
  focusVersion = 0,
  extras = [],
  onTurn,
  toolbar,
  onFile,
  onSaveLink,
  onOverlayChange,
  onCount,
  reveal = null,
}: {
  endpoint: string;
  revision: string | number;
  visible: boolean;
  focusId?: string;
  focusCategory?: ResultCategory;
  focusVersion?: number;
  extras?: ResultItem[];
  toolbar?: ReactNode;
  onFile?: (path: string) => void;
  onSaveLink?: (result: ResultItem) => void;
  onTurn?: (id: string, threadId?: string) => void;
  onOverlayChange: (open: boolean) => void;
  onCount?: (count: number) => void;
  reveal?: ArtifactRequest | null;
}) {
  const [selection, setSelection] = useState<ArtifactSelection | null>(null);
  const [revealRetry, setRevealRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry repeats a read of the exact source reference.
  useEffect(() => {
    setSelection(reveal ? { request: reveal } : null);
    if (!reveal) return;
    const controller = new AbortController();
    void (async () => {
      try {
        let item: ResultItem;
        if ("result" in reveal) item = reveal.result;
        else {
          let reference: object = reveal.reference;
          if (reveal.reference.source.startsWith("data:image/")) {
            const hash = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(reveal.reference.source),
            );
            reference = {
              ...reveal.reference,
              source: "",
              sourceHash: Array.from(new Uint8Array(hash), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
            };
          }
          item = await api<ResultItem>(reveal.endpoint, {
            method: "POST",
            body: reference,
            signal: controller.signal,
            timeoutMs: 30000,
          });
        }
        if (!controller.signal.aborted) setSelection({ request: reveal, item });
      } catch (error) {
        if (!controller.signal.aborted) setSelection({ request: reveal, error: messageOf(error) });
      }
    })();
    return () => controller.abort();
  }, [reveal, revealRetry]);
  const [focused, setFocused] = useState<ResultItem | null>(null);
  const [sourceRevision, setSourceRevision] = useState<number | undefined>(undefined);
  const sourceRef = useRef<number | undefined>(undefined),
    fullyLoaded = useRef(false),
    loadedIds = useRef<string[]>([]);
  const [retry, setRetry] = useState(0);
  const [category, setCategory] = useState<ResultCategory>("all");
  const [items, setItems] = useState<ResultItem[]>([]),
    [counts, setCounts] = useState(emptyResultCounts);
  const [cursor, setCursor] = useState<string | number | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    readScope = useRef("");
  useEffect(() => {
    onCount?.(counts.all);
  }, [counts.all, onCount]);
  // Each response belongs to the exact conversation and category that requested it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry button deliberately repeats the same read.
  useEffect(() => {
    const current = ++generation.current;
    const scope = `${endpoint}?category=${category}`;
    if (scope !== readScope.current) {
      readScope.current = scope;
      setItems([]);
      fullyLoaded.current = false;
      loadedIds.current = [];
      setCursor(null);
      setFocused(null);
      sourceRef.current = undefined;
      setSourceRevision(undefined);
    }
    setError("");
    if (!endpoint) {
      setCounts(emptyResultCounts());
      return;
    }
    setBusy(true);
    void api<ResultPage>(endpoint + "?category=" + category)
      .then((data) => {
        if (current !== generation.current) return;
        setItems(data.items);
        loadedIds.current = data.items.map((item) => item.id);
        fullyLoaded.current = data.nextBefore === null;
        sourceRef.current = data.sourceRevision;
        setSourceRevision(data.sourceRevision);
        setCounts(data.counts ?? emptyResultCounts());
        setCursor(data.nextBefore);
      })
      .catch((e) => {
        if (current === generation.current) setError(messageOf(e));
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [endpoint, category, retry]);
  const revisionSeen = useRef(revision);
  useEffect(() => {
    if (revisionSeen.current === revision) return;
    revisionSeen.current = revision;
    if (!endpoint) return;
    const task = setTimeout(() => {
      const current = ++generation.current;
      void api<ResultPage>(endpoint + "?category=" + category)
        .then((data) => {
          if (current !== generation.current) return;
          setCounts(data.counts ?? emptyResultCounts());
          const replaced =
            data.sourceRevision !== undefined && data.sourceRevision !== sourceRef.current;
          const overlap = data.items.some((item) => loadedIds.current.includes(item.id));
          if (replaced || (!overlap && data.nextBefore !== null)) {
            // A changed native branch or a missed burst needs a fresh contiguous page.
            setItems(data.items);
            setCursor(data.nextBefore);
            setFocused(null);
            loadedIds.current = data.items.map((item) => item.id);
            fullyLoaded.current = data.nextBefore === null;
          } else {
            setItems((old) => [
              ...data.items,
              ...old.filter((row) => !data.items.some((next) => next.id === row.id)),
            ]);
            loadedIds.current = [
              ...new Set([...data.items.map((item) => item.id), ...loadedIds.current]),
            ];
            if (!fullyLoaded.current) setCursor((old) => old ?? data.nextBefore);
          }
          sourceRef.current = data.sourceRevision;
          setSourceRevision(data.sourceRevision);
          setError("");
          setBusy(false);
        })
        .catch((e) => {
          if (current === generation.current) {
            setError(messageOf(e));
            setBusy(false);
          }
        });
    }, 250);
    return () => clearTimeout(task);
  }, [revision, endpoint, category]);
  useEffect(() => {
    if (focusVersion) setCategory(focusCategory);
  }, [focusVersion, focusCategory]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reopening the same result is an explicit navigation request.
  useEffect(() => {
    setFocused(null);
    if (!focusId || !endpoint) return;
    let disposed = false;
    void api<ResultItem>(endpoint + "/" + encodeURIComponent(focusId))
      .then((item) => {
        if (!disposed) setFocused(item);
      })
      .catch((e) => {
        if (!disposed) setError(messageOf(e));
      });
    return () => {
      disposed = true;
    };
  }, [focusId, focusVersion, endpoint]);
  const older = async () => {
    if (cursor === null || busy || !endpoint) return;
    const current = ++generation.current,
      before = cursor;
    setBusy(true);
    try {
      const data = await api<ResultPage>(
        endpoint + "?category=" + category + "&before=" + encodeURIComponent(before),
      );
      if (current !== generation.current) return;
      if (data.sourceRevision !== undefined && data.sourceRevision !== sourceRef.current) {
        setRetry((value) => value + 1);
        return;
      }
      setItems((old) => [...new Map([...old, ...data.items].map((row) => [row.id, row])).values()]);
      setCounts(data.counts ?? emptyResultCounts());
      loadedIds.current = [
        ...new Set([...loadedIds.current, ...data.items.map((item) => item.id)]),
      ];
      fullyLoaded.current = data.nextBefore === null;
      setCursor(data.nextBefore);
      setError("");
    } catch (e) {
      if (current === generation.current) {
        if (e instanceof ApiError && e.code === "RESULTS_CHANGED") setRetry((value) => value + 1);
        else setError(messageOf(e));
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const all = [
    ...new Map(
      [...(focused ? [focused] : []), ...extras, ...items].map((row) => [row.id, row]),
    ).values(),
  ];
  const totals = { ...counts };
  totals.all = Math.max(totals.all, all.length);
  for (const key of ["images", "demos", "files", "links", "work"] as const)
    totals[key] = Math.max(
      totals[key] ?? 0,
      all.filter((row) => resultCategory(row.type) === key).length,
    );
  return (
    <Results
      key={sourceRevision ?? 0}
      results={all}
      visible={visible}
      focusId={focusId}
      selection={selection?.request === reveal ? selection : null}
      onRevealRetry={() => setRevealRetry((value) => value + 1)}
      busy={busy}
      hasMore={cursor !== null}
      onOlder={() => void older()}
      onTurn={onTurn}
      toolbar={toolbar}
      onFile={onFile}
      onSaveLink={onSaveLink}
      onOverlayChange={onOverlayChange}
      category={category}
      onCategory={setCategory}
      counts={totals}
      showLinks={endpoint.startsWith("/gpt/")}
      error={error}
      focusVersion={focusVersion}
      onRetry={() => setRetry((v) => v + 1)}
    />
  );
}

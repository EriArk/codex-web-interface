import type { ResultPage } from "@codex-web/shared";

/** A delta is meaningful only for the exact first-page snapshot it extends. */
export function mergeResultUpdate(
  previous: ResultPage | undefined,
  incoming: ResultPage,
): ResultPage {
  if (incoming.notModified) {
    if (!previous || previous.revision !== incoming.revision) throw Error("RESULTS_DELTA_MISMATCH");
    return { ...previous, counts: incoming.counts, sourceRevision: incoming.sourceRevision };
  }
  if (!incoming.delta) return incoming;
  if (!previous || previous.revision !== incoming.delta.baseRevision)
    throw Error("RESULTS_DELTA_MISMATCH");
  const removed = new Set(incoming.delta.removed),
    head = new Set(incoming.delta.head);
  const values = new Map(
    previous.items.filter((item) => !removed.has(item.id)).map((item) => [item.id, item]),
  );
  for (const item of incoming.items)
    if (values.has(item.id) || head.has(item.id)) values.set(item.id, item);
  if (incoming.delta.head.some((id) => !values.has(id))) throw Error("RESULTS_DELTA_MISMATCH");
  const items = [
    ...incoming.delta.head.map((id) => values.get(id)!),
    ...[...values.values()].filter((item) => !head.has(item.id)),
  ];
  return {
    items,
    revision: incoming.revision,
    sourceRevision: incoming.sourceRevision,
    counts: incoming.counts,
    nextBefore:
      previous.nextBefore === null
        ? null
        : items.some((item) => item.id === previous.nextBefore)
          ? previous.nextBefore
          : incoming.nextBefore,
  };
}

export function firstResultPage(page: ResultPage): ResultPage {
  return {
    ...page,
    items: page.items.slice(0, 20),
    nextBefore: page.items.length > 20 ? page.items[19]!.id : page.nextBefore,
  };
}

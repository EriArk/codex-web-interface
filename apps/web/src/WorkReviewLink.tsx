import type { ProjectScope, ReviewPage } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
export const reviewLabels = {
  pending: "Проверить работу",
  accepted: "Работа принята",
  needs_fixes: "Нужны исправления",
};
export function openWorkReview(scope: ProjectScope, id?: string) {
  window.dispatchEvent(
    new CustomEvent("open-work-review", { detail: { scope, itemId: id, mode: "reviews" } }),
  );
}
export function useThreadReviews(client: "codex" | "gpt", threadId: string | null | undefined) {
  const [items, setItems] = useState<ReviewPage["items"]>([]);
  useEffect(() => {
    let active = true;
    setItems([]);
    if (!threadId) return;
    let busy = false;
    let suspended = false;
    const refresh = async () => {
      if (!active || suspended || busy || document.hidden) return;
      busy = true;
      try {
        const page = await api<ReviewPage>(
          "/workspace/reviews?threadId=" + encodeURIComponent(threadId),
        );
        if (active) setItems(page.items.filter((r) => r.scope.client === client));
      } catch {
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 10000);
    const suspend = () => {
      suspended = true;
    };
    const resume = () => {
      suspended = false;
    };
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("work-review-changed", refresh);
    return () => {
      // This bounded metadata read may finish after navigation; never publish it to the new chat.
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("work-review-changed", refresh);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", resume);
    };
  }, [client, threadId]);
  return items;
}
export function WorkReviewLink({
  scope,
  id,
  state = "pending",
}: {
  scope: ProjectScope;
  id?: string;
  state?: keyof typeof reviewLabels;
}) {
  return (
    <button
      type="button"
      className="result-chip work-review-link"
      onClick={() => openWorkReview(scope, id)}
    >
      <Icon name={state === "accepted" ? "check" : "plan"} size={17} />
      {reviewLabels[state]}
      <Icon name="chevron" size={14} />
    </button>
  );
}

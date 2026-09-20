import type { ResultCategory, ResultCounts } from "@codex-web/shared";
import { useEffect, useRef } from "react";
import { Icon } from "./icons";
export const resultLabels: Record<ResultCategory, string> = {
  all: "Все",
  images: "Изображения",
  demos: "Демо",
  files: "Файлы",
  links: "Ссылки",
  work: "Работа",
  reasoning: "Рассуждения",
};
export function ResultFilters({
  category,
  counts,
  onChange,
  preview,
  onPreview,
  showLinks = false,
  showWork = true,
  showReasoning = false,
}: {
  category: ResultCategory;
  counts: ResultCounts;
  onChange: (category: ResultCategory) => void;
  preview: boolean;
  onPreview?: () => void;
  showLinks?: boolean;
  showWork?: boolean;
  showReasoning?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Keep the newly selected category or preview visible in the horizontal strip.
  useEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const reveal = () =>
      nav
        .querySelector<HTMLElement>('[aria-pressed="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const resize = new ResizeObserver(reveal);
    resize.observe(nav);
    return () => resize.disconnect();
  }, [category, preview]);
  return (
    <nav ref={ref} className="result-filters" aria-label="Категории результатов">
      {(["files", "images", "links", "demos", "reasoning", "work"] as ResultCategory[])
        .filter((key) => key !== "links" || showLinks)
        .filter((key) => key !== "work" || showWork)
        .filter((key) => key !== "reasoning" || showReasoning)
        .map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={!preview && key === category}
            onClick={() => onChange(key)}
          >
            {resultLabels[key]}
            {counts[key] > 0 && <span className="result-filter-count">{counts[key]}</span>}
          </button>
        ))}
      {onPreview && (
        <button type="button" aria-pressed={preview} onClick={onPreview}>
          <Icon name="remote" size={16} />
          Предпросмотр
        </button>
      )}
    </nav>
  );
}

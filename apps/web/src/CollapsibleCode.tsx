import type { ComponentProps } from "react";
export function CollapsibleCode({ children }: ComponentProps<"pre">) {
  return (
    <details className="code-disclosure">
      <summary>Показать код</summary>
      <pre>{children}</pre>
    </details>
  );
}

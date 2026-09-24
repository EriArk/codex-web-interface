import {
  forwardRef,
  type TextareaHTMLAttributes,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";

/** One multiline input policy across chat, dialogs and forms: four to eight visual lines. */
export const AutoTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function AutoTextarea({ style, onInput, ...props }, forwarded) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const measure = useCallback(() => {
    const field = input.current;
    if (!field || !field.getClientRects().length || !field.clientWidth) return;
    const css = getComputedStyle(field),
      mirror = document.createElement("textarea");
    // Measure a detached-from-layout twin: shrinking the live input can move its scroll parent.
    for (const key of [
      "font",
      "font-size",
      "font-family",
      "font-weight",
      "font-style",
      "line-height",
      "letter-spacing",
      "word-spacing",
      "text-indent",
      "text-transform",
      "tab-size",
      "padding",
      "border",
      "white-space",
      "overflow-wrap",
      "word-break",
    ])
      mirror.style.setProperty(key, css.getPropertyValue(key));
    const border = parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth);
    const padding = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
    mirror.style.cssText += `;position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;width:${field.getBoundingClientRect().width}px;height:0;min-height:0;max-height:none;overflow:hidden;resize:none;`;
    mirror.tabIndex = -1;
    mirror.setAttribute("aria-hidden", "true");
    mirror.wrap = field.wrap;
    mirror.value = "x";
    document.body.append(mirror);
    const line = parseFloat(css.lineHeight) || mirror.scrollHeight - padding;
    mirror.value = field.value || " ";
    const lines = Math.max(4, Math.ceil((mirror.scrollHeight - padding - 1) / line));
    mirror.remove();
    field.style.height = `${Math.min(8, lines) * line + padding + border}px`;
    field.style.overflowY = lines > 8 ? "auto" : "hidden";
  }, []);
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    // Height changes from measurement must not run inside ResizeObserver delivery.
    // WebKit otherwise reports a resize loop when themes or the viewport change.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(field);
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) measure();
    });
    const fonts = () => measure();
    document.fonts.addEventListener("loadingdone", fonts);
    return () => {
      active = false;
      observer.disconnect();
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", fonts);
    };
  }, [measure]);
  return (
    <textarea
      {...props}
      rows={4}
      ref={(node) => {
        input.current = node;
        if (typeof forwarded === "function") forwarded(node);
        else if (forwarded) forwarded.current = node;
      }}
      style={{ ...style, boxSizing: "border-box", minHeight: 0, maxHeight: "none", resize: "none" }}
      onInput={(event) => {
        measure();
        onInput?.(event);
      }}
    />
  );
});

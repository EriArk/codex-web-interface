import { type RefObject, useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";
import "./chat-navigation.css";

type ChatNavigationProps = {
  scroller: RefObject<HTMLDivElement | null>;
  visible?: boolean;
  hasOlder?: boolean;
  hasNewer?: boolean;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  loadOlder?: () => Promise<void>;
  loadNewer?: () => Promise<void>;
  onNavigate?: () => void;
  onEnd?: () => void;
};

type NavState = {
  messages: number;
  current: number;
  atEnd: boolean;
};

const emptyState: NavState = { messages: 0, current: -1, atEnd: true };

function messages(scroller: HTMLDivElement): HTMLElement[] {
  return Array.from(
    scroller.querySelectorAll<HTMLElement>('[data-chat-nav="true"][data-message]'),
  ).filter((node) => node.offsetParent !== null);
}

function currentMessage(scroller: HTMLDivElement, nodes: HTMLElement[]): number {
  if (!nodes.length) return -1;
  const box = scroller.getBoundingClientRect();
  const anchor = box.top + Math.min(48, Math.max(12, scroller.clientHeight * 0.08));
  const firstVisible = nodes.findIndex((node) => node.getBoundingClientRect().bottom > anchor);
  return firstVisible < 0 ? nodes.length - 1 : firstVisible;
}

function afterPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

export function ChatNavigation({
  scroller,
  visible = true,
  hasOlder = false,
  hasNewer = false,
  loadingOlder = false,
  loadingNewer = false,
  loadOlder,
  loadNewer,
  onNavigate,
  onEnd,
}: ChatNavigationProps) {
  const [state, setState] = useState<NavState>(emptyState);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el || !visible) {
      setState(emptyState);
      return;
    }
    const nodes = messages(el);
    const next = {
      messages: nodes.length,
      current: currentMessage(el, nodes),
      atEnd: el.scrollHeight - el.scrollTop - el.clientHeight < 100,
    };
    setState((old) =>
      old.messages === next.messages && old.current === next.current && old.atEnd === next.atEnd
        ? old
        : next,
    );
  }, [scroller, visible]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !visible) {
      setState(emptyState);
      return;
    }
    const changed = () => measure();
    const mutation = new MutationObserver(changed);
    const resize = new ResizeObserver(changed);
    el.addEventListener("scroll", changed, { passive: true });
    mutation.observe(el, { childList: true, subtree: true });
    resize.observe(el);
    measure();
    return () => {
      el.removeEventListener("scroll", changed);
      mutation.disconnect();
      resize.disconnect();
    };
  }, [scroller, visible, measure]);

  const reveal = useCallback(
    (target: HTMLElement | undefined) => {
      if (!target) return;
      onNavigate?.();
      target.scrollIntoView({ block: "start" });
      requestAnimationFrame(measure);
    },
    [measure, onNavigate],
  );

  const previous = useCallback(async () => {
    const el = scroller.current;
    if (!el || loadingOlder) return;
    let nodes = messages(el);
    let index = currentMessage(el, nodes);
    if (index > 0) {
      reveal(nodes[index - 1]);
      return;
    }
    if (!hasOlder || !loadOlder) return;

    const currentId = nodes[index]?.dataset.message;
    onNavigate?.();
    await loadOlder();
    await afterPaint();
    nodes = messages(el);
    index = currentId ? nodes.findIndex((node) => node.dataset.message === currentId) : -1;
    reveal(index > 0 ? nodes[index - 1] : nodes[0]);
  }, [scroller, loadingOlder, hasOlder, loadOlder, onNavigate, reveal]);

  const next = useCallback(async () => {
    const el = scroller.current;
    if (!el || loadingNewer) return;
    let nodes = messages(el);
    const index = currentMessage(el, nodes);
    if (index >= 0 && index < nodes.length - 1) {
      reveal(nodes[index + 1]);
      return;
    }
    if (!hasNewer || !loadNewer) return;

    onNavigate?.();
    await loadNewer();
    await afterPaint();
    nodes = messages(el);
    reveal(nodes[0]);
  }, [scroller, loadingNewer, hasNewer, loadNewer, onNavigate, reveal]);

  const end = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    onEnd?.();
    requestAnimationFrame(measure);
  }, [scroller, onEnd, measure]);

  const canPrevious = state.current > 0 || hasOlder;
  const canNext = (state.current >= 0 && state.current < state.messages - 1) || hasNewer;
  const useful = state.messages > 1 || hasOlder || hasNewer || !state.atEnd;
  if (!visible || !useful) return null;

  return (
    <nav className="chat-navigation" aria-label="Навигация по сообщениям">
      <button
        type="button"
        className="icon-button"
        aria-label="Предыдущее сообщение"
        disabled={!canPrevious || loadingOlder}
        onClick={() => void previous()}
      >
        <Icon name="arrow-up" size={17} />
      </button>
      <button
        type="button"
        className="icon-button chat-navigation-next"
        aria-label="Следующее сообщение"
        disabled={!canNext || loadingNewer}
        onClick={() => void next()}
      >
        <Icon name="arrow-up" size={17} />
      </button>
      <button
        type="button"
        className="icon-button chat-navigation-end"
        aria-label="К последним сообщениям"
        disabled={state.atEnd && !hasNewer}
        onClick={end}
      >
        <Icon name="arrow-up" size={17} />
      </button>
    </nav>
  );
}

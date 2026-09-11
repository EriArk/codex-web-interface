import type { NotebookLink } from "@codex-web/shared";
import { lazy, Suspense, useEffect, useState } from "react";
import { Icon } from "./icons";

const Delivery = lazy(() => import("./ProjectDelivery"));
export type DeliveryRequest = { projectId: string; projectName: string; reviewId?: string };
export function DeliveryButton({ projectId, projectName, reviewId }: DeliveryRequest) {
  return (
    <button
      type="button"
      className="secondary delivery-shortcut"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("open-project-delivery", {
            detail: { projectId, projectName, reviewId },
          }),
        )
      }
    >
      <Icon name="branch" size={17} />
      Доставка
    </button>
  );
}
export function ProjectDeliveryHost() {
  const [request, setRequest] = useState<DeliveryRequest>();
  useEffect(() => {
    const open = (e: Event) => setRequest((e as CustomEvent<DeliveryRequest>).detail),
      end = () => {
        setRequest(undefined);
        try {
          for (const k of Object.keys(localStorage))
            if (k.startsWith("delivery-draft:")) localStorage.removeItem(k);
        } catch {}
      };
    window.addEventListener("open-project-delivery", open);
    window.addEventListener("private-session-ended", end);
    return () => {
      window.removeEventListener("open-project-delivery", open);
      window.removeEventListener("private-session-ended", end);
    };
  }, []);
  const open = (target: NotebookLink) => {
    setRequest(undefined);
    window.dispatchEvent(new CustomEvent("open-delivery-target", { detail: target }));
  };
  return request ? (
    <Suspense
      fallback={
        <div className="device-loading" role="status">
          Открываем доставку…
        </div>
      }
    >
      <Delivery
        key={request.projectId}
        request={request}
        onClose={() => setRequest(undefined)}
        onOpen={open}
      />
    </Suspense>
  ) : null;
}

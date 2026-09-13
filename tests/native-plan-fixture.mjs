import { randomUUID } from "node:crypto";
import { handoffFixture, settings } from "./handoff-fixture.mjs";

export async function nativePlanFixture(origin, webRoot) {
  const f = await handoffFixture(origin, webRoot);
  await f.release();
  const request = f.rpc.request.bind(f.rpc);
  const history = [];
  let native = null,
    queued = [],
    afterRead = () => {};
  f.rpc.request = async (method, params) => {
    if (method === "thread/items/list")
      return {
        data:
          params.threadId !== f.thread.codexThreadId
            ? []
            : [...history, ...(native && !history.some((t) => t.id === native.id) ? [native] : [])]
                .reverse()
                .flatMap((turn) =>
                  [...turn.items].reverse().map((item) => ({ item, turnId: turn.id })),
                ),
      };
    if (method === "thread/turns/list") {
      f.calls.push({ method, params });
      const data = native ? [structuredClone(native)] : [];
      afterRead();
      return { data };
    }
    if (method === "thread/queue/list") return { data: queued };
    if (method === "turn/start") {
      const id = randomUUID();
      native = {
        id,
        itemsView: "full",
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            id: randomUUID(),
            clientId: params.clientUserMessageId,
            content: params.input,
          },
        ],
      };
      const result = await request(method, params);
      native.id = result.turn.id;
      return result;
    }
    return request(method, params);
  };
  const plan = async (mode = "plan", status = "completed") => {
    const sent = await f.send(randomUUID(), {
      text: "Подготовь план",
      settings: { ...settings, mode },
    });
    if (sent.statusCode !== 200) throw new Error(sent.body);
    const item = {
      type: "plan",
      id: randomUUID(),
      text: "## Точный план\n\n1. Сохрани файлы.\n2. Проверь результат.\n",
    };
    const turnId = f.store.thread(f.thread.id).activeTurnId;
    f.rpc.emit("notification", "item/completed", {
      threadId: f.thread.codexThreadId,
      turnId,
      item,
    });
    native = { id: turnId, status, itemsView: "full", items: [...native.items, item] };
    history.push(native);
    f.rpc.emit("notification", "turn/completed", {
      threadId: f.thread.codexThreadId,
      turn: native,
    });
    return item;
  };
  const call = async (method = "GET", payload, suffix = "") => {
    const result = await f.app.inject({
      method,
      url: `/api/threads/${f.thread.id}/native-plan${suffix}`,
      headers: f.headers,
      payload,
    });
    return { status: result.statusCode, data: result.json() };
  };
  return {
    ...f,
    plan,
    call,
    native: () => native,
    queue: (items) => {
      queued = items;
    },
    afterRead: (run) => {
      afterRead = run;
    },
  };
}

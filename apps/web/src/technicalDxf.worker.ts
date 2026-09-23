import { DxfViewer } from "dxf-viewer";

let source: { url: string; text: string } | undefined;
const nativeFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  if (source && String(input) === source.url)
    return Promise.resolve(
      new Response(source.text, {
        headers: { "Content-Length": String(new TextEncoder().encode(source.text).length) },
      }),
    );
  if (String(input) !== new URL("/fonts/DejaVuSans.ttf", self.location.href).href)
    return Promise.reject(Error("Внешние ресурсы запрещены."));
  return nativeFetch(input, init);
};

// The vendor parser/scene builder runs off the UI thread and is terminated by its owner.
const send = self.postMessage.bind(self);
self.postMessage = ((
  message: {
    data?: { scene?: { vertices?: ArrayBuffer; indices?: ArrayBuffer; transforms?: ArrayBuffer } };
    error?: string;
  },
  options?: StructuredSerializeOptions,
) => {
  const s = message.data?.scene;
  if (
    s &&
    (s.vertices?.byteLength ?? 0) + (s.indices?.byteLength ?? 0) + (s.transforms?.byteLength ?? 0) >
      32 * 1024 * 1024
  ) {
    send({ ...message, data: undefined, error: "Чертёж слишком сложный для просмотра." });
    return;
  }
  send(message, options ?? {});
}) as typeof self.postMessage;
DxfViewer.SetupWorker();
const receive = self.onmessage;
self.onmessage = (event) => {
  if (event.data?.kind === "source") {
    if (typeof event.data.text !== "string" || event.data.text.length > 2 * 1024 * 1024)
      throw Error("Чертёж слишком большой.");
    source = { url: event.data.url, text: event.data.text };
  } else receive?.call(self, event);
};

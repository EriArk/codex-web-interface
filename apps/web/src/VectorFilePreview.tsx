import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

/** Static SVG subset: no script, CSS, external resources, links, foreign HTML or animation. */
export function sanitizeSvg(text: string) {
  if (text.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text))
    throw Error("Неподдерживаемый SVG.");
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg")
    throw Error("Некорректный SVG.");
  const root = doc.documentElement,
    nodes = Array.from(root.querySelectorAll("*"));
  if (nodes.length > 5000) throw Error("SVG слишком сложный для просмотра.");
  const tags = new Set([
    "svg",
    "g",
    "defs",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "title",
    "desc",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "mask",
    "use",
    "symbol",
  ]);
  const attrs = new Set([
    "xmlns",
    "id",
    "x",
    "y",
    "x1",
    "x2",
    "y1",
    "y2",
    "dx",
    "dy",
    "width",
    "height",
    "viewBox",
    "preserveAspectRatio",
    "d",
    "points",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "fill",
    "fill-rule",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-dashoffset",
    "opacity",
    "transform",
    "font-size",
    "font-family",
    "font-weight",
    "text-anchor",
    "dominant-baseline",
    "offset",
    "stop-color",
    "stop-opacity",
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "fx",
    "fy",
    "clip-path",
    "clip-rule",
    "mask",
  ]);
  let removed = false;
  for (const node of [root, ...nodes]) {
    if (
      !tags.has(node.localName) ||
      node.namespaceURI !== "http://www.w3.org/2000/svg" ||
      node.localName === "use"
    ) {
      node.remove();
      removed = true;
      continue;
    }
    for (const attr of Array.from(node.attributes)) {
      if (
        !attrs.has(attr.name) ||
        attr.value.length > 262144 ||
        (/url\s*\(/i.test(attr.value) && !/^url\(#[a-zA-Z0-9_-]+\)$/.test(attr.value))
      ) {
        node.removeAttributeNode(attr);
        removed = true;
      }
    }
  }
  return {
    text: new XMLSerializer().serializeToString(root),
    width: root.getAttribute("width"),
    height: root.getAttribute("height"),
    viewBox: root.getAttribute("viewBox"),
    removed,
  };
}
export function ImageViewport({ url, name }: { url: string; name: string }) {
  const [scale, setScale] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [background, setBackground] = useState("checker");
  const pointers = useRef(new Map<number, { x: number; y: number }>()),
    host = useRef<HTMLDivElement>(null);
  const fit = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };
  const zoom = useCallback(
    (factor: number) => setScale((old) => Math.min(16, Math.max(0.1, old * factor))),
    [],
  );
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [zoom]);
  return (
    <div className="image-viewport">
      <fieldset className="file-view-tools" aria-label="Вид изображения">
        <button
          type="button"
          className="icon-button"
          aria-label="Вписать изображение"
          onClick={fit}
        >
          <Icon name="expand" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Уменьшить"
          onClick={() => zoom(0.8)}
        >
          <Icon name="minus" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Увеличить"
          onClick={() => zoom(1.25)}
        >
          <Icon name="plus" />
        </button>
        <output>{Math.round(scale * 100)}%</output>
        <select
          aria-label="Фон изображения"
          value={background}
          onChange={(e) => setBackground(e.target.value)}
        >
          <option value="checker">Прозрачность</option>
          <option value="light">Светлый</option>
          <option value="dark">Тёмный</option>
        </select>
      </fieldset>
      <div
        ref={host}
        className="image-stage"
        data-background={background}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }}
        onPointerMove={(e) => {
          const old = pointers.current.get(e.pointerId);
          if (!old) return;
          const other = Array.from(pointers.current.entries()).find(
            ([id]) => id !== e.pointerId,
          )?.[1];
          if (other) {
            const before = Math.hypot(old.x - other.x, old.y - other.y),
              after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
            if (before > 4) zoom(after / before);
          } else setPan((p) => ({ x: p.x + e.clientX - old.x, y: p.y + e.clientY - old.y }));
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }}
        onPointerUp={(e) => pointers.current.delete(e.pointerId)}
        onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
      >
        <img
          src={url}
          alt={name}
          draggable={false}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
        />
      </div>
    </div>
  );
}
export default function VectorFilePreview({ file }: { file: File }) {
  const [svg, setSvg] = useState<(ReturnType<typeof sanitizeSvg> & { url: string }) | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true,
      url = "";
    void file
      .text()
      .then((text) => {
        if (!live) return;
        const value = sanitizeSvg(text);
        url = URL.createObjectURL(new Blob([value.text], { type: "image/svg+xml" }));
        setSvg({ ...value, url });
      })
      .catch(() => {
        if (live) setError("Не удалось прочитать SVG.");
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  if (error) return <p role="status">{error}</p>;
  return svg ? (
    <>
      <ImageViewport url={svg.url} name={file.name} />
      <div className="technical-status">
        <span>
          {svg.width || "авто"} × {svg.height || "авто"}
        </span>
        {svg.viewBox && <span>viewBox {svg.viewBox}</span>}
        {svg.removed && <span>Активные и внешние элементы исключены</span>}
      </div>
    </>
  ) : (
    <p role="status">Открываю чертёж…</p>
  );
}

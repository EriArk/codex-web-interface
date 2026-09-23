import { DxfViewer, type LayerInfo } from "dxf-viewer";
import { useEffect, useRef, useState } from "react";
import { Color, Vector3 } from "three";
import { Icon } from "./icons";

type View = { x: number; y: number; width: number; height: number; px: number; py: number };
/** Viewer and measurement behaviour adapted from EriArk/-DXF-Viewer (MIT). */
export default function DxfFilePreview({ file }: { file: File }) {
  const host = useRef<HTMLDivElement>(null),
    viewer = useRef<DxfViewer | null>(null),
    points = useRef<{ x: number; y: number }[]>([]);
  const [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [warnings, setWarnings] = useState(false),
    [layers, setLayers] = useState<LayerInfo[]>([]),
    [hidden, setHidden] = useState<string[]>([]);
  const [mono, setMono] = useState(false),
    [thick, setThick] = useState(false),
    [measure, setMeasure] = useState(false),
    [snap, setSnap] = useState(true),
    [unit, setUnit] = useState("ед.");
  const [view, setView] = useState<View | null>(null),
    [bounds, setBounds] = useState<number[]>([]),
    [guides, setGuides] = useState<number[]>([0, 0, 0, 0]);
  const drag = useRef<number | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let live = true,
      worker: Worker | undefined,
      url = "",
      v: DxfViewer | undefined;
    const timer = setTimeout(() => {
      worker?.terminate();
      if (live) setError("Чертёж слишком сложный для просмотра.");
    }, 20000);
    void (async () => {
      const text = await file.text();
      if (!live) return;
      if (file.size > 2 * 1024 * 1024 || text.split(/\r?\n0\r?\n/).length > 20000)
        throw Error("Чертёж превышает лимит просмотра.");
      url = URL.createObjectURL(new Blob([text]));
      v = new DxfViewer(element, {
        autoResize: true,
        clearColor: new Color(0xf7f8f8),
        retainParsedDxf: true,
        preserveDrawingBuffer: false,
        sceneOptions: { arcTessellationAngle: Math.PI / 36, minArcTessellationSubdivisions: 8 },
      });
      viewer.current = v;
      if (!v.HasRenderer()) throw Error("Графика недоступна в этом браузере.");
      v.GetRenderer()?.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      v.Subscribe("message", (event) => {
        if (live && event.detail?.level !== "info") setWarnings(true);
      });
      const update = () => {
        if (!live || !v) return;
        const c = v.GetCamera(),
          origin = v.GetOrigin();
        if (!origin) return;
        const w = (c.right - c.left) / c.zoom,
          h = (c.top - c.bottom) / c.zoom;
        setView({
          x: c.position.x - w / 2 + origin.x,
          y: c.position.y + h / 2 + origin.y,
          width: w,
          height: h,
          px: element.clientWidth,
          py: element.clientHeight,
        });
      };
      v.Subscribe("viewChanged", update);
      v.Subscribe("resized", update);
      await v.Load({
        url,
        fonts: [new URL("/fonts/DejaVuSans.ttf", location.href).href],
        workerFactory: () => {
          worker = new Worker(new URL("./technicalDxf.worker.ts", import.meta.url), {
            type: "module",
          });
          worker.postMessage({ kind: "source", url, text });
          return worker;
        },
      });
      if (!live) return;
      const box = v.GetBounds();
      if (!box) throw Error("В чертеже нет видимых объектов.");
      setBounds([box.maxX - box.minX, box.maxY - box.minY]);
      setGuides([box.minX, box.maxX, box.minY, box.maxY]);
      const dxf = v.GetDxf();
      const units: Record<number, string> = {
        1: "in",
        2: "ft",
        4: "mm",
        5: "cm",
        6: "m",
        8: "µin",
        9: "mil",
        10: "yd",
        13: "µm",
      };
      setUnit(units[Number(dxf?.header?.$INSUNITS)] ?? "ед. (не заданы)");
      const known = new Set([
        "LINE",
        "LWPOLYLINE",
        "POLYLINE",
        "VERTEX",
        "SEQEND",
        "CIRCLE",
        "ARC",
        "ELLIPSE",
        "SPLINE",
        "INSERT",
        "TEXT",
        "MTEXT",
        "HATCH",
        "SOLID",
        "3DFACE",
        "POINT",
        "DIMENSION",
      ]);
      const endpoints: { x: number; y: number }[] = [];
      for (const e of dxf?.entities ?? []) {
        if (!known.has(e.type)) setWarnings(true);
        for (const p of e.vertices ?? [])
          if (Number.isFinite(p.x) && Number.isFinite(p.y) && endpoints.length < 20000)
            endpoints.push({ x: p.x, y: p.y });
        if (e.center && endpoints.length < 20000) endpoints.push(e.center);
      }
      points.current = endpoints;
      setLayers(Array.from(v.GetLayers()).slice(0, 256));
      setReady(true);
      update();
    })()
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : "Не удалось прочитать DXF.");
      })
      .finally(() => {
        clearTimeout(timer);
      });
    return () => {
      live = false;
      clearTimeout(timer);
      worker?.terminate();
      v?.Destroy();
      viewer.current = null;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  const fit = () => {
    const v = viewer.current,
      b = v?.GetBounds();
    if (v && b) v.FitView(b.minX, b.maxX, b.minY, b.maxY, 0.08);
  };
  const zoom = (factor: number) => {
    const v = viewer.current;
    if (!v) return;
    const c = v.GetCamera();
    v.SetView(new Vector3(c.position.x, c.position.y, 0), ((c.right - c.left) / c.zoom) * factor);
  };
  const position = (i: number) =>
    !view
      ? 0
      : i < 2
        ? ((guides[i]! - view.x) / view.width) * view.px
        : ((view.y - guides[i]!) / view.height) * view.py;
  return (
    <div className="dxf-file">
      <fieldset className="file-view-tools" aria-label="Вид чертежа">
        <button type="button" className="icon-button" aria-label="Вписать чертёж" onClick={fit}>
          <Icon name="expand" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Уменьшить"
          onClick={() => zoom(1.25)}
        >
          <Icon name="minus" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Увеличить"
          onClick={() => zoom(0.8)}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="secondary"
          aria-pressed={measure}
          onClick={() => setMeasure(!measure)}
        >
          Измерение
        </button>
        <details className="file-view-options">
          <summary>Вид и слои</summary>
          <div>
            <label>
              <input type="checkbox" checked={mono} onChange={(e) => setMono(e.target.checked)} />{" "}
              Монохром
            </label>
            <label>
              <input type="checkbox" checked={thick} onChange={(e) => setThick(e.target.checked)} />{" "}
              Усилить линии
            </label>
            <label>
              <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />{" "}
              Привязка к точкам
            </label>
            {layers.map((l) => (
              <label key={l.name}>
                <input
                  type="checkbox"
                  checked={!hidden.includes(l.name)}
                  onChange={(e) => {
                    viewer.current?.ShowLayer(l.name, e.target.checked);
                    setHidden((old) =>
                      e.target.checked ? old.filter((x) => x !== l.name) : [...old, l.name],
                    );
                  }}
                />
                {l.displayName}
              </label>
            ))}
          </div>
        </details>
      </fieldset>
      {!ready && !error && (
        <p role="status">
          <span className="spinner" /> Читаю чертёж…
        </p>
      )}
      {error && <p role="status">{error}</p>}
      <div className="dxf-stage" data-mono={mono} data-thick={thick}>
        <div ref={host} className="technical-canvas" role="img" aria-label="Чертёж DXF" />
        {measure && view && (
          <svg
            className="dxf-guides"
            width="100%"
            height="100%"
            aria-label="Линейки и направляющие"
          >
            <rect width="100%" height="22" className="ruler-surface" />
            <rect width="30" height="100%" className="ruler-surface" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <g key={i}>
                <text x={(view.px * i) / 6 + 32} y="15">
                  {(view.x + (view.width * i) / 6).toFixed(1)}
                </text>
                <text x="3" y={(view.py * (i + 1)) / 7}>
                  {(view.y - (view.height * (i + 1)) / 7).toFixed(1)}
                </text>
              </g>
            ))}
            {[0, 1, 2, 3].map((i) => (
              <g key={i}>
                <line
                  className="dxf-guide-ink"
                  x1={i < 2 ? position(i) : 0}
                  x2={i < 2 ? position(i) : view.px}
                  y1={i < 2 ? 0 : position(i)}
                  y2={i < 2 ? view.py : position(i)}
                />
                <line
                  className="dxf-guide"
                  tabIndex={0}
                  role="slider"
                  aria-label={`Направляющая ${i < 2 ? "X" : "Y"}${(i % 2) + 1}`}
                  aria-valuenow={guides[i]}
                  aria-valuemin={i < 2 ? view.x : view.y - view.height}
                  aria-valuemax={i < 2 ? view.x + view.width : view.y}
                  onKeyDown={(e) => {
                    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
                      e.preventDefault();
                      const delta =
                        ((i < 2 ? view.width : view.height) / 100) *
                        (e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1);
                      setGuides((old) => old.map((n, k) => (k === i ? n + delta : n)));
                    }
                  }}
                  x1={i < 2 ? position(i) : 0}
                  x2={i < 2 ? position(i) : view.px}
                  y1={i < 2 ? 0 : position(i)}
                  y2={i < 2 ? view.py : position(i)}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    drag.current = i;
                  }}
                  onPointerMove={(e) => {
                    if (drag.current !== i) return;
                    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                    let value =
                      i < 2
                        ? view.x + ((e.clientX - box.left) / view.px) * view.width
                        : view.y - ((e.clientY - box.top) / view.py) * view.height;
                    const tolerance = (i < 2 ? view.width / view.px : view.height / view.py) * 8;
                    if (snap) {
                      let nearest = tolerance;
                      for (const p of points.current) {
                        const n = i < 2 ? p.x : p.y,
                          d = Math.abs(n - value);
                        if (d < nearest) {
                          nearest = d;
                          value = n;
                        }
                      }
                    }
                    setGuides((old) => old.map((n, k) => (k === i ? value : n)));
                  }}
                  onPointerUp={() => {
                    drag.current = null;
                  }}
                  onPointerCancel={() => {
                    drag.current = null;
                  }}
                />
              </g>
            ))}
          </svg>
        )}
      </div>
      {ready && (
        <div className="technical-status">
          <span>
            {bounds[0]?.toFixed(2)} × {bounds[1]?.toFixed(2)} {unit}
          </span>
          {measure && (
            <span>
              ΔX {Math.abs(guides[1]! - guides[0]!).toFixed(2)} · ΔY{" "}
              {Math.abs(guides[3]! - guides[2]!).toFixed(2)} {unit}
            </span>
          )}
          {warnings && <span>Некоторые элементы не отображены</span>}
        </div>
      )}
    </div>
  );
}

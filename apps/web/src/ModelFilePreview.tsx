import { useEffect, useRef, useState } from "react";
import {
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { api, messageOf } from "./api";
import { technicalFormat } from "./filePreviewRegistry";
import { Icon } from "./icons";
import type { MeshDocument } from "./technicalMesh";

export default function ModelFilePreview({ file, source }: { file: File; source?: string }) {
  const host = useRef<HTMLDivElement>(null),
    tools = useRef<{
      fit: () => void;
      zoom: (factor: number) => void;
      view: (axis: string) => void;
    } | null>(null);
  const [doc, setDoc] = useState<MeshDocument | null>(null),
    [error, setError] = useState(""),
    [dimensions, setDimensions] = useState<number[]>([]),
    [unit, setUnit] = useState("mm"),
    [wire, setWire] = useState(false);
  const materials = useRef<MeshStandardMaterial[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let worker: Worker | undefined;
    const timer = setTimeout(() => {
      controller.abort();
      worker?.terminate();
      setError("Модель слишком сложная для просмотра.");
    }, 60000);
    void (async () => {
      const buffer = await file.arrayBuffer(),
        format = technicalFormat(file);
      if (controller.signal.aborted) return;
      let value: MeshDocument;
      if (format === "step" || format === "iges") {
        if (!source) throw Error("Открой модель из Файлов или Результатов.");
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
        const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
        value = await api<MeshDocument>(
          source.startsWith("/api/team/") ? "/team/previews/technical" : "/previews/technical",
          {
            method: "POST",
            body: { source: { kind: "file", download: source }, format, sha256 },
            signal: controller.signal,
            timeoutMs: 60000,
          },
        );
      } else {
        worker = new Worker(new URL("./technicalMesh.worker.ts", import.meta.url), {
          type: "module",
        });
        value = await new Promise<MeshDocument>((resolve, reject) => {
          worker!.onmessage = (event) =>
            event.data.error ? reject(Error(event.data.error)) : resolve(event.data.document);
          worker!.onerror = () => reject(Error("Не удалось прочитать модель."));
          worker!.postMessage({ format, buffer }, [buffer]);
        });
      }
      if (!controller.signal.aborted) setDoc(value);
    })()
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      })
      .finally(() => {
        clearTimeout(timer);
        worker?.terminate();
      });
    return () => {
      controller.abort();
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [file, source]);
  useEffect(() => {
    if (!host.current || !doc) return;
    const element = host.current;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setError("3D-графика недоступна в этом браузере.");
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    const scene = new Scene(),
      group = new Group(),
      camera = new PerspectiveCamera(38, 1, 0.01, 10000);
    scene.add(group, new HemisphereLight(0xffffff, 0x596577, 2.8));
    const light = new DirectionalLight(0xffffff, 3);
    light.position.set(4, 8, 6);
    scene.add(light);
    const geometries: BufferGeometry[] = [];
    materials.current = [];
    for (const item of doc.meshes) {
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute(item.positions, 3));
      if (item.indices) geometry.setIndex(Array.from(item.indices));
      geometry.computeVertexNormals();
      const material = new MeshStandardMaterial({
        color:
          item.color?.length === 3
            ? new Color(...(item.color as [number, number, number]))
            : new Color(0x8cabbc),
        roughness: 0.58,
        metalness: 0.12,
      });
      group.add(new Mesh(geometry, material));
      geometries.push(geometry);
      materials.current.push(material);
    }
    const box = new Box3().setFromObject(group),
      size = box.getSize(new Vector3()),
      center = box.getCenter(new Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(extent) || extent <= 0) {
      renderer.dispose();
      setError("В файле нет поверхности для просмотра.");
      return;
    }
    setDimensions(size.toArray());
    group.position.sub(center);
    group.scale.setScalar(1 / extent);
    group.position.divideScalar(extent);
    element.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.minDistance = 0.15;
    controls.maxDistance = 25;
    const render = () => renderer.render(scene, camera);
    let userMoved = false;
    const fit = () => {
      const radius = size.length() / extent / 2;
      const angle = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * Math.min(1, camera.aspect));
      camera.position
        .set(1.4, 1.1, 1.6)
        .normalize()
        .multiplyScalar((radius / Math.sin(angle)) * 1.08);
      controls.target.set(0, 0, 0);
      controls.update();
      userMoved = false;
      render();
    };
    tools.current = {
      fit,
      zoom: (factor) => {
        camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target);
        controls.update();
        render();
      },
      view: (axis) => {
        camera.position.set(axis === "X" ? 2.5 : 0, axis === "Y" ? 2.5 : 0, axis === "Z" ? 2.5 : 0);
        controls.target.set(0, 0, 0);
        controls.update();
        render();
      },
    };
    controls.addEventListener("change", render);
    controls.addEventListener("start", () => {
      userMoved = true;
    });
    let first = true;
    const resize = new ResizeObserver(() => {
      const w = Math.max(1, element.clientWidth),
        h = Math.max(1, element.clientHeight);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (first || !userMoved) {
        fit();
        first = false;
      } else render();
    });
    resize.observe(element);
    const lost = (event: Event) => {
      event.preventDefault();
      setError("Графический контекст потерян. Открой файл заново.");
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    return () => {
      tools.current = null;
      resize.disconnect();
      controls.dispose();
      geometries.forEach((g) => {
        g.dispose();
      });
      materials.current.forEach((m) => {
        m.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [doc]);
  useEffect(() => {
    for (const material of materials.current) material.wireframe = wire;
    tools.current?.zoom(1);
  }, [wire]);
  return (
    <div className="technical-model">
      <fieldset className="file-view-tools" aria-label="Вид модели">
        <button
          type="button"
          className="icon-button"
          aria-label="Вписать модель"
          title="Вписать"
          onClick={() => tools.current?.fit()}
        >
          <Icon name="expand" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Уменьшить"
          onClick={() => tools.current?.zoom(1.25)}
        >
          <Icon name="minus" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Увеличить"
          onClick={() => tools.current?.zoom(0.8)}
        >
          <Icon name="plus" />
        </button>
        <select
          aria-label="Проекция"
          defaultValue="free"
          onChange={(e) =>
            e.target.value === "free" ? tools.current?.fit() : tools.current?.view(e.target.value)
          }
        >
          <option value="free">Общий вид</option>
          <option value="X">Справа · X</option>
          <option value="Y">Сверху · Y</option>
          <option value="Z">Спереди · Z</option>
        </select>
        <button
          type="button"
          className="secondary"
          aria-pressed={wire}
          onClick={() => setWire(!wire)}
        >
          Сетка
        </button>
      </fieldset>
      {error ? (
        <p role="status">{error}</p>
      ) : !doc ? (
        <p role="status">
          <span className="spinner" /> Строю модель…
        </p>
      ) : null}
      <div ref={host} className="technical-canvas" role="img" aria-label="3D-модель" />
      {doc && (
        <div className="technical-status">
          <span>
            X {dimensions[0]?.toFixed(2)} · Y {dimensions[1]?.toFixed(2)} · Z{" "}
            {dimensions[2]?.toFixed(2)} {doc.unitSource === "unknown" ? unit : doc.unit}
          </span>
          {doc.unitSource === "unknown" && (
            <label>
              Единицы не заданы · считать{" "}
              <select
                aria-label="Интерпретация единиц"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
              >
                <option>mm</option>
                <option>cm</option>
                <option>m</option>
                <option>in</option>
              </select>
            </label>
          )}
          <span>{doc.triangles.toLocaleString("ru")} треугольников</span>
        </div>
      )}
    </div>
  );
}

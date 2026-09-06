export interface RemoteMouseState {
  x: number;
  y: number;
  left: boolean;
  middle: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}
export type RemoteInputMode = "trackpad" | "touch";
type Point = { x: number; y: number };
interface Contact extends Point {
  startX: number;
  startY: number;
  at: number;
  travel: number;
  drag: boolean;
  kind: string;
  suppressed: boolean;
}
interface Group {
  x: number;
  y: number;
  distance: number;
  initialDistance: number;
  startX: number;
  startY: number;
  at: number;
  moved: boolean;
  kind: "pending" | "zoom" | "scroll" | "pan";
  scroll: number;
  consumed: boolean;
}
export interface RemoteInputAdapter {
  mode: () => RemoteInputMode;
  scale: () => number;
  sensitivity: () => number;
  direct: (x: number, y: number) => Point;
  clamp: (x: number, y: number) => Point;
  send: (state: RemoteMouseState) => void;
  pointer: (kind: "mouse" | "trackpad" | "direct") => void;
  position: (point: Point) => void;
  zoom: (ratio: number, previous: Point, current: Point) => void;
  pan: (dx: number, dy: number) => void;
}
export class RemoteInput {
  private contacts = new Map<number, Contact>();
  private group?: Group;
  private abort = new AbortController();
  private hold?: ReturnType<typeof setTimeout>;
  private lastTap = { at: 0, x: 0, y: 0 };
  private state: RemoteMouseState = {
    x: 0,
    y: 0,
    left: false,
    middle: false,
    right: false,
    up: false,
    down: false,
  };
  constructor(
    private host: HTMLElement,
    private adapter: RemoteInputAdapter,
  ) {
    const options = { signal: this.abort.signal, passive: false };
    host.addEventListener("pointerdown", this.down, options);
    host.addEventListener("pointermove", this.move, options);
    host.addEventListener("pointerup", this.up, options);
    host.addEventListener("pointercancel", this.cancel, options);
    host.addEventListener("lostpointercapture", this.lost, options);
    host.addEventListener("contextmenu", (event) => event.preventDefault(), options);
    host.addEventListener("wheel", this.wheel, options);
  }
  setPosition(x: number, y: number) {
    const point = this.adapter.clamp(x, y);
    this.state.x = point.x;
    this.state.y = point.y;
    this.adapter.position(point);
  }
  private send() {
    this.adapter.send({ ...this.state });
  }
  private click(button: "left" | "right") {
    this.state[button] = true;
    this.send();
    this.state[button] = false;
    this.send();
  }
  private absolute(x: number, y: number) {
    const point = this.adapter.direct(x, y);
    this.setPosition(point.x, point.y);
  }
  private stopHold() {
    if (this.hold) clearTimeout(this.hold);
    this.hold = undefined;
  }
  private pair() {
    const [a, b] = [...this.contacts.values()];
    return a && b
      ? {
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        }
      : undefined;
  }
  private down = (event: PointerEvent) => {
    event.preventDefault();
    // Ignore palm contacts while the stylus is controlling the desktop.
    if (event.pointerType === "touch" && [...this.contacts.values()].some((p) => p.kind === "pen"))
      return;
    if (event.pointerType === "pen" && this.contacts.size) this.reset();
    if (event.pointerType !== "touch") this.host.focus({ preventScroll: true });
    try {
      this.host.setPointerCapture(event.pointerId);
    } catch {
      /* Synthetic or cancelled pointer. */
    }
    const point: Contact = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      at: Date.now(),
      travel: 0,
      drag: false,
      kind: event.pointerType,
      suppressed: false,
    };
    this.contacts.set(event.pointerId, point);
    if (event.pointerType === "mouse" || event.pointerType === "pen") {
      this.adapter.pointer(event.pointerType === "mouse" ? "mouse" : "direct");
      this.absolute(point.x, point.y);
      if (event.button === 2) this.state.right = true;
      else if (event.button === 1) this.state.middle = true;
      else this.state.left = true;
      this.send();
      return;
    }
    this.adapter.pointer(this.adapter.mode() === "trackpad" ? "trackpad" : "direct");
    if (this.contacts.size === 2) {
      this.stopHold();
      this.state.left = false;
      this.send();
      const pair = this.pair();
      if (pair)
        this.group = {
          ...pair,
          initialDistance: pair.distance,
          startX: pair.x,
          startY: pair.y,
          at: Date.now(),
          moved: false,
          kind: "pending",
          scroll: 0,
          consumed: false,
        };
      return;
    }
    if (this.contacts.size !== 1) return;
    if (this.adapter.mode() === "trackpad") {
      const doubleTap =
        Date.now() - this.lastTap.at < 330 &&
        Math.hypot(point.x - this.lastTap.x, point.y - this.lastTap.y) < 40;
      if (doubleTap) {
        point.drag = true;
        this.state.left = true;
        this.send();
      } else
        this.hold = setTimeout(() => {
          if (
            this.contacts.get(event.pointerId) === point &&
            this.contacts.size === 1 &&
            point.travel < 7
          ) {
            point.drag = true;
            this.state.left = true;
            this.send();
          }
        }, 450);
    }
  };
  private move = (event: PointerEvent) => {
    const point = this.contacts.get(event.pointerId);
    if (!point) {
      if (event.pointerType === "mouse") {
        this.adapter.pointer("mouse");
        this.absolute(event.clientX, event.clientY);
        this.send();
      }
      return;
    }
    event.preventDefault();
    const dx = event.clientX - point.x,
      dy = event.clientY - point.y;
    point.x = event.clientX;
    point.y = event.clientY;
    point.travel = Math.max(
      point.travel,
      Math.hypot(point.x - point.startX, point.y - point.startY),
    );
    if (point.kind === "mouse" || point.kind === "pen") {
      this.absolute(point.x, point.y);
      this.send();
      return;
    }
    if (this.contacts.size >= 2 && this.group) {
      const pair = this.pair(),
        group = this.group;
      if (!pair) return;
      const dx = pair.x - group.x,
        dy = pair.y - group.y;
      if (Math.abs(pair.distance / group.initialDistance - 1) > 0.08) group.kind = "zoom";
      if (group.kind === "pending" && Math.hypot(pair.x - group.startX, pair.y - group.startY) > 3)
        group.kind = this.adapter.mode() === "trackpad" ? "scroll" : "pan";
      if (group.kind === "zoom")
        this.adapter.zoom(pair.distance / group.distance, { x: group.x, y: group.y }, pair);
      else if (group.kind === "pan") this.adapter.pan(dx, dy);
      else if (group.kind === "scroll") {
        group.scroll += dy;
        const steps = Math.min(8, Math.floor(Math.abs(group.scroll) / 24));
        if (steps) {
          this.scroll(group.scroll < 0 ? 1 : -1, steps);
          group.scroll %= 24;
        }
      }
      if (point.travel > 7 || Math.abs(pair.distance / group.initialDistance - 1) > 0.06)
        group.moved = true;
      group.x = pair.x;
      group.y = pair.y;
      group.distance = pair.distance;
      return;
    }
    if (point.suppressed || this.contacts.size !== 1) return;
    if (point.travel > 7) this.stopHold();
    if (this.adapter.mode() === "trackpad") {
      const gain = this.adapter.sensitivity() / Math.max(0.05, this.adapter.scale());
      this.setPosition(this.state.x + dx * gain, this.state.y + dy * gain);
      this.send();
    } else {
      if (!point.drag && point.travel > 6) {
        this.absolute(point.startX, point.startY);
        this.state.left = true;
        this.send();
        point.drag = true;
      }
      if (point.drag) {
        this.absolute(point.x, point.y);
        this.send();
      }
    }
  };
  private up = (event: PointerEvent) => {
    const point = this.contacts.get(event.pointerId);
    if (!point) return;
    event.preventDefault();
    this.stopHold();
    if (point.kind === "mouse" || point.kind === "pen") {
      if (event.button === 2) this.state.right = false;
      else if (event.button === 1) this.state.middle = false;
      else this.state.left = false;
      this.send();
    } else if (this.group) {
      if (!this.group.consumed && !this.group.moved && Date.now() - this.group.at < 400) {
        if (this.adapter.mode() === "touch") this.absolute(this.group.x, this.group.y);
        this.click("right");
      }
      this.group.consumed = true;
      for (const contact of this.contacts.values()) contact.suppressed = true;
      this.state.left = false;
      this.send();
    } else if (point.drag) {
      this.state.left = false;
      this.send();
    } else if (!point.suppressed && point.travel < 9 && Date.now() - point.at < 450) {
      if (this.adapter.mode() === "touch") this.absolute(point.x, point.y);
      this.click("left");
      this.lastTap = { at: Date.now(), x: point.x, y: point.y };
    }
    this.contacts.delete(event.pointerId);
    if (!this.contacts.size) this.group = undefined;
    try {
      this.host.releasePointerCapture(event.pointerId);
    } catch {
      /* Already released. */
    }
  };
  private cancel = (event: PointerEvent) => {
    if (this.contacts.has(event.pointerId)) {
      event.preventDefault();
      this.reset();
    }
  };
  private lost = (event: PointerEvent) => {
    if (this.contacts.has(event.pointerId)) this.reset();
  };
  private scroll(direction: number, steps = 1) {
    for (let n = 0; n < steps; n++) {
      this.state.up = direction < 0;
      this.state.down = direction > 0;
      this.send();
      this.state.up = false;
      this.state.down = false;
      this.send();
    }
  }
  private wheel = (event: WheelEvent) => {
    event.preventDefault();
    if (event.ctrlKey) {
      this.adapter.zoom(
        Math.exp(-event.deltaY / 300),
        { x: event.clientX, y: event.clientY },
        { x: event.clientX, y: event.clientY },
      );
      return;
    }
    this.absolute(event.clientX, event.clientY);
    this.scroll(
      Math.sign(event.deltaY),
      Math.max(1, Math.min(8, Math.ceil(Math.abs(event.deltaY) / 40))),
    );
  };
  reset() {
    this.stopHold();
    this.contacts.clear();
    this.lastTap.at = 0;
    this.group = undefined;
    this.state.left = false;
    this.state.middle = false;
    this.state.right = false;
    this.state.up = false;
    this.state.down = false;
    this.send();
  }
  dispose() {
    this.reset();
    this.abort.abort();
  }
}

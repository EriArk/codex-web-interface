import { type NativeActivity, readNativeActivity } from "@codex-web/machines";
import type { HubConfig, HubEvent, MachineConfig } from "@codex-web/shared";
import type { Catalog } from "./catalog.js";
import type { Store } from "./store.js";

export class ExternalActivity {
  readonly errors = new Map<string, string>();
  private pending?: Promise<void>;
  private watchers = 0;
  private timer: NodeJS.Timeout;
  private stopped = false;
  constructor(
    private config: HubConfig,
    private store: Store,
    private catalog: Catalog,
    private home: (machineId: string) => Promise<string>,
    private owned: (id: string) => Promise<boolean>,
    private emit: (e: HubEvent) => void,
    private reader: (
      m: MachineConfig,
      home: string,
      ids: string[],
    ) => Promise<NativeActivity[]> = readNativeActivity,
  ) {
    this.timer = setInterval(() => {
      if (this.watchers) void this.refresh();
    }, 4000);
    this.timer.unref();
  }
  watch(): () => void {
    this.watchers++;
    void this.refresh();
    return () => {
      this.watchers--;
    };
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pending;
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.poll().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async poll() {
    for (const machine of this.config.machines.filter((m) => m.codex.activityNode)) {
      const projects = this.catalog.projects().filter((p) => p.machineId === machine.id);
      if (!projects.length) continue;
      try {
        await this.catalog.syncThreads(machine.id);
        const ids = this.store.db
          .prepare("SELECT id,codexThreadId,projectId FROM threads WHERE archived=0")
          .all()
          .filter((t) => projects.some((p) => p.id === t.projectId))
          .slice(0, 3000);
        const rows = await this.reader(
          machine,
          await this.home(machine.id),
          ids.map((t) => String(t.codexThreadId)),
        );
        this.errors.delete(machine.id);
        for (const row of rows) {
          const thread = this.store.threadByCodex(row.threadId);
          if (!thread || (await this.owned(thread.id))) continue;
          this.apply(thread.id, row);
        }
      } catch {
        this.errors.set(machine.id, `${machine.name}: внешняя активность пока недоступна`);
        for (const project of projects)
          for (const t of this.store.threads(project.id))
            if (
              t.activitySource === "external" &&
              ["starting", "running", "waiting_approval"].includes(t.status) &&
              !(await this.owned(t.id))
            ) {
              this.store.setStatus(t.id, "unknown", t.activeTurnId);
              this.emit(
                this.store.append(t.id, "session.state", {
                  status: "unknown",
                  activitySource: "external",
                  activeTurnId: t.activeTurnId,
                }),
              );
            }
      }
    }
    this.store.changes.emit("navigation");
  }
  apply(id: string, row: NativeActivity) {
    const old = this.store.thread(id);
    const active = row.status === "inProgress";
    // A stale unfinished disk record is not proof of a currently running process.
    const status = active
      ? Date.now() / 1000 - Math.max(row.updatedAt, row.startedAt) < 600
        ? "running"
        : "unknown"
      : row.status;
    const terminal = !active && ["completed", "interrupted", "failed"].includes(status);
    const changed = old.nativeObservedTurn !== row.turnId || old.nativeObservedStatus !== status;
    const versionChanged = (old.nativeObservedAt ?? 0) !== row.updatedAt;
    this.store.db
      .prepare(
        "UPDATE threads SET activitySource='external',nativeObservedTurn=?,nativeObservedStatus=?,nativeObservedAt=?,sourceUpdatedAt=? WHERE id=?",
      )
      .run(row.turnId, status, row.updatedAt, row.updatedAt, id);
    if (changed || old.status !== status || old.activitySource !== "external") {
      this.store.setStatus(
        id,
        status,
        active ? row.turnId : null,
        new Date(Math.max(row.updatedAt, row.startedAt) * 1000).toISOString(),
      );
      if (active && row.startedAt)
        this.store.db
          .prepare("UPDATE threads SET activityAt=? WHERE id=?")
          .run(new Date(row.startedAt * 1000).toISOString(), id);
      this.emit(
        this.store.append(id, "session.state", {
          status,
          activeTurnId: active ? row.turnId : null,
          activitySource: "external",
        }),
      );
      if (terminal && old.nativeObservedTurn && changed)
        this.emit(
          this.store.append(
            id,
            "turn.completed",
            { id: row.turnId, status, source: "external" },
            row.turnId,
          ),
        );
    }
    if (changed || versionChanged) {
      this.catalog.invalidate(id);
      this.emit(this.store.append(id, "source.changed", { version: row.updatedAt }));
    }
  }
}

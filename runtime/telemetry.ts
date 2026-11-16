import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppState, Project, WorkItem } from "../src/shared";
import { appVersion } from "../src/version";
import type { BoundEvidence } from "./qualification";
import { modelFamily, publicModelId } from "../src/public-models";
import type { WorkerCheckResult } from "../src/measurements";
import {
  telemetryBatchSchema,
  telemetryEventSchema,
  telemetryModels,
  type TelemetryEvent,
  type TelemetryStatus,
} from "../src/telemetry";

const ENDPOINT = "https://www.memtrace.io/api/memcode/telemetry";
const RETENTION = 30 * 86400000;
const MAX_PENDING = 1000,
  MAX_BYTES = 512000;
type Started = Extract<TelemetryEvent, { type: "attempt.started" }>;
type Finished = Extract<TelemetryEvent, { type: "attempt.finished" }>;
export interface TelemetryAuthorization {
  token: string;
  accountId: string;
  expiresAt: number;
}
export interface WorkerTelemetry {
  prepare?(
    task: WorkItem,
    project: Project,
    pass: "initial" | "followup",
  ): (() => string | undefined) | undefined;
  started(
    task: WorkItem,
    project: Project,
    pass: "initial" | "followup",
  ): string | undefined;
  finished(handle: string | undefined, task: WorkItem): void;
}
interface Attempt {
  event: Started;
  localKey: string;
  runRef?: string;
  revision?: string;
  finish?: Finished;
}
interface DiskState {
  version: 1;
  enabled: boolean;
  accountHash: string | null;
  workspaceRef: string;
  refs: Record<string, string>;
  lineage: Record<string, boolean>;
  queue: TelemetryEvent[];
  active: Record<string, Attempt>;
  last: Record<string, Attempt>;
  sent: number;
  lastUploadedAt: string | null;
}
export interface TelemetryOptions {
  authorization(): Promise<TelemetryAuthorization | null>;
  eligible(): boolean;
  clearAuthorization?(): void;
  fetch?: typeof fetch;
  now?: () => number;
  background?: boolean;
  channel?: "production" | "test";
  excluded?: boolean;
}
type PlanningRow = {
  kind: "project" | "story" | "epic" | "cycle";
  id: string;
  projectId: string;
  state?: string;
  runRef?: string;
  revision?: string;
};
export interface PlanningObservation {
  workspaceRef: string;
  rows: Map<string, PlanningRow>;
  counts: Extract<TelemetryEvent, { type: "planning.snapshot" }>["counts"];
}
const mutations = new Set([
  "project:create",
  "task:create",
  "task:update",
  "task:bulk-update",
  "story:delete",
  "epic:create",
  "epic:update",
  "epic:delete",
  "cycle:create",
  "cycle:update",
  "cycle:start",
  "cycle:complete",
  "cycle:delete",
]);
const numeric = (value: unknown, maximum = 10000000): number | null =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= maximum
    ? value
    : null;
const key = (kind: string, id: string) =>
  createHash("sha256")
    .update(kind + ":" + id)
    .digest("hex");
/** Only explicit local mutation targets may create lifecycle events. Concurrent Team pulls cannot. */
export function telemetryMutationTargets(
  method: string,
  input: unknown,
  result: unknown,
): Set<string> {
  const body = input as { id?: unknown; ids?: unknown },
    reply = result as { id?: unknown };
  const values = method.endsWith(":create")
    ? [reply?.id]
    : Array.isArray(body?.ids)
      ? body.ids
      : [body?.id];
  return new Set(
    values.filter(
      (id): id is string =>
        typeof id === "string" && id.length > 0 && id.length <= 200,
    ),
  );
}

/** Local stage patches mutate synchronously, before persistence can interleave a Team pull or another UI action. */
export async function observeTelemetryMutation(
  telemetry: ProductTelemetry,
  method: string,
  input: unknown,
  handle: (input: any) => unknown,
) {
  let before: PlanningObservation | undefined,
    immediateAfter: PlanningObservation | undefined;
  try {
    if (telemetry.tracks(method, input)) before = telemetry.planning();
  } catch {
    /* Optional accounting cannot block the user's action. */
  }
  const pending = handle(input);
  const stageMutation =
    method === "task:update" || method === "task:bulk-update";
  if (before && stageMutation)
    try {
      immediateAfter = telemetry.planning();
    } catch {
      /* Omit an unverifiable transition. */
    }
  const result = await pending;
  if (before && (!stageMutation || immediateAfter))
    try {
      telemetry.observeLocal(
        method,
        before,
        telemetryMutationTargets(method, input, result),
        immediateAfter,
      );
    } catch {
      /* Optional accounting cannot alter its outcome. */
    }
  return result;
}

/** Host-only, opt-in counters. The wire schema cannot represent source or user text. */
export class ProductTelemetry implements WorkerTelemetry {
  private disk: DiskState = this.empty(false);
  private tail = Promise.resolve();
  private flushing?: Promise<void>;
  private controller?: AbortController;
  private generation = 0;
  private closed = false;
  private unavailable = false;
  private retryAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingBytes = 0;
  private readonly clock: () => number;
  private readonly file: string;
  private readonly disabledFile: string;
  constructor(
    private readonly directory: string,
    private readonly state: () => AppState,
    private readonly options: TelemetryOptions,
  ) {
    this.clock = options.now ?? Date.now;
    this.file = join(directory, "telemetry", "queue.private.json");
    this.disabledFile = join(directory, "telemetry", "disabled");
  }
  private empty(enabled: boolean): DiskState {
    return {
      version: 1,
      enabled,
      accountHash: null,
      workspaceRef: randomUUID(),
      refs: {},
      lineage: {},
      queue: [],
      active: {},
      last: {},
      sent: 0,
      lastUploadedAt: null,
    };
  }
  async initialize() {
    try {
      const raw = await readFile(this.file, "utf8");
      if (Buffer.byteLength(raw) > 4_000_000)
        throw Error("Oversized telemetry state");
      const disk = JSON.parse(raw) as DiskState;
      if (
        disk.version !== 1 ||
        typeof disk.enabled !== "boolean" ||
        !/^[0-9a-f-]{36}$/.test(disk.workspaceRef) ||
        !Array.isArray(disk.queue)
      )
        throw Error("Invalid telemetry state");
      const uuid = (v: unknown): v is string =>
        typeof v === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          v,
        );
      const refs = Object.fromEntries(
        Object.entries(disk.refs ?? {})
          .filter(([k, v]) => /^[0-9a-f]{64}$/.test(k) && uuid(v))
          .slice(-10000),
      );
      const last = Object.fromEntries(
        Object.entries(disk.last ?? {})
          .filter(
            ([k, v]) =>
              /^[0-9a-f]{64}$/.test(k) &&
              v?.event?.type === "attempt.started" &&
              telemetryEventSchema.safeParse(v.event).success &&
              v.localKey === k,
          )
          .slice(-300),
      );
      this.disk = {
        ...this.empty(disk.enabled),
        enabled: disk.enabled,
        accountHash:
          typeof disk.accountHash === "string" &&
          /^[0-9a-f]{64}$/.test(disk.accountHash)
            ? disk.accountHash
            : null,
        workspaceRef: uuid(disk.workspaceRef)
          ? disk.workspaceRef
          : randomUUID(),
        refs,
        queue: disk.queue.filter(
          (event) => telemetryEventSchema.safeParse(event).success,
        ),
        active: {},
        last,
        lineage: Object.fromEntries(
          Object.entries(disk.lineage ?? {})
            .filter(([k, v]) => /^[0-9a-f]{64}$/.test(k) && v === true)
            .slice(-10000),
        ),
        sent: numeric(disk.sent, 1e9) ?? 0,
        lastUploadedAt:
          typeof disk.lastUploadedAt === "string" &&
          Number.isFinite(Date.parse(disk.lastUploadedAt))
            ? disk.lastUploadedAt
            : null,
      };
      let disabled = false;
      try {
        await readFile(this.disabledFile);
        disabled = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") disabled = true;
      }
      if (
        disabled ||
        this.options.excluded ||
        !disk.enabled ||
        !this.disk.accountHash
      )
        this.disk = this.empty(false);
      this.trim();
    } catch {
      this.disk = this.empty(false);
    }
    if (this.options.background !== false) {
      this.timer = setInterval(() => void this.flush(), 30000);
      this.timer.unref();
    }
  }
  requested() {
    return this.disk.enabled && !this.options.excluded && !this.closed;
  }
  enabled() {
    return this.requested() && !!this.disk.accountHash;
  }
  status(): TelemetryStatus {
    const enabled = this.enabled(),
      eligible = this.options.eligible();
    return {
      enabled,
      eligible,
      excluded: !!this.options.excluded,
      pending: this.disk.queue.length,
      sent: this.disk.sent,
      lastUploadedAt: this.disk.lastUploadedAt,
      state: this.options.excluded
        ? "excluded"
        : !enabled
          ? "off"
          : !eligible
            ? "waiting-for-account"
            : this.flushing
              ? "sending"
              : this.unavailable
                ? "unavailable"
                : this.disk.queue.length
                  ? "queued"
                  : "idle",
    };
  }
  private persist(): Promise<void> {
    const save = this.tail
      .catch(() => {})
      .then(async () => {
        await mkdir(join(this.directory, "telemetry"), {
          recursive: true,
          mode: 0o700,
        });
        const temporary = this.file + "." + randomUUID() + ".tmp";
        await writeFile(temporary, JSON.stringify(this.disk), { mode: 0o600 });
        await rename(temporary, this.file);
      });
    this.tail = save;
    return save;
  }
  private trim() {
    this.disk.queue = this.disk.queue
      .filter(
        (e) =>
          Date.parse(e.occurredAt) >= this.clock() - RETENTION &&
          Date.parse(e.occurredAt) <= this.clock() + 300000,
      )
      .slice(-MAX_PENDING);
    this.pendingBytes = this.disk.queue.reduce(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
      0,
    );
    while (this.pendingBytes > MAX_BYTES) {
      const removed = this.disk.queue.shift();
      if (!removed) break;
      this.pendingBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
  }
  private ref(kind: string, id: string) {
    const hash = key(kind, id);
    if (!this.disk.refs[hash]) {
      if (Object.keys(this.disk.refs).length >= 10000)
        delete this.disk.refs[Object.keys(this.disk.refs)[0]];
      this.disk.refs[hash] = randomUUID();
    }
    return this.disk.refs[hash];
  }
  private common(projectId?: string) {
    return {
      appVersion,
      eventId: randomUUID(),
      occurredAt: new Date(this.clock()).toISOString(),
      workspaceRef: this.disk.workspaceRef,
      projectRef: projectId ? this.ref("project", projectId) : null,
    };
  }
  private record(event: TelemetryEvent) {
    if (!this.enabled()) return;
    const parsed = telemetryEventSchema.safeParse(event);
    if (!parsed.success) return;
    this.disk.queue.push(parsed.data);
    this.pendingBytes += Buffer.byteLength(JSON.stringify(parsed.data));
    while (
      this.disk.queue.length > MAX_PENDING ||
      this.pendingBytes > MAX_BYTES
    ) {
      const removed = this.disk.queue.shift();
      if (!removed) break;
      this.pendingBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
    if (!this.saveTimer)
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        void this.persist().catch(() => {
          this.unavailable = true;
        });
      }, 25);
    this.saveTimer?.unref();
  }
  async setEnabled(enabled: boolean): Promise<TelemetryStatus> {
    if (enabled && this.options.excluded)
      throw Error("Usage sharing is excluded in this demo or QA profile.");
    if (enabled && this.enabled()) return this.status();
    const generation = ++this.generation;
    this.controller?.abort();
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.pendingBytes = 0;
    this.disk = this.empty(enabled);
    this.unavailable = false;
    this.retryAt = 0;
    if (enabled) {
      try {
        if (!this.options.eligible())
          throw Error(
            "Connect MemCode beta before enabling usage sharing for this account.",
          );
        const authorization = await this.options.authorization();
        if (!authorization || authorization.expiresAt <= this.clock())
          throw Error(
            "Usage sharing is not available for this beta session yet. Local work is unaffected.",
          );
        if (generation !== this.generation || this.closed)
          throw Error("The account changed while enabling usage sharing.");
        this.disk.accountHash = key("account", authorization.accountId);
      } catch (error) {
        if (generation === this.generation) {
          this.disk = this.empty(false);
          this.options.clearAuthorization?.();
          await this.persist();
        }
        throw error;
      }
      this.record({
        ...this.common(),
        type: "planning.snapshot",
        scope: "local_workspace",
        counts: this.planning().counts,
      });
    } else {
      this.options.clearAuthorization?.();
      await this.markDisabled();
    }
    await this.persist();
    if (enabled && generation === this.generation)
      await rm(this.disabledFile, { force: true });
    return this.status();
  }
  private async markDisabled() {
    await mkdir(join(this.directory, "telemetry"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(this.disabledFile, "1", { mode: 0o600 });
  }
  /** Never upload queued observations under a subsequently selected account. */
  async accountChanged() {
    ++this.generation;
    this.controller?.abort();
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.pendingBytes = 0;
    this.options.clearAuthorization?.();
    this.disk = this.empty(false);
    await this.markDisabled();
    await this.persist();
  }
  started(task: WorkItem, project: Project, pass: "initial" | "followup") {
    return this.prepare(task, project, pass)?.();
  }
  prepare(task: WorkItem, project: Project, pass: "initial" | "followup") {
    if (!this.enabled() || task.example || project.example) return undefined;
    const route = task.route;
    if (!route) return undefined;
    const inputs = route.inputs,
      evidence = task.evidence as BoundEvidence | undefined;
    const binding = evidence?.binding;
    const alignment: Started["evidence"]["alignment"] =
      binding?.index === "stale" ||
      (binding?.branch && task.run.branch && binding.branch !== task.run.branch)
        ? "not_aligned"
        : binding?.index === "current" &&
            !!binding.branch &&
            binding.branch === task.run.branch
          ? "aligned"
          : "unknown";
    const model = route?.model;
    const event: Started = {
      ...this.common(project.id),
      type: "attempt.started",
      attemptRef: randomUUID(),
      storyRef: this.ref("story", task.id),
      pass,
      historyComplete: this.disk.lineage[key("story", task.id)] === true,
      harness: task.harness,
      requestedModel: telemetryModels.includes(model as any)
        ? (model as Started["requestedModel"])
        : "other",
      requestedEffort: route.effort,
      routeMode: route?.mode === "automatic" ? "auto" : "manual",
      policy:
        route?.policyVersion === "memcode-envelope-v2"
          ? "memcode-envelope-v2"
          : "unknown",
      tier: route?.tier ?? null,
      evidence: {
        state:
          evidence?.state === "measured"
            ? "measured"
            : evidence?.state === "partial"
              ? "partial"
              : "unknown",
        cognitive: numeric(inputs?.cognitive),
        cyclomatic: numeric(inputs?.cyclomatic),
        nesting: numeric(inputs?.nesting, 10000),
        affectedSymbols: numeric(inputs?.affected),
        affectedProcesses: numeric(inputs?.processes),
        affectedFiles: numeric(evidence?.affectedFiles),
        symbolCount: evidence ? numeric(evidence.symbols.length) : null,
        declaredScopeCount: task.scope ? numeric(task.scope.length) : null,
        moduleRoots: numeric(inputs?.moduleRoots),
        impactLowerBound: evidence
          ? evidence.incomplete || evidence.state !== "measured"
          : null,
        alignment,
      },
    };
    const handle = event.attemptRef;
    const attempt: Attempt = {
        event,
        localKey: key("story", task.id),
        runRef: task.run.changeRunId,
      },
      generation = this.generation;
    return () => {
      if (!this.enabled() || generation !== this.generation) return undefined;
      this.disk.active[handle] = attempt;
      this.record(event);
      return handle;
    };
  }
  finished(handle: string | undefined, task: WorkItem) {
    if (!handle || !this.enabled()) return;
    const attempt = this.disk.active[handle];
    if (!attempt) return;
    delete this.disk.active[handle];
    attempt.revision = task.changesRevision;
    this.disk.last[attempt.localKey] = attempt;
    while (Object.keys(this.disk.last).length > 300)
      delete this.disk.last[Object.keys(this.disk.last)[0]];
    const outcome: Finished["processOutcome"] =
      task.run.state === "finished"
        ? "exited"
        : task.run.state === "stopped"
          ? "stopped"
          : task.run.state === "blocked"
            ? "blocked"
            : "failed";
    const finished: Finished = {
      ...this.common(),
      projectRef: attempt.event.projectRef,
      type: "attempt.finished",
      attemptRef: handle,
      storyRef: attempt.event.storyRef,
      processOutcome: outcome,
      durationMs: numeric(
        this.clock() - Date.parse(attempt.event.occurredAt),
        604800000,
      ),
      exitCode:
        typeof task.run.exitCode === "number" &&
        Number.isInteger(task.run.exitCode) &&
        task.run.exitCode >= -2147483648 &&
        task.run.exitCode <= 2147483647
          ? task.run.exitCode
          : null,
      reportedHarness: task.run.measurements?.modelSource
        ? attempt.event.harness
        : null,
      reportedModel: task.run.measurements?.modelId
        ? (modelFamily(
            task.run.measurements.modelId,
          ) as Finished["reportedModel"])
        : null,
      reportedModelId: publicModelId(task.run.measurements?.modelId),
      reportedModelIds: [
        ...new Set(
          task.run.measurements?.modelIds
            .map(publicModelId)
            .filter((id): id is NonNullable<typeof id> => id !== null) ?? [],
        ),
      ],
      reportedModels: [
        ...new Set(task.run.measurements?.modelIds.map(modelFamily) ?? []),
      ] as NonNullable<Finished["reportedModels"]>,
      reportedModelSource: task.run.measurements?.modelSource ?? null,
      reportedEffort: task.run.measurements?.effort ?? null,
      usage: task.run.measurements?.usage ?? null,
      verification: null,
    };
    attempt.finish = finished;
    this.record(finished);
  }
  /** A later controlled check is an immutable enrichment, not another coding attempt. */
  verified(task: WorkItem, result: WorkerCheckResult): boolean {
    if (!this.enabled() || !result.linked) return false;
    const attempt = this.disk.last[key("story", task.id)];
    if (
      !attempt?.finish ||
      attempt.runRef !== result.runId ||
      attempt.runRef !== task.run.changeRunId ||
      attempt.revision !== result.revision ||
      task.changesRevision !== result.revision
    )
      return false;
    this.record({
      ...attempt.finish,
      eventId: randomUUID(),
      occurredAt: new Date(this.clock()).toISOString(),
      verification: {
        passed: result.passed,
        failed: result.failed,
        source: "memcode_check",
        exitCode: result.exitCode,
      },
    });
    return true;
  }
  tracks(method: string, input?: unknown) {
    if (!this.enabled() || !mutations.has(method)) return false;
    if (
      (method === "task:update" || method === "task:bulk-update") &&
      input !== undefined
    ) {
      const patch = (input as { patch?: Record<string, unknown> })?.patch;
      return (
        !!patch &&
        (Object.hasOwn(patch, "stage") ||
          Object.hasOwn(patch, "workflowStateId"))
      );
    }
    return true;
  }
  planning(): PlanningObservation {
    const state = this.state(),
      projects = state.projects.filter((p) => !p.example),
      ids = new Set(projects.map((p) => p.id));
    const tasks = state.tasks.filter((t) => !t.example && ids.has(t.projectId)),
      epics = state.epics.filter((e) => ids.has(e.projectId)),
      cycles = state.cycles.filter((c) => ids.has(c.projectId));
    const rows = new Map<string, PlanningRow>();
    for (const p of projects)
      rows.set(key("project", p.id), {
        kind: "project",
        id: p.id,
        projectId: p.id,
      });
    for (const t of tasks)
      rows.set(key("story", t.id), {
        kind: "story",
        id: t.id,
        projectId: t.projectId,
        state: t.stage,
        runRef: t.run.changeRunId,
        revision: t.changesRevision,
      });
    for (const e of epics)
      rows.set(key("epic", e.id), {
        kind: "epic",
        id: e.id,
        projectId: e.projectId,
      });
    for (const c of cycles)
      rows.set(key("cycle", c.id), {
        kind: "cycle",
        id: c.id,
        projectId: c.projectId,
        state: c.state,
      });
    return {
      workspaceRef: this.disk.workspaceRef,
      rows,
      counts: {
        projects: projects.length,
        stories: tasks.length,
        epics: epics.length,
        cycles: cycles.length,
        doneStories: tasks.filter((t) => t.stage === "done").length,
        activeCycles: cycles.filter((c) => c.state === "active").length,
      },
    };
  }
  observeLocal(
    method: string,
    before: PlanningObservation,
    targetIds: Set<string>,
    observedAfter?: PlanningObservation,
  ) {
    if (!this.tracks(method) || before.workspaceRef !== this.disk.workspaceRef)
      return;
    const after = observedAfter ?? this.planning();
    for (const [id, row] of after.rows) {
      if (!targetIds.has(row.id)) continue;
      const previous = before.rows.get(id);
      if (!previous) {
        if (row.kind === "story") {
          this.disk.lineage[key("story", row.id)] = true;
          while (Object.keys(this.disk.lineage).length > 10000)
            delete this.disk.lineage[Object.keys(this.disk.lineage)[0]];
        }
        this.record({
          ...this.common(row.projectId),
          type: "entity.lifecycle",
          entity: row.kind,
          entityRef: this.ref(row.kind, row.id),
          action: "created",
        });
      } else if (
        row.kind === "story" &&
        previous.state !== row.state &&
        (row.state === "done" || previous.state === "done")
      ) {
        const attempt = this.disk.last[key("story", row.id)];
        const exact =
          attempt &&
          !!row.revision &&
          row.revision === attempt.revision &&
          row.runRef === attempt.runRef;
        this.record({
          ...this.common(row.projectId),
          type: "story.review",
          storyRef: this.ref("story", row.id),
          attemptRef: exact ? attempt.event.attemptRef : null,
          decision: row.state === "done" ? "accepted" : "reopened",
        });
      } else if (
        row.kind === "cycle" &&
        previous.state !== row.state &&
        (row.state === "completed" || previous.state === "completed")
      )
        this.record({
          ...this.common(row.projectId),
          type: "entity.lifecycle",
          entity: "cycle",
          entityRef: this.ref("cycle", row.id),
          action: row.state === "completed" ? "completed" : "reopened",
        });
    }
    for (const [id, row] of before.rows)
      if (targetIds.has(row.id) && !after.rows.has(id))
        this.record({
          ...this.common(row.projectId),
          type: "entity.lifecycle",
          entity: row.kind,
          entityRef: this.ref(row.kind, row.id),
          action: "deleted",
        });
    if (JSON.stringify(before.counts) !== JSON.stringify(after.counts))
      this.record({
        ...this.common(),
        type: "planning.snapshot",
        scope: "local_workspace",
        counts: after.counts,
      });
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (
      !this.enabled() ||
      !this.disk.queue.length ||
      this.clock() < this.retryAt
    )
      return Promise.resolve();
    const generation = this.generation;
    this.flushing = (async () => {
      await Promise.resolve();
      try {
        this.trim();
        if (!this.disk.queue.length) return;
        const authorization = await this.options.authorization();
        if (
          !authorization ||
          authorization.expiresAt <= this.clock() ||
          generation !== this.generation ||
          !this.enabled()
        )
          return;
        if (key("account", authorization.accountId) !== this.disk.accountHash) {
          await this.accountChanged();
          return;
        }
        const events = this.disk.queue.slice(0, 50),
          batch = telemetryBatchSchema.parse({
            version: 1,
            channel: this.options.channel ?? "production",
            events,
          });
        while (
          Buffer.byteLength(JSON.stringify(batch)) > 60000 &&
          events.length > 1
        ) {
          events.pop();
          batch.events.pop();
        }
        const controller = new AbortController();
        this.controller = controller;
        const timeout = setTimeout(() => controller.abort(), 10000);
        let response: Response;
        try {
          response = await (this.options.fetch ?? fetch)(ENDPOINT, {
            method: "POST",
            redirect: "error",
            credentials: "omit",
            headers: {
              authorization: `Bearer ${authorization.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(batch),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
          if (this.controller === controller) this.controller = undefined;
        }
        if (generation !== this.generation || !this.enabled()) return;
        if (!response.ok) {
          this.unavailable = true;
          this.retryAt = this.clock() + 60000;
          return;
        }
        const accepted = new Set(events.map((e) => e.eventId));
        this.disk.queue = this.disk.queue.filter(
          (e) => !accepted.has(e.eventId),
        );
        this.trim();
        this.disk.sent += events.length;
        this.disk.lastUploadedAt = new Date(this.clock()).toISOString();
        this.unavailable = false;
        await this.persist();
      } catch {
        if (generation === this.generation) {
          this.unavailable = true;
          this.retryAt = this.clock() + 60000;
        }
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    clearInterval(this.timer);
    clearTimeout(this.saveTimer);
    await this.flushing;
    await this.persist().catch(() => {});
  }
}

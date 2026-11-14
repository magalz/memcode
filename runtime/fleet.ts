import { randomUUID } from "node:crypto";
import type { AppState, FleetConflict, Project, WorkItem } from "../src/shared";
import type { MemtraceEngine } from "./memtrace";
import { declaredIntent, touchedIdentities } from "./coordination";
import { isActive } from "../src/domain";
import { now } from "./local";

export class FleetBlocked extends Error {}
type Json = Record<string, any>;

export class FleetCoordinator {
  private leases = new Map<string, string>();
  private announced = new Set<string>();
  constructor(
    private state: () => AppState,
    private engine: MemtraceEngine,
    private changed: () => Promise<void>,
    private pause: (ids: string[]) => void,
  ) {}
  assertClear(task: WorkItem, project: Project): void {
    const open = this.state().fleetConflicts.find(
      (item) =>
        item.projectId === project.id &&
        item.branch === task.run.branch &&
        item.status === "open",
    );
    if (open)
      throw new FleetBlocked(
        "This epic has an unresolved Fleet decision. Open Decisions before resuming work.",
      );
    const decision = [...this.state().fleetConflicts]
      .reverse()
      .find(
        (item) =>
          item.projectId === project.id &&
          item.status === "resolved" &&
          item.taskIds.includes(task.id),
      );
    if (decision?.winnerTaskId && decision.winnerTaskId !== task.id)
      throw new FleetBlocked(
        "The human decision deferred this story. Revise that decision before resuming this worker.",
      );
  }
  async before(project: Project, task: WorkItem): Promise<void> {
    if (!project.repoId || project.analysis !== "ready")
      throw new Error(
        "Connect Memtrace before launching a shared-branch Fleet worker.",
      );
    this.assertClear(task, project);
    const peers = this.state().tasks.filter(
      (peer) =>
        peer.projectId === project.id && peer.id !== task.id && isActive(peer),
    );
    if (
      peers.length &&
      (!touchedIdentities(task, project).length ||
        peers.some((peer) => !touchedIdentities(peer, project).length))
    )
      await this.block(
        project,
        task,
        {
          summary:
            "A concurrent story has unknown source scope. Define its source scope before sharing this branch.",
          taskIds: peers.map((peer) => peer.id),
        },
        "runtime",
      );
    const context = await this.call(project, task, "fleet_branch_context", {});
    for (const pending of context.pending_escalations ?? [])
      await this.ingest(project, pending);
    this.assertClear(task, project);
    const touched = this.scope(task, project);
    const preflight = await this.call(project, task, "fleet_preflight", {
      touched,
      intent: declaredIntent(task),
    });
    await this.inspect(project, task, preflight, "preflight");
    const lease = await this.engine.call(project, "fleet_acquire_lease", {
      repo_id: project.repoId,
      agent_id: `memcode:${task.id}`,
      scope: touched,
      priority: 0,
      ttl_seconds: 120,
    });
    if (lease.lease_id) this.leases.set(task.id, lease.lease_id);
    if (lease.state !== "granted")
      await this.block(
        project,
        task,
        {
          summary:
            "Fleet has reserved part of this story’s scope for another worker. Review the overlap before continuing.",
        },
        "preflight",
      );
    const published = await this.publish(project, task);
    await this.inspect(project, task, published, "publish");
  }
  async heartbeat(project: Project, task: WorkItem): Promise<void> {
    this.assertClear(task, project);
    const lease = this.leases.get(task.id);
    if (!lease) throw new Error("The Fleet reservation is missing.");
    await this.engine.call(project, "fleet_renew_lease", {
      lease_id: lease,
      ttl_seconds: 120,
    });
    await this.inspect(
      project,
      task,
      await this.publish(project, task),
      "publish",
    );
    await this.refresh(project);
    this.assertClear(task, project);
  }
  async after(project: Project, task: WorkItem): Promise<void> {
    const result = await this.call(project, task, "fleet_record_episode", {
      intent: declaredIntent(task),
      touched: this.scope(task, project),
      metadata: {
        source: "memcode",
        task_id: task.id,
        epic_id: task.epicId,
        shared_branch: true,
        scope_basis: "declared_and_qualified",
        actual_diff_attribution: "shared_epic_diff_not_per_worker",
      },
    });
    await this.inspect(project, task, result, "episode");
  }
  async release(project: Project, task: WorkItem): Promise<void> {
    const lease = this.leases.get(task.id);
    this.leases.delete(task.id);
    if (lease)
      await this.engine.call(project, "fleet_release_lease", {
        lease_id: lease,
      });
    if (project.repoId && this.announced.delete(task.id))
      await this.call(project, task, "fleet_publish_intent", {
        touched: [],
        intent: "exploratory",
        assignment: "Worker stopped; no active write scope.",
      });
  }
  async refresh(project: Project): Promise<void> {
    if (!project.repoId || project.analysis !== "ready") return;
    const result = await this.engine.call(project, "fleet_list_escalations", {
      repo_id: project.repoId,
    });
    for (const entry of result.pending ?? []) await this.ingest(project, entry);
  }
  async failure(
    project: Project,
    task: WorkItem,
    summary: string,
  ): Promise<void> {
    try {
      await this.block(project, task, { summary }, "runtime");
    } catch (error) {
      if (!(error instanceof FleetBlocked)) throw error;
    }
  }
  async resolve(
    id: string,
    resolution: string,
    winnerTaskId?: string,
  ): Promise<void> {
    const item = this.state().fleetConflicts.find((item) => item.id === id);
    if (!item) throw new Error("Fleet decision not found.");
    if (winnerTaskId && !item.taskIds.includes(winnerTaskId))
      throw new Error("Choose one of the affected story workers.");
    if (
      item.taskIds.some((id) => {
        const task = this.state().tasks.find((task) => task.id === id);
        return task && isActive(task);
      })
    )
      throw new Error(
        "Wait for the affected workers to stop before recording the decision.",
      );
    const project = this.state().projects.find(
      (project) => project.id === item.projectId,
    )!;
    if (item.escalationId)
      await this.engine.call(project, "fleet_resolve_escalation", {
        escalation_id: item.escalationId,
        resolution,
        winner: winnerTaskId ? `memcode:${winnerTaskId}` : undefined,
      });
    Object.assign(item, {
      status: "resolved",
      resolution,
      winnerTaskId,
      resolvedAt: now(),
    });
    await this.changed();
  }
  private scope(task: WorkItem, project: Project): string[] {
    const scope = touchedIdentities(task, project);
    return scope.length ? scope : [`repo::${project.repoId}`];
  }
  private call(project: Project, task: WorkItem, name: string, extra: Json) {
    return this.engine.call(project, name, {
      repo_id: project.repoId,
      branch: task.run.branch ?? project.branch,
      agent_id: `memcode:${task.id}`,
      ...extra,
    });
  }
  private publish(project: Project, task: WorkItem) {
    this.announced.add(task.id);
    return this.call(project, task, "fleet_publish_intent", {
      intent: declaredIntent(task),
      touched: this.scope(task, project),
      assignment: `${task.identifier}: ${task.title}\n${task.description}`,
    });
  }
  private async inspect(
    project: Project,
    task: WorkItem,
    result: Json,
    source: FleetConflict["source"],
  ) {
    if (
      result.escalation_id ||
      result.conflict_class === "C" ||
      result.conflict_class === "B" ||
      result.has_conflicts ||
      result.active_conflicts?.length ||
      result.active_leases?.some(
        (lease: Json) => lease.agent_id !== `memcode:${task.id}`,
      )
    )
      await this.block(project, task, result, source);
  }
  private async block(
    project: Project,
    task: WorkItem,
    result: Json,
    source: FleetConflict["source"],
  ): Promise<never> {
    const agentIds = [
      ...new Set([
        `memcode:${task.id}`,
        ...(result.active_conflicts ?? result.conflicting_agents ?? [])
          .map((entry: any) =>
            typeof entry === "string"
              ? entry
              : (entry?.agent_id ?? entry?.intent?.agent_id),
          )
          .filter(Boolean),
      ]),
    ] as string[];
    const peers = this.state().tasks.filter(
      (other) =>
        other.projectId === project.id &&
        other.epicId === task.epicId &&
        isActive(other),
    );
    const taskIds = [
      ...new Set([
        task.id,
        ...(result.taskIds ?? []),
        ...peers.map((peer) => peer.id),
      ]),
    ];
    const id = result.escalation_id ?? randomUUID();
    let item = this.state().fleetConflicts.find(
      (item) =>
        (result.escalation_id && item.escalationId === result.escalation_id) ||
        (item.projectId === project.id &&
          item.branch === (task.run.branch ?? project.branch) &&
          item.status === "open"),
    );
    if (!item) {
      item = {
        id,
        projectId: project.id,
        epicId: task.epicId ?? undefined,
        branch: task.run.branch ?? project.branch,
        taskIds,
        agentIds,
        scope: Array.isArray(result.touched)
          ? result.touched.filter((value: unknown) => typeof value === "string")
          : this.scope(task, project),
        severity:
          result.conflict_class === "C" || result.escalation_id
            ? "C"
            : source === "runtime"
              ? "unknown"
              : "B",
        source,
        summary:
          [result.summary, result.replan_hint, result.reason].find(
            (value) => typeof value === "string",
          ) ??
          "Fleet detected overlapping work. Inspect the shared changes and decide how the affected stories should continue.",
        status: "open",
        createdAt: now(),
        escalationId: result.escalation_id,
      };
      this.state().fleetConflicts.push(item);
    } else {
      item.taskIds = [...new Set([...item.taskIds, ...taskIds])];
      if (result.conflict_class === "C" || result.escalation_id)
        item.severity = "C";
      if (result.escalation_id) item.escalationId = result.escalation_id;
    }
    await this.changed();
    this.pause(item!.taskIds);
    throw new FleetBlocked(
      "Fleet paused this epic for a human decision. Shared changes have been preserved.",
    );
  }
  private async ingest(project: Project, entry: Json): Promise<void> {
    const branch = entry.branch ?? entry.episode?.branch ?? project.branch;
    const task = this.state().tasks.find(
      (task) =>
        task.projectId === project.id &&
        (task.run.branch === branch ||
          (!!entry.epic_id && task.epicId === entry.epic_id)),
    );
    if (!task) return;
    try {
      await this.block(
        project,
        task,
        {
          ...entry,
          escalation_id: entry.escalation_id ?? entry.id,
          conflict_class: "C",
        },
        "remote",
      );
    } catch (error) {
      if (!(error instanceof FleetBlocked)) throw error;
    }
  }
}

import { randomUUID } from "node:crypto";
import type { AppState, FleetPlan, Project, WorkItem } from "../src/shared";
import { touchedIdentities } from "./coordination";
import { coordinationSchema, type CoordinationRequest } from "./fleet-requests";
import { rereadFleetSource } from "./fleet-source";
import { isActive } from "../src/domain";
import { now } from "./local";

export function overlappingScope(left: string[], right: string[]) {
  return (
    left.some((key) => key.startsWith("repo::")) ||
    right.some((key) => key.startsWith("repo::")) ||
    left.some((key) => right.includes(key))
  );
}
interface Authority {
  reserve(project: Project, task: WorkItem): Promise<boolean>;
  publish(project: Project, task: WorkItem): Promise<unknown>;
  context(project: Project, task: WorkItem): Promise<unknown>;
  disagree(
    project: Project,
    task: WorkItem,
    peerId: string,
    reason: string,
  ): Promise<never>;
  assertClear(task: WorkItem, project: Project): void;
}

/** The small worker-facing handshake. Identity and branch are always host-bound. */
export class FleetCollaboration {
  constructor(
    private state: () => AppState,
    private changed: () => Promise<void>,
    private authority: Authority,
  ) {}
  private plans() {
    return (this.state().fleetPlans ??= []);
  }
  private proposals() {
    return (this.state().fleetProposals ??= []);
  }
  private active(plan: FleetPlan) {
    return (
      plan.active &&
      this.state().tasks.some(
        (task) => task.id === plan.taskId && isActive(task),
      )
    );
  }
  private plan(task: WorkItem) {
    return this.plans().find((plan) => plan.taskId === task.id && plan.active);
  }
  private message(task: WorkItem, text: string) {
    task.messages.push({ id: randomUUID(), role: "system", text, at: now() });
    if (task.messages.length > 250)
      task.messages.splice(1, task.messages.length - 250);
  }
  async register(project: Project, task: WorkItem) {
    for (const old of this.plans().filter((plan) => plan.taskId === task.id))
      old.active = false;
    const scope = touchedIdentities(task, project);
    this.plans().push({
      taskId: task.id,
      projectId: project.id,
      branch: task.run.branch!,
      scope: scope.length ? scope : ["repo::" + project.repoId],
      plan: (task.title + "\n" + task.description).slice(0, 1600),
      publishedAt: now(),
      active: true,
    });
    await this.changed();
  }
  release(task: WorkItem) {
    for (const plan of this.plans().filter((plan) => plan.taskId === task.id))
      plan.active = false;
    for (const proposal of this.proposals().filter(
      (proposal) =>
        proposal.state === "pending" &&
        (proposal.ownerTaskId === task.id ||
          proposal.proposerTaskId === task.id),
    )) {
      proposal.state = "withdrawn";
      proposal.respondedAt = now();
      proposal.response =
        "Participant finished or stopped. Re-read current source and coordinate a fresh plan before further edits.";
    }
  }
  async prepare(project: Project, task: WorkItem) {
    if (this.owner(project, task).taskId === task.id)
      await this.authority.reserve(project, task);
  }
  private owner(project: Project, task: WorkItem) {
    const own = this.plan(task);
    if (!own) throw Error("Register this worker's Fleet intent first.");
    // Array order is the durable successful publication order, including ties.
    return (
      this.plans().find(
        (plan) =>
          plan.projectId === project.id &&
          plan.branch === task.run.branch &&
          this.active(plan) &&
          overlappingScope(own.scope, plan.scope),
      ) ?? own
    );
  }
  async coordinate(
    project: Project,
    task: WorkItem,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    const request = coordinationSchema.parse(input);
    if (signal?.aborted) throw Error("Worker coordination was cancelled.");
    this.authority.assertClear(task, project);
    const own = this.plan(task);
    if (!own) throw Error("This worker's Fleet session is no longer active.");
    if (request.plan) {
      own.plan = request.plan;
      await this.authority.publish(project, task);
    }
    own.inspectedAt = now();
    const owner = this.owner(project, task);
    if (request.action === "propose") {
      if (owner.taskId === task.id)
        throw Error(
          "There is no earlier overlapping owner to propose an alternative to.",
        );
      if (!request.alternative || !request.reason)
        throw Error("Explain the proposed alternative and why it is better.");
      let proposal = this.proposals().find(
        (p) =>
          p.proposerTaskId === task.id &&
          p.ownerTaskId === owner.taskId &&
          p.state === "pending",
      );
      if (!proposal) {
        proposal = {
          id: randomUUID(),
          projectId: project.id,
          branch: task.run.branch!,
          proposerTaskId: task.id,
          ownerTaskId: owner.taskId,
          alternative: request.alternative,
          reason: request.reason,
          state: "pending",
          createdAt: now(),
        };
        this.proposals().push(proposal);
        const peer = this.state().tasks.find((t) => t.id === owner.taskId)!;
        this.message(
          peer,
          task.identifier +
            " proposed a different solution. Read it with MemCode coordinate and respond before editing the shared scope.",
        );
        this.message(
          task,
          "Alternative proposed to " +
            peer.identifier +
            ". Preserve the first owner's work while the agents reconcile.",
        );
      }
      await this.changed();
      return {
        directive: "wait",
        reason:
          "The first owner must respond. A proposal alone is not a human conflict.",
        owner,
        proposal,
      };
    }
    if (request.action === "respond") {
      const proposal = this.proposals().find(
        (p) =>
          p.id === request.proposalId &&
          p.projectId === project.id &&
          p.branch === task.run.branch,
      );
      if (
        !proposal ||
        proposal.ownerTaskId !== task.id ||
        proposal.state !== "pending"
      )
        throw Error("Only the current proposal's bound owner may respond.");
      if (!request.decision || !request.reason)
        throw Error("Accept or reject with a concrete reason.");
      proposal.state = request.decision === "accept" ? "accepted" : "rejected";
      proposal.respondedAt = now();
      proposal.response = request.reason;
      if (proposal.state === "accepted") {
        own.plan = proposal.alternative;
        await this.authority.publish(project, task);
        this.message(
          task,
          "The agents agreed on the alternative. Update the shared implementation, then release the edit reservation.",
        );
        const proposer = this.state().tasks.find(
          (t) => t.id === proposal.proposerTaskId,
        );
        if (proposer)
          this.message(
            proposer,
            "The first owner accepted your alternative. Adhere to the agreed plan and wait for the edit reservation.",
          );
        await this.changed();
      } else {
        await this.changed();
        await this.authority.disagree(
          project,
          task,
          proposal.proposerTaskId,
          "The agents disagree on the shared implementation.\nAlternative: " +
            proposal.alternative +
            "\nProposer: " +
            proposal.reason +
            "\nOwner: " +
            request.reason,
        );
      }
    }
    const pending = this.proposals().filter(
      (p) =>
        p.state === "pending" &&
        p.projectId === project.id &&
        p.branch === task.run.branch &&
        (p.ownerTaskId === task.id || p.proposerTaskId === task.id),
    );
    if (pending.length)
      return {
        directive: pending.some((p) => p.ownerTaskId === task.id)
          ? "review-proposal"
          : "wait",
        owner,
        proposals: pending,
        canEdit: false,
      };
    let currentOwner = owner;
    if (owner.taskId !== task.id && request.action !== "adopt") {
      await this.changed();
      return {
        directive: "adhere",
        canEdit: false,
        owner,
        reason:
          "Read the earlier published plan. Adopt it and wait, or propose an explicit semantic alternative.",
        peers: await this.authority.context(project, task),
      };
    }
    if (request.action === "adopt" && owner.taskId !== task.id) {
      own.adoptedFrom = owner.taskId;
      own.adoptedPlan = owner.plan;
      this.message(
        task,
        "Adhering to " +
          this.state().tasks.find((t) => t.id === owner.taskId)?.identifier +
          "'s earlier published plan; waiting for the shared edit reservation.",
      );
    }
    const deadline = Date.now() + request.waitMs;
    do {
      if (signal?.aborted) throw Error("Worker coordination was cancelled.");
      this.authority.assertClear(task, project);
      currentOwner = this.owner(project, task);
      if (
        currentOwner.taskId !== task.id &&
        currentOwner.taskId !== owner.taskId
      ) {
        await this.changed();
        return {
          directive: "adhere",
          canEdit: false,
          owner: currentOwner,
          reason:
            "The earlier owner changed during the handoff. Read and adopt the current owner's plan before editing.",
        };
      }
      if (
        currentOwner.taskId === task.id &&
        (await this.authority.reserve(project, task))
      ) {
        const source = await rereadFleetSource(project, task);
        await this.changed();
        return {
          directive: "proceed",
          canEdit: true,
          owner: own,
          adoptedFrom: own.adoptedFrom,
          adoptedPlan: own.adoptedPlan,
          source,
          peers: await this.authority.context(project, task),
          requirement:
            "Adhere to the adopted plan. Re-read current shared source before editing. Coordinate again before the next edit; respond to proposals first. Checkpoint after the edit group.",
        };
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(300, deadline - Date.now()));
        function done() {
          signal?.removeEventListener("abort", done);
          clearTimeout(timer);
          resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
      });
    } while (Date.now() <= deadline);
    await this.changed();
    return {
      directive: "wait",
      canEdit: false,
      owner: currentOwner,
      reason:
        "The earlier owner or another Fleet reservation is still active. Continue independent read-only work; adopt again with a bounded wait.",
    };
  }
}

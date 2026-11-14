import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AppState, Project } from "../src/shared";
import { installDogfoodPlan } from "../src/dogfood";

type Register = (
  name: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
export function registerPlanning(
  register: Register,
  state: () => AppState,
  project: (id: string) => Project,
  changed: () => Promise<void>,
): void {
  const id = z.string().min(1).max(200),
    title = z.string().trim().min(1).max(160),
    phase = z.enum(["now", "next", "later"]);
  register(
    "epic:create",
    z.object({
      projectId: id,
      title,
      description: z.string().max(10000),
      phase,
    }),
    async (input) => {
      project(input.projectId);
      const existing = state().epics.filter(
        (e) => e.projectId === input.projectId,
      );
      const epic = {
        ...input,
        id: randomUUID(),
        identifier: `EP-${String(existing.length + 1).padStart(2, "0")}`,
        color: "mint" as const,
        order: existing.length,
      };
      state().epics.push(epic);
      await changed();
      return epic;
    },
  );
  register(
    "epic:update",
    z.object({
      id,
      patch: z
        .object({
          title: title.optional(),
          description: z.string().max(10000).optional(),
          phase: phase.optional(),
        })
        .strict(),
    }),
    async ({ id, patch }) => {
      const epic = state().epics.find((e) => e.id === id);
      if (!epic) throw new Error("Epic not found.");
      Object.assign(epic, patch);
      await changed();
    },
  );
  register("roadmap:install", id, async (id) => {
    const result = installDogfoodPlan(state(), project(id));
    await changed();
    return result;
  });
}

export function attachDogfoodProject(state: AppState, path: string): Project {
  let project = state.projects.find(
    (p) =>
      p.path?.replaceAll("\\", "/").toLowerCase() ===
      path.replaceAll("\\", "/").toLowerCase(),
  );
  if (!project) {
    project = {
      id: "memcode-dogfood",
      name: "MemCode",
      description:
        "The Fleet Agentic Worker Suite. Build a local workspace with measured routing, coordinated workers, and a considered developer experience.",
      path,
      branch: "main",
      repoId: "memcode",
      analysis: "idle",
      createdAt: new Date().toISOString(),
    };
    state.projects.push(project);
    if (state.activeProjectId === "example") state.activeProjectId = project.id;
  }
  installDogfoodPlan(state, project);
  return project;
}

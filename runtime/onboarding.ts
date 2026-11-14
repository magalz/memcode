import { z } from "zod";
import { guideSteps, type OnboardingProgress } from "../src/onboarding";
import type { AppState } from "../src/shared";
type Register = (
  method: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
export function registerOnboarding(
  register: Register,
  state: () => AppState,
  changed: () => Promise<void>,
) {
  register(
    "onboarding:update",
    z
      .object({
        step: z.enum(guideSteps).optional(),
        dismissed: z.boolean().optional(),
        projectId: z.string().min(1).max(250).optional(),
        epicId: z.string().min(1).max(250).optional(),
        storyId: z.string().min(1).max(250).optional(),
        complete: z.boolean().optional(),
        restart: z.boolean().optional(),
      })
      .strict(),
    async (input) => {
      const { complete, restart, ...patch } = input;
      const next: OnboardingProgress = {
        version: 1,
        step: "welcome",
        ...(restart ? {} : state().onboarding),
        ...patch,
      };
      if (
        next.projectId &&
        !state().projects.some((p) => p.id === next.projectId && !p.example)
      )
        throw Error("Choose a local project for guided setup.");
      if (
        next.epicId &&
        !state().epics.some(
          (e) => e.id === next.epicId && e.projectId === next.projectId,
        )
      )
        throw Error("Choose an epic in this project.");
      if (
        next.storyId &&
        !state().tasks.some(
          (t) =>
            t.id === next.storyId &&
            t.projectId === next.projectId &&
            t.epicId === next.epicId,
        )
      )
        throw Error("Choose a story in this epic.");
      if (complete) {
        if (!next.storyId)
          throw Error(
            "Create or choose your first story before finishing the guide.",
          );
        next.completedAt = new Date().toISOString();
        next.dismissed = true;
      }
      state().onboarding = next;
      await changed();
      return next;
    },
  );
}

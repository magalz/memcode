export const guideSteps = [
  "welcome",
  "project",
  "worker",
  "epic",
  "story",
  "ready",
] as const;
export type GuideStep = (typeof guideSteps)[number];
export interface OnboardingProgress {
  version: 1;
  step: GuideStep;
  dismissed?: boolean;
  completedAt?: string;
  projectId?: string;
  epicId?: string;
  storyId?: string;
}
export type OnboardingPatch = Partial<
  Omit<OnboardingProgress, "version" | "completedAt">
> & { complete?: boolean; restart?: boolean };
export type GuideAction =
  "project" | "worker" | "epic" | "story" | "open-story" | "account";
export function firstRunGuide(state: {
  onboarding?: OnboardingProgress;
  projects: Array<{ id?: string; example?: boolean }>;
}) {
  return (
    !state.onboarding &&
    !state.projects.some(
      (project) => !project.example && project.id !== "memcode-dogfood",
    )
  );
}

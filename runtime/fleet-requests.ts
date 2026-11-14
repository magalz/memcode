import { z } from "zod";

export const coordinationSchema = z
  .object({
    action: z.enum(["inspect", "adopt", "propose", "respond", "checkpoint"]),
    plan: z.string().trim().min(1).max(1600).optional(),
    proposalId: z.string().max(200).optional(),
    alternative: z.string().trim().min(1).max(2000).optional(),
    reason: z.string().trim().min(1).max(1600).optional(),
    decision: z.enum(["accept", "reject"]).optional(),
    waitMs: z.number().int().min(0).max(20000).default(0),
  })
  .strict();
export type CoordinationRequest = z.infer<typeof coordinationSchema>;

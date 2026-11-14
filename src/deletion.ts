import { z } from "zod";

const id = z.string().trim().min(1).max(250);
export const deleteStorySchema = z
  .object({ id, cascade: z.boolean().optional().default(false) })
  .strict();
export const deleteEntitySchema = z.object({ id }).strict();
export type DeleteStoryInput = z.input<typeof deleteStorySchema>;
export interface DeletionResult {
  deletedIds: string[];
  reassignedStoryIds: string[];
}

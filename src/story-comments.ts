export interface StoryAuthor {
  id: string;
  name: string;
  source: "memtrace" | "local";
}
export interface StoryComment {
  /** Portable selection for a review explicitly shared with the team. */
  reference?: import("./team").TeamReference;
  id: string;
  taskId: string;
  text: string;
  author: StoryAuthor;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

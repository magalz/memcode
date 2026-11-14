export interface StoryAuthor {
  id: string;
  name: string;
  source: "memtrace" | "local";
}
export interface StoryComment {
  id: string;
  taskId: string;
  text: string;
  author: StoryAuthor;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

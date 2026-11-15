import test from "node:test";
import assert from "node:assert/strict";
import type { WorkItem } from "../src/shared.ts";
import {
  sameBoardRenderProps,
  sameBoardTask,
} from "../src/components/Board.tsx";

function fixture() {
  const task = {
    id: "story-one",
    title: "Original title",
    stage: "working",
    updatedAt: "2026-11-15T01:00:00.000Z",
    run: {
      state: "running",
      activity: {
        phase: "working",
        label: "Working",
        at: "2026-11-15T01:00:00.000Z",
      },
    },
    messages: [
      {
        id: "message-one",
        role: "assistant",
        text: "Current response",
        at: "2026-11-15T01:00:00.000Z",
      },
    ],
  } as WorkItem;
  return {
    mode: "board" as const,
    today: "2026-11-15",
    tasks: [task],
    groups: [{ id: "planned", name: "Planned", tasks: [task], wipLimit: 3 }],
    selected: new Set([task.id]),
    open: (_task: WorkItem) => {},
    create: () => {},
    move: (_id: string, _group: string) => {},
    toggle: (_id: string) => {},
  };
}

test("board memo preserves the view when derived arrays and sets are recreated", () => {
  const before = fixture();
  const after = {
    ...before,
    tasks: [...before.tasks],
    groups: before.groups.map((group) => ({
      ...group,
      tasks: [...group.tasks],
    })),
    selected: new Set(before.selected),
    cycles: [],
    storyComments: [],
  };
  assert.equal(sameBoardRenderProps(before, after), true);
  assert.equal(
    sameBoardRenderProps(
      { ...before, selected: undefined },
      { ...after, selected: new Set() },
    ),
    true,
  );
});

test("a changed story, group, selection or day invalidates the board view", () => {
  const before = fixture();
  const changed = { ...before.tasks[0], title: "Updated title" };
  assert.equal(
    sameBoardRenderProps(before, { ...before, tasks: [changed] }),
    false,
  );
  assert.equal(
    sameBoardRenderProps(before, {
      ...before,
      groups: [{ ...before.groups[0], tasks: [changed] }],
    }),
    false,
  );
  for (const patch of [
    { name: "Ready" },
    { wipLimit: 1 },
    { color: "#ffeeaa" },
  ])
    assert.equal(
      sameBoardRenderProps(before, {
        ...before,
        groups: [{ ...before.groups[0], ...patch }],
      }),
      false,
    );
  assert.equal(
    sameBoardRenderProps(before, { ...before, selected: new Set() }),
    false,
  );
  assert.equal(
    sameBoardRenderProps(before, { ...before, today: "2026-11-16" }),
    false,
  );
  assert.equal(
    sameBoardRenderProps(before, { ...before, groups: undefined }),
    false,
  );
});

test("ordering and action changes cannot be hidden by board memoization", () => {
  const before = fixture();
  const second = { id: "story-two" } as WorkItem;
  assert.equal(
    sameBoardRenderProps(
      { ...before, tasks: [...before.tasks, second] },
      {
        ...before,
        tasks: [second, ...before.tasks],
      },
    ),
    false,
  );
  assert.equal(
    sameBoardRenderProps(before, { ...before, open: () => {} }),
    false,
  );
});

test("streamed response text preserves the board, but visible status and queue changes do not", () => {
  const before = fixture();
  const task = before.tasks[0];
  const streamed: WorkItem = {
    ...task,
    updatedAt: "2026-11-15T01:00:01.000Z",
    run: {
      ...task.run,
      activity: {
        ...task.run.activity!,
        at: "2026-11-15T01:00:01.000Z",
        label: "Worker is responding",
      },
    },
    messages: [
      {
        ...task.messages[0],
        text: "Current response continues with more text",
        at: "2026-11-15T01:00:01.000Z",
      },
    ],
  };
  assert.equal(sameBoardTask(task, streamed), true);
  assert.equal(
    sameBoardRenderProps(before, {
      ...before,
      tasks: [streamed],
      groups: [{ ...before.groups[0], tasks: [streamed] }],
    }),
    true,
  );
  assert.equal(sameBoardTask(task, { ...streamed, stage: "review" }), false);
  assert.equal(
    sameBoardTask(task, { ...streamed, description: "A changed brief" }),
    false,
  );
  assert.equal(
    sameBoardTask(task, {
      ...streamed,
      run: {
        ...streamed.run,
        activity: { ...streamed.run.activity!, phase: "waiting_for_user" },
      },
    }),
    false,
  );
  assert.equal(
    sameBoardTask(task, {
      ...streamed,
      messages: [{ ...streamed.messages[0], followupState: "queued" }],
    }),
    false,
  );
  assert.equal(
    sameBoardTask(task, {
      ...streamed,
      messages: [
        ...streamed.messages,
        { ...streamed.messages[0], id: "message-two" },
      ],
    }),
    false,
  );
});

import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { join } from "node:path";

export async function verifyPlanning(page, call, out) {
  const loaded = await call("workspace:load");
  const project = loaded.state.projects.find(
    (project) => project.id === loaded.state.activeProjectId,
  );
  const cycleInput = {
    projectId: project.id,
    name: "Native smoke cycle",
    goal: "Verify local planning",
    startDate: "2026-11-14",
    endDate: "2026-11-27",
    timeZone: "Europe/Copenhagen",
    capacity: 13,
    calendar: "weekdays",
  };
  const cycle = await call("cycle:create", cycleInput);
  const next = await call("cycle:create", {
    ...cycleInput,
    name: "Native carryover target",
    startDate: "2026-11-30",
    endDate: "2026-12-11",
  });
  const input = {
    projectId: project.id,
    title: "Native smoke parent",
    description: "Keep the child and planning evidence together.",
    harness: "codex",
    assignment: "auto",
    priority: "medium",
    cycleId: cycle.id,
    estimate: 5,
    labels: ["native-smoke"],
    startDate: "2026-11-14",
    dueDate: "2026-11-20",
  };
  const parent = await call("task:create", input);
  const child = await call("task:create", {
    ...input,
    title: "Native smoke child",
    parentId: parent.id,
    estimate: 3,
  });
  const carry = await call("task:create", {
    ...input,
    title: "Native smoke unfinished",
    estimate: null,
  });
  await call("cycle:start", cycle.id);
  await assert.rejects(
    call("task:update", { id: parent.id, patch: { stage: "done" } }),
    /child stories/,
  );
  await call("task:bulk-update", {
    ids: [parent.id, child.id],
    patch: { stage: "done" },
  });
  await page.locator("nav button").filter({ hasText: "Cycles" }).click();
  await expect(
    page.getByRole("heading", { name: "Native smoke cycle", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: join(out, "native-cycles.png"),
    animations: "disabled",
  });
  await call("cycle:complete", { id: cycle.id, targetCycleId: next.id });
  let state = (await call("workspace:load")).state;
  const closing = state.cycles
    .find((item) => item.id === cycle.id)
    .snapshots.at(-1);
  assert.deepEqual(
    [
      closing.total,
      closing.completed,
      closing.points,
      closing.completedPoints,
      closing.unestimated,
    ],
    [3, 2, 8, 8, 1],
  );
  assert.equal(
    state.tasks.find((task) => task.id === carry.id).cycleId,
    next.id,
  );
  await call("task:update", { id: parent.id, patch: { stage: "review" } });
  await call("task:update", {
    id: child.id,
    patch: { stage: "review", estimate: 8 },
  });
  state = (await call("workspace:load")).state;
  assert.deepEqual(
    state.cycles.find((item) => item.id === cycle.id).snapshots.at(-1),
    closing,
  );
  const saved = await call("view:save", {
    projectId: project.id,
    name: "Native smoke saved view",
    mode: "list",
    groupBy: "cycle",
    sortBy: "due",
    filters: {
      query: "",
      priority: "all",
      epicId: "all",
      cycleId: "all",
      label: "native-smoke",
      kind: "all",
      harness: "all",
      archived: false,
    },
  });
  assert.ok(
    (await call("workspace:load")).state.savedViews.some(
      (view) => view.id === saved.id,
    ),
  );
  await call("view:delete", saved.id);

  await page.locator("nav button").filter({ hasText: "Workspace" }).click();
  await expect(page.locator(".work-board")).toBeVisible();
  const heading = page.locator(".work-card h4").first();
  assert.equal(
    await heading.evaluate((element) => getComputedStyle(element).fontSize),
    "14px",
  );
  assert.equal(
    await page
      .locator(".card-description")
      .first()
      .evaluate((element) => getComputedStyle(element).webkitLineClamp),
    "2",
  );
  await expect(page.locator(".work-card").first()).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    const board = document.querySelector(".work-board");
    await Promise.all(
      (board?.getAnimations({ subtree: true }) ?? [])
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const lane = page.locator(".column-cards").first();
  const before = await page.evaluate(() => ({
    view: document.querySelector(".workspace-scroll").scrollTop,
    heading: document.querySelector(".column-heading").getBoundingClientRect()
      .top,
    done: [...document.querySelectorAll(".column-cards")].at(-1).scrollTop,
  }));
  await lane.hover();
  await page.mouse.wheel(0, 650);
  await expect
    .poll(() => lane.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const after = await page.evaluate(() => ({
    view: document.querySelector(".workspace-scroll").scrollTop,
    heading: document.querySelector(".column-heading").getBoundingClientRect()
      .top,
    done: [...document.querySelectorAll(".column-cards")].at(-1).scrollTop,
  }));
  assert.deepEqual(after, before);
  await lane.evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({
    path: join(out, "native-workspace.png"),
    animations: "disabled",
  });

  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(page.locator(".planning-row").first()).toBeVisible();
  await page.screenshot({
    path: join(out, "native-list.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Calendar view", exact: true })
    .click();
  await expect(page.locator(".calendar-day")).toHaveCount(42);
  await page.screenshot({
    path: join(out, "native-calendar.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Timeline view", exact: true })
    .click();
  await expect(page.locator(".timeline-row")).toHaveCount(3);
  await page.screenshot({
    path: join(out, "native-timeline.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await page
    .getByRole("checkbox", { name: `Select ${parent.identifier}`, exact: true })
    .check();
  await page
    .getByRole("combobox", { name: "Bulk action", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Priority: high", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await call("workspace:load")).state.tasks.find(
          (task) => task.id === parent.id,
        ).priority,
    )
    .toBe("high");
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await page
    .getByRole("textbox", { name: "View name", exact: true })
    .fill("Native UI saved view");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save view", exact: true })
    .click();
  await expect(
    page
      .locator(".workspace-saved-views")
      .getByRole("button", { name: "Native UI saved view", exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 1180, height: 820 });
  await expect
    .poll(() => lane.evaluate((element) => element.clientHeight))
    .toBeGreaterThan(290);
  await page.screenshot({
    path: join(out, "native-workspace-compact.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1512, height: 1000 });

  await page.locator("nav button").filter({ hasText: "Conversations" }).click();
  await page
    .getByRole("button", { name: "Conversation table", exact: true })
    .click();
  await expect(page.locator(".conversation-table")).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search conversations" })
    .fill(parent.identifier);
  await expect(page.locator(".conversation-table tbody tr")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search conversations" }).fill("");
  const conversationHeader = await page
    .locator(".conversation-table th")
    .first()
    .boundingBox();
  const workspaceScroll = await page
    .locator(".workspace-scroll")
    .evaluate((element) => element.scrollTop);
  await page.locator(".conversation-table-wrap").hover();
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() =>
      page
        .locator(".conversation-table-wrap")
        .evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(0);
  assert.equal(
    await page
      .locator(".workspace-scroll")
      .evaluate((element) => element.scrollTop),
    workspaceScroll,
  );
  assert.equal(
    (await page.locator(".conversation-table th").first().boundingBox()).y,
    conversationHeader.y,
  );
  await page
    .locator(".conversation-table-wrap")
    .evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({
    path: join(out, "native-conversations-table.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Conversation cards", exact: true })
    .click();
  await expect(page.locator(".conversation-card").first()).toBeVisible();
  await page.locator("nav button").filter({ hasText: "Insights" }).click();
  await expect(
    page.getByRole("tab", { name: "Code intelligence", exact: true }),
  ).toHaveCSS("display", "flex");
  await page
    .getByRole("tab", { name: "Code intelligence", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Delivery", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Delivery", exact: true }).click();
  await page.screenshot({
    path: join(out, "native-delivery-insights.png"),
    animations: "disabled",
  });
  await page.locator("nav button").filter({ hasText: "Improve" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Better code, with evidence.",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: join(out, "native-improve.png"),
    animations: "disabled",
  });
  assert.ok(
    (await call("workspace:load")).state.tasks.every(
      (task) => !["preparing", "running"].includes(task.run.state),
    ),
  );
  console.log(
    "Native planning: cycles, carryover, frozen history, bulk validation, saved views, card styles, independent lanes and insights passed.",
  );
}

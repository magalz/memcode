import { chromium, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9329"),
  main = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes("tauri.localhost")),
  call = (method, ...args) =>
    main.evaluate(({ method, args }) => window.memcode[method](...args), {
      method,
      args,
    }),
  click = (locator) => locator.evaluate((element) => element.click());
for (const field of await main
  .locator(
    'textarea[aria-label="Message to worker"],textarea[aria-label="Review comment"]',
  )
  .all())
  if ((await field.inputValue()).trim()) {
    console.log("Preserved the user’s unsent draft; the app remains open.");
    process.exit(0);
  }
const { state } = await call("load"),
  comments = state.reviewComments.filter((c) =>
    c.reference.name.endsWith(".pptx"),
  ),
  task = state.tasks.find((t) => t.id === comments[0]?.taskId),
  artifact = state.artifacts.find(
    (a) => a.id === comments[0]?.reference.artifactId,
  );
if (!task || !artifact)
  throw Error("The user's presentation comments are unavailable.");
if (await main.locator(".detail-overlay").count())
  await click(
    main.getByRole("button", { name: "Close work item", exact: true }),
  );
await call("selectProject", task.projectId);
await click(main.getByRole("button", { name: "Conversations", exact: true }));
await click(main.getByRole("button").filter({ hasText: task.title }).first());
await click(
  main.getByRole("dialog").getByRole("button", { name: /^Artifacts/ }),
);
await click(
  main
    .getByRole("dialog")
    .getByRole("button")
    .filter({ hasText: artifact.name })
    .first(),
);
let view;
await expect
  .poll(() => {
    view = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes("/p/") && p.url().endsWith("/index.html"));
    return !!view;
  })
  .toBeTruthy();
await expect(view.locator(".slide-stage")).toContainText("shared context", {
  timeout: 15000,
});
for (const note of comments)
  await expect(
    view.locator(`[data-comment-id="${note.id}"] .annotation-rect`).first(),
  ).toBeVisible({ timeout: 10000 });
await click(
  view.locator(`[data-comment-id="${comments[0].id}"] .annotation-pin`),
);
await expect(
  main.getByRole("region", { name: "Saved review comments" }),
).toContainText(comments[0].text);
await expect
  .poll(
    () =>
      view.evaluate((quote) => {
        const stage = document.querySelector(".slide-stage"),
          target = [...stage.querySelectorAll("span")].find(
            (element) => element.textContent === quote,
          );
        if (!target) return false;
        const bounds = stage.getBoundingClientRect(),
          rect = target.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      }, comments[0].reference.quote),
    { timeout: 10000 },
  )
  .toBeTruthy();
await view.screenshot({
  path: resolve(
    "../memcode-browser-lab/.memcode/evidence/user-presentation-annotations.png",
  ),
});
const report = {
  passed: true,
  taskId: task.id,
  artifact: artifact.name,
  existingComments: comments.length,
  highlightsVisible: true,
  pinOpensSavedNote: true,
  focusedTextFullyVisible: true,
};
await writeFile(
  resolve(
    "../memcode-browser-lab/.memcode/evidence/user-presentation-annotations.json",
  ),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
process.exit(0);

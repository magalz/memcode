import type { Page } from "playwright-core";
import type { BrowserInteraction } from "../../src/browser";

export async function inspectPage(page: Page): Promise<string> {
  const references = await page.evaluate(() => {
    for (const node of document.querySelectorAll("[data-memcode-ref]"))
      node.removeAttribute("data-memcode-ref");
    const nodes = [
      ...document.querySelectorAll<HTMLElement>(
        "a,button,input,textarea,select,[role=button],[contenteditable=true]",
      ),
    ]
      .filter(
        (node) =>
          node.getClientRects().length &&
          getComputedStyle(node).visibility !== "hidden",
      )
      .slice(0, 100);
    return nodes
      .map((node, index) => {
        const ref = "m" + (index + 1);
        node.setAttribute("data-memcode-ref", ref);
        return `${ref}: ${node.tagName.toLowerCase()} ${node.getAttribute("aria-label") || node.innerText || node.getAttribute("placeholder") || node.getAttribute("name") || ""}`.slice(
          0,
          220,
        );
      })
      .join("\n");
  });
  const accessible = await page
    .locator("body")
    .ariaSnapshot({ timeout: 8000 })
    .catch(() => "Accessibility snapshot unavailable.");
  return `URL: ${page.url()}\nTitle: ${await page.title()}\n\nVisible controls (use ref for actions):\n${references}\n\nAccessibility:\n${accessible}`.slice(
    0,
    18000,
  );
}

export async function interact(
  page: Page,
  input: BrowserInteraction,
  viewport: { width: number; height: number },
): Promise<{ cursor?: string; point?: { x: number; y: number } }> {
  let point =
    input.x !== undefined && input.y !== undefined
      ? { x: input.x, y: input.y }
      : undefined;
  const element = input.ref
    ? page.locator(`[data-memcode-ref="${input.ref}"]`)
    : undefined;
  switch (input.action) {
    case "click":
      if (element) {
        await element.scrollIntoViewIfNeeded({ timeout: 8000 });
        const box = await element.boundingBox();
        if (box)
          point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await element.click({ timeout: 8000 });
      } else if (
        input.x !== undefined &&
        input.y !== undefined &&
        input.x <= viewport.width &&
        input.y <= viewport.height
      )
        await page.mouse.click(input.x, input.y);
      else
        throw Error(
          "Choose a current control ref or a point inside this page.",
        );
      break;
    case "hover":
      if (!point || point.x > viewport.width || point.y > viewport.height)
        throw Error("Hover inside the current page.");
      await page.mouse.move(point.x, point.y);
      break;
    case "type":
      if (input.text === undefined) throw Error("Text is required.");
      if (element) await element.fill(input.text, { timeout: 8000 });
      else await page.keyboard.insertText(input.text);
      break;
    case "press":
      if (!input.key) throw Error("A supported key is required.");
      await page.keyboard.press(input.key);
      break;
    case "choose":
      if (!element || (input.value === undefined && input.label === undefined))
        throw Error("Choose a current select ref and option value or label.");
      await element.selectOption(
        input.value !== undefined
          ? { value: input.value }
          : { label: input.label! },
        { timeout: 8000 },
      );
      break;
    case "scroll":
      if (point) await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, input.deltaY ?? 600);
      break;
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
      break;
    case "forward":
      await page.goForward({ waitUntil: "domcontentloaded", timeout: 15000 });
      break;
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      break;
  }
  if (!point) return {};
  const cursor = await page
    .evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      if (!element) return "default";
      if (element.closest("input,textarea,[contenteditable=true]"))
        return "text";
      return getComputedStyle(element).cursor;
    }, point)
    .catch(() => "default");
  return {
    point,
    cursor: [
      "default",
      "auto",
      "pointer",
      "text",
      "crosshair",
      "grab",
      "grabbing",
      "not-allowed",
      "wait",
      "progress",
    ].includes(cursor)
      ? cursor
      : "default",
  };
}

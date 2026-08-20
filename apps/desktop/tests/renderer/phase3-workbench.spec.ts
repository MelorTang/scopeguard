import { expect, test, type Locator } from "@playwright/test";

const screenshotRoot = "../../output/playwright";

test("four-pane workbench keeps independent controls and supports handoff", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");

  const panes = page.locator(".thread-pane");
  await expect(panes).toHaveCount(4);
  await assertNoHorizontalOverlap(panes);

  for (let index = 0; index < 4; index += 1) {
    const pane = panes.nth(index);
    const composer = pane.getByRole("textbox", { name: /发送消息给/ });
    await composer.fill(`慢速并发任务 ${index + 1}`);
    await pane.getByRole("button", { name: "发送消息" }).click();
  }
  await expect(panes.getByRole("button", { name: "停止运行" })).toHaveCount(4);
  const delivery = page.getByRole("region", { name: /交付执行，第/ });
  await delivery.getByRole("button", { name: /关闭 交付执行 窗格/ }).click();
  await expect(panes).toHaveCount(3);
  await page.getByRole("button", { name: /交付执行/ }).click();
  await expect(page.getByRole("region", { name: /交付执行，第/ })
    .getByRole("button", { name: "停止运行" })).toBeVisible();

  const research = page.getByRole("region", { name: /供应商对比，第/ });
  await research.getByRole("button", { name: "停止运行" }).click();
  await expect(research.getByRole("button", { name: "停止运行" })).toHaveCount(0);
  for (const title of ["季度简报", "结论核验", "交付执行"]) {
    await expect(page.getByRole("region", { name: new RegExp(`${title}，第`) })
      .getByRole("button", { name: "停止运行" })).toBeVisible();
  }

  await research.getByRole("button", { name: "Handoff 与 Agent Dispatch" }).click();
  const handoff = research.getByRole("region", { name: "Handoff 与 Agent Dispatch" });
  await handoff.getByLabel("Handoff 工作请求").fill("慢速核验并给出下一步建议");
  await handoff.getByRole("button", { name: "生成 Prompt" }).click();
  await expect(handoff.locator(".handoff-preview")).toContainText("未附带来源 Conversation 的完整历史");
  await handoff.getByRole("button", { name: "复制", exact: true }).click();
  await expect(handoff.getByRole("status")).toContainText("已复制");

  await expect(page.getByRole("button", { name: "停止运行" })).toHaveCount(0, {
    timeout: 5_000,
  });
  await handoff.getByRole("button", { name: "发送 Dispatch" }).click();
  const brief = page.getByRole("region", { name: /季度简报，第/ });
  await expect(research.locator(".dispatch-card")).toContainText("运行中");
  await expect(brief.locator(".dispatch-card")).toContainText("来自");

  const review = page.getByRole("region", { name: /结论核验，第/ });
  await review.getByRole("button", { name: "Handoff 与 Agent Dispatch" }).click();
  const busyHandoff = review.getByRole("region", { name: "Handoff 与 Agent Dispatch" });
  await busyHandoff.getByRole("combobox").selectOption({ label: "季度简报" });
  await busyHandoff.getByLabel("Handoff 工作请求").fill("不得进入隐藏队列");
  await busyHandoff.getByRole("button", { name: "发送 Dispatch" }).click();
  await expect(review.locator(".dispatch-card--failed")).toContainText("active Run");
  await expect(brief.locator(".dispatch-card--failed")).toContainText("active Run");

  await page.screenshot({
    path: `${screenshotRoot}/phase3-four-pane-1920x1080.png`,
    fullPage: true,
  });
});

test("constrained workbench stays operable and draft survives reload", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/");
  const panes = page.locator(".thread-pane");
  await expect(panes).toHaveCount(2);
  await assertNoHorizontalOverlap(panes);
  for (let index = 0; index < 2; index += 1) {
    await expect(panes.nth(index).getByRole("textbox", { name: /发送消息给/ })).toBeVisible();
    await expect(panes.nth(index).getByRole("button", { name: "Handoff 与 Agent Dispatch" })).toBeVisible();
  }

  const firstComposer = panes.nth(0).getByRole("textbox", { name: /发送消息给/ });
  await firstComposer.fill("重启后仍需保留的草稿");
  await page.reload();
  await expect(page.locator(".thread-pane").nth(0).getByRole("textbox", { name: /发送消息给/ }))
    .toHaveValue("重启后仍需保留的草稿");

  await page.screenshot({
    path: `${screenshotRoot}/phase3-constrained-1100x800.png`,
    fullPage: true,
  });
});

test("responsive projection keeps the active pane visible", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto("/");
  const delivery = page.getByRole("region", { name: /交付执行，第/ });
  await delivery.click();
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.locator(".thread-pane")).toHaveCount(2);
  await expect(page.getByRole("region", { name: /交付执行，第/ })).toBeVisible();
});

test("handoff copy reports clipboard failure", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("clipboard unavailable")) },
    });
  });
  const source = page.getByRole("region", { name: /供应商对比，第/ });
  await source.getByRole("button", { name: "Handoff 与 Agent Dispatch" }).click();
  const handoff = source.getByRole("region", { name: "Handoff 与 Agent Dispatch" });
  await handoff.getByLabel("Handoff 工作请求").fill("复制失败回归");
  await handoff.getByRole("button", { name: "复制", exact: true }).click();
  await expect(handoff.getByRole("status")).toContainText("复制失败");
  await expect(handoff.getByRole("status")).toHaveClass(/handoff-feedback--error/);
});

async function assertNoHorizontalOverlap(panes: Locator): Promise<void> {
  const boxes = await panes.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width };
  }));
  for (const box of boxes) expect(box.width).toBeGreaterThan(0);
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index]!.left).toBeGreaterThanOrEqual(boxes[index - 1]!.right - 1);
  }
}

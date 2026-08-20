import { expect, test, type Locator } from "@playwright/test";

const screenshotRoot = "../../output/playwright";

test("four-pane workbench keeps independent controls and supports handoff", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");

  const panes = page.locator(".thread-pane");
  await expect(panes).toHaveCount(4);
  await assertNoHorizontalOverlap(panes);
  const splitters = page.getByRole("separator", { name: /调整窗格宽度/ });
  await expect(splitters).toHaveCount(3);
  const firstWidth = await paneWidth(panes.nth(0));
  const firstSplitter = splitters.nth(0);
  const splitterBox = await firstSplitter.boundingBox();
  if (!splitterBox) throw new Error("First pane splitter has no layout box.");
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + 30);
  await page.mouse.down();
  await page.mouse.move(splitterBox.x + splitterBox.width / 2 + 72, splitterBox.y + 30);
  await page.mouse.up();
  expect(await paneWidth(panes.nth(0))).toBeGreaterThan(firstWidth + 40);
  await firstSplitter.focus();
  await firstSplitter.press("ArrowLeft");
  expect(await paneWidth(panes.nth(0))).toBeLessThan(firstWidth + 72);

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
  await expect(handoff.getByRole("combobox")).toHaveValue("");
  await expect(handoff.getByRole("button", { name: "发送 Dispatch" })).toBeDisabled();
  await handoff.getByRole("combobox").selectOption({ label: "季度简报" });
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

test("1100px workbench keeps all four readable panes horizontally accessible", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/");
  const panes = page.locator(".thread-pane");
  await expect(panes).toHaveCount(4);
  await assertNoHorizontalOverlap(panes);
  const workbench = page.locator(".workbench");
  const overflow = await workbench.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
  for (let index = 0; index < 4; index += 1) {
    await panes.nth(index).scrollIntoViewIfNeeded();
    await expect(panes.nth(index).getByRole("textbox", { name: /发送消息给/ })).toBeVisible();
    await expect(panes.nth(index).getByRole("button", { name: "Handoff 与 Agent Dispatch" })).toBeVisible();
    expect(await paneWidth(panes.nth(index))).toBeGreaterThanOrEqual(320);
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

test("narrow resize never hides requested panes", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto("/");
  const delivery = page.getByRole("region", { name: /交付执行，第/ });
  await delivery.click();
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.locator(".thread-pane")).toHaveCount(4);
  await page.getByRole("region", { name: /交付执行，第/ }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("region", { name: /交付执行，第/ })).toBeVisible();
});

test("keyboard resize survives an immediate Renderer reload", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto("/");
  const firstPane = page.locator(".thread-pane").first();
  const splitter = page.getByRole("separator", { name: /调整窗格宽度/ }).first();
  const before = await paneWidth(firstPane);
  await splitter.focus();
  await splitter.press("ArrowRight");
  const resized = await paneWidth(firstPane);
  expect(resized).toBeGreaterThan(before);

  await page.reload();
  await expect(page.locator(".thread-pane")).toHaveCount(4);
  expect(await paneWidth(page.locator(".thread-pane").first())).toBeCloseTo(resized, 0);
});

test("Workspace switch isolates panes and persists A and B independently", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto("/");

  await page.getByRole("button", { name: /数据归档/ }).click();
  await page.getByRole("button", { name: /独立工作区 B/ }).click();
  await expect(page.getByRole("region", { name: /B 对话，第/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /数据归档，第/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: /供应商对比，第/ })).toHaveCount(0);

  await page.getByRole("separator", { name: /调整窗格宽度/ }).first().press("ArrowRight");
  await page.waitForTimeout(120);
  await page.reload();
  await expect(page.getByRole("region", { name: /B 对话，第/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /数据归档，第/ })).toHaveCount(0);

  await page.getByRole("button", { name: /ScopeGuard 产品工作区/ }).click();
  await expect(page.getByRole("region", { name: /数据归档，第/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /B 对话，第/ })).toHaveCount(0);
});

test("opening local Workspace B never displays or persists Workspace A Conversations", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /数据归档/ }).click();
  await page.getByRole("button", { name: "新建工作区" }).first().click();
  await page.getByRole("button", { name: "打开本地文件夹" }).click();

  await expect(page.getByText("OpenedLocalB", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".thread-pane")).toHaveCount(0);
  await expect(page.getByText("供应商对比", { exact: true })).toHaveCount(0);
  await page.waitForTimeout(120);
  const persisted = await page.evaluate(() => Object.entries(sessionStorage)
    .filter(([key]) => key.startsWith("scopeguard.mock.workspace-layout:"))
    .map(([, value]) => JSON.parse(value) as { workspaceId: string; openConversationIds: string[] })
    .find(({ workspaceId }) => !["workspace-demo", "workspace-b"].includes(workspaceId)));
  expect(persisted?.openConversationIds).toEqual([]);

  await page.getByRole("button", { name: /ScopeGuard 产品工作区/ }).click();
  await expect(page.getByRole("region", { name: /数据归档，第/ })).toBeVisible();
});

test("opening a fifth Conversation replaces the active pane and keeps four panes", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto("/");
  const panes = page.locator(".thread-pane");
  await expect(panes).toHaveCount(4);
  await page.getByRole("button", { name: /数据归档/ }).click();
  await expect(panes).toHaveCount(4);
  await expect(page.getByRole("region", { name: /数据归档，第/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /供应商对比，第/ })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".thread-pane")).toHaveCount(4);
  await expect(page.getByRole("region", { name: /数据归档，第/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /供应商对比，第/ })).toHaveCount(0);
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
  await handoff.getByRole("combobox").selectOption({ label: "季度简报" });
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

async function paneWidth(pane: Locator): Promise<number> {
  return await pane.evaluate((element) => element.getBoundingClientRect().width);
}

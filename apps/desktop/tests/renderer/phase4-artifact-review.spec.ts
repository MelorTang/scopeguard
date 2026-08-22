import { expect, test } from "@playwright/test";

test("Artifact Review restores the selected immutable version and returns to Workbench", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await page.getByRole("button", { name: /季度简报\.docx/ }).click();
  const review = page.getByRole("region", { name: "Artifact Review" });
  await expect(review).toBeVisible();
  await expect(review).toContainText("Agent Skill: documents");
  await expect(review).toContainText("季度简报");
  await expect(review.getByText("Workspace 源身份").locator("..")).toContainText("b".repeat(64));
  await expect(review.getByText("Artifact 输出身份").locator("..")).toContainText("b".repeat(64));
  await expect(review.getByRole("region", { name: "工作流输入身份" })).toContainText(
    "inputs/quarterly-data.xlsx",
  );
  await expect(review.getByRole("region", { name: "工作流输入身份" })).toContainText(
    "d".repeat(64),
  );
  await page.screenshot({
    path: "../../output/playwright/phase4-artifact-review-1440x900.png",
    fullPage: true,
  });

  await review.getByLabel("审阅版本").selectOption("artifact-version-1");
  await review.getByLabel("对比版本").selectOption("artifact-version-2");
  await review.getByRole("button", { name: "显示关联对话" }).click();
  await expect(page.getByRole("region", { name: "季度简报，Artifact 关联对话" })).toBeVisible();
  await page.screenshot({
    path: "../../output/playwright/phase4-artifact-conversation-1440x900.png",
    fullPage: true,
  });
  await review.getByRole("button", { name: "设为当前版本" }).click();
  await expect(review.getByText("当前版本", { exact: true })).toBeVisible();

  await page.reload();
  const restored = page.getByRole("region", { name: "Artifact Review" });
  await expect(restored.getByLabel("审阅版本")).toHaveValue("artifact-version-1");
  await expect(restored.getByLabel("对比版本")).toHaveValue("artifact-version-2");
  await expect(page.getByRole("region", { name: "季度简报，Artifact 关联对话" })).toBeVisible();

  await restored.getByRole("button", { name: "收起关联对话" }).click();
  await expect(page.getByRole("region", { name: "季度简报，Artifact 关联对话" })).toHaveCount(0);

  await restored.getByRole("button", { name: "返回工作台" }).click();
  await expect(page.locator(".thread-pane")).toHaveCount(4);
});

test("Artifact Review opens and exports only the selected captured version", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /季度简报\.docx/ }).click();
  const review = page.getByRole("region", { name: "Artifact Review" });

  await review.getByRole("button", { name: "使用系统应用打开" }).click();
  await expect(review.getByRole("status")).toContainText("已交给系统应用打开");

  await review.getByLabel("导出到 Workspace").fill("exports/quarterly-review.docx");
  await review.getByRole("button", { name: "导出版本" }).click();
  await expect(review.getByRole("status")).toContainText("已导出");
  await expect(review.getByRole("status")).toContainText("exports/quarterly-review.docx");
});

test("captures an Agent-produced Workspace File with explicit toolchain provenance", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await page.getByRole("button", { name: "捕获成果" }).click();
  const dialog = page.getByRole("dialog", { name: "捕获 Artifact 版本" });
  await dialog.getByRole("button", { name: "选择 Workspace 文件" }).click();
  await expect(dialog.getByText("reports/agent-result.docx", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "选择工作流输入文件" }).click();
  await expect(dialog.getByText("inputs/source-data.xlsx", { exact: true })).toBeVisible();
  await dialog.getByLabel("实际工具链").fill("Agent Skill: documents + LibreOffice 25.2");
  await dialog.getByLabel("已知限制").fill("复杂宏未验证");
  await dialog.getByLabel("产生结果的 Run").selectOption("run-artifact-demo");
  await dialog.getByLabel("验证摘要").fill("重新打开 DOCX 并确认正文可读。");
  await dialog.getByLabel("输出验证结果").selectOption("partial");
  await expect(dialog.getByRole("button", { name: "捕获不可变版本" })).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText("不会被捕获为 Artifact 版本");
  await dialog.getByLabel("输出验证结果").selectOption("passed");
  await dialog.getByRole("button", { name: "捕获不可变版本" }).click();

  const review = page.getByRole("region", { name: "Artifact Review" });
  await expect(review).toContainText("agent-result.docx");
  await expect(review).toContainText("Agent Skill: documents + LibreOffice 25.2");
  await expect(review).toContainText("复杂宏未验证");
  await expect(review).toContainText("重新打开 DOCX 并确认正文可读。");
  await expect(review.getByRole("region", { name: "工作流输入身份" })).toContainText(
    "inputs/source-data.xlsx",
  );
});

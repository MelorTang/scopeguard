import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Document, Packer, Paragraph } from "docx";

import {
  readPhase4PilotDocxText,
  runPhase4FilePilotWorkflow,
} from "./phase4-file-pilot-workflow.js";

test("test-only Agent workflow inspects, creates, revises, and reopens a DOCX", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeguard-phase4-file-workflow-"));
  try {
    const firstInput = join(root, "input-v1.docx");
    const secondInput = join(root, "input-v2.docx");
    const firstOutput = join(root, "reports", "agent-result-v1.docx");
    const secondOutput = join(root, "reports", "agent-result-v2.docx");
    await writeDocx(firstInput, "First representative office input.");
    await writeDocx(secondInput, "Second representative office input.");

    const created = await runPhase4FilePilotWorkflow({
      mode: "create",
      inputPath: firstInput,
      outputPath: firstOutput,
    });
    assert.match(created.inputText, /First representative office input/);
    assert.match(created.outputText, /版本 1/);

    const revised = await runPhase4FilePilotWorkflow({
      mode: "revise",
      inputPath: secondInput,
      previousOutputPath: firstOutput,
      outputPath: secondOutput,
    });
    assert.match(revised.inputText, /Second representative office input/);
    assert.match(revised.previousOutputText ?? "", /版本 1/);
    assert.match(revised.outputText, /版本 2/);
    assert.match(await readPhase4PilotDocxText(firstOutput), /版本 1/);
    assert.match(await readPhase4PilotDocxText(secondOutput), /版本 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeDocx(path: string, text: string): Promise<void> {
  const document = new Document({
    sections: [{ children: [new Paragraph(text)] }],
  });
  await writeFile(path, await Packer.toBuffer(document));
}

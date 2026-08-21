import { resolve } from "node:path";

import { runPhase4FilePilotWorkflow } from "../dist/main/phase4-file-pilot-workflow.js";

const [mode, inputPath, outputPath, ...extra] = process.argv.slice(2);
if (
  extra.length > 0 ||
  (mode !== "create" && mode !== "revise") ||
  !inputPath ||
  !outputPath
) {
  throw new Error(
    "Usage: node phase4-file-pilot-workflow.mjs <create|revise> <input.docx> <output.docx>",
  );
}

const result = await runPhase4FilePilotWorkflow({
  mode,
  inputPath: resolve(inputPath),
  outputPath: resolve(outputPath),
});
console.log(JSON.stringify({
  mode: result.mode,
  inputTextObserved: result.inputText.length > 0,
  priorOutputObserved: result.previousOutputText !== null,
  outputValidated: result.outputText.length > 0,
  warningCount: result.warnings.length,
}));

import { resolve } from "node:path";

import { runPhase4FilePilotWorkflow } from "../dist/main/phase4-file-pilot-workflow.js";

const [mode, inputPath, thirdPath, fourthPath, ...extra] = process.argv.slice(2);
const previousOutputPath = mode === "revise" ? thirdPath : undefined;
const outputPath = mode === "revise" ? fourthPath : thirdPath;
if (
  extra.length > 0 ||
  (mode !== "create" && mode !== "revise") ||
  !inputPath ||
  !outputPath ||
  (mode === "create" && fourthPath !== undefined)
) {
  throw new Error(
    "Usage: node phase4-file-pilot-workflow.mjs create <input.docx> <output.docx> OR revise <input.docx> <previous.docx> <output.docx>",
  );
}

const result = await runPhase4FilePilotWorkflow({
  mode,
  inputPath: resolve(inputPath),
  ...(previousOutputPath ? { previousOutputPath: resolve(previousOutputPath) } : {}),
  outputPath: resolve(outputPath),
});
console.log(JSON.stringify({
  mode: result.mode,
  inputTextObserved: result.inputText.length > 0,
  priorOutputObserved: result.previousOutputText !== null,
  outputValidated: result.outputText.length > 0,
  warningCount: result.warnings.length,
}));

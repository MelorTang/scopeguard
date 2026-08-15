import { realpath, stat } from "node:fs/promises";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export type ValidatedWorkspaceFile = {
  name: string;
  relativePath: string;
};

export async function validateWorkspaceFileSelection(
  workspaceRoot: string,
  selectedPaths: string[],
): Promise<ValidatedWorkspaceFile[]> {
  const canonicalRoot = await realpath(resolve(workspaceRoot));
  const rootMetadata = await stat(canonicalRoot);
  if (!rootMetadata.isDirectory()) {
    throw new Error("Workspace root must reference an existing directory.");
  }

  return Promise.all(selectedPaths.map(async (selectedPath) => {
    const canonicalPath = await realpath(resolve(selectedPath));
    const metadata = await stat(canonicalPath);
    const relativePath = relative(canonicalRoot, canonicalPath);
    if (
      !metadata.isFile() ||
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error("Only files inside the current Workspace can be added.");
    }
    return {
      name: basename(canonicalPath),
      relativePath: relativePath.split(sep).join("/"),
    };
  }));
}

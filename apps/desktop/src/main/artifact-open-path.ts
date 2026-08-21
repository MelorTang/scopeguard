import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export async function validateArtifactOpenPath(
  value: unknown,
  artifactRoot: string,
): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("Agent Host returned an invalid absolute Artifact open path.");
  }
  if (!isAbsolute(artifactRoot)) {
    throw new Error("Artifact storage root must be absolute.");
  }
  const [openRoot, candidate] = await Promise.all([
    realpath(join(artifactRoot, "open")),
    realpath(value),
  ]);
  assertInside(openRoot, candidate);
  const metadata = await lstat(value);
  if (metadata.isSymbolicLink()) {
    throw new Error("Artifact open path must not be a symbolic link.");
  }
  if (!metadata.isFile()) {
    throw new Error("Artifact open path must be a regular file.");
  }
  return candidate;
}

function assertInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path)) return;
  throw new Error("Artifact open path must be inside the Artifact open directory.");
}

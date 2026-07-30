import { chmod, mkdir } from "node:fs/promises";

export async function preparePrivateDataDirectory(
  path: string,
  platform = process.platform,
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    await chmod(path, 0o700);
  }
}

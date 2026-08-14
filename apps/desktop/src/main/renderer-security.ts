import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveDevelopmentRendererUrl(options: {
  configuredUrl: string | undefined;
  isPackaged: boolean;
}): string | null {
  if (options.isPackaged || !options.configuredUrl) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(options.configuredUrl);
  } catch {
    throw new Error("SCOPEGUARD_RENDERER_URL must be a valid URL.");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
  ) {
    throw new Error(
      "SCOPEGUARD_RENDERER_URL is only allowed for a localhost development server.",
    );
  }

  return url.toString();
}

export function isTrustedRendererUrl(
  value: string,
  options: {
    developmentRendererUrl: string | null;
    rendererDirectory: string;
    platform?: NodeJS.Platform;
  },
): boolean {
  try {
    const url = new URL(value);
    if (options.developmentRendererUrl) {
      return url.origin === new URL(options.developmentRendererUrl).origin;
    }
    if (url.protocol !== "file:") {
      return false;
    }

    const filePath = fileURLToPath(url);
    const pathFromRenderer = relative(options.rendererDirectory, filePath);
    return (
      pathFromRenderer !== ".."
      && !pathFromRenderer.startsWith("../")
      && !pathFromRenderer.startsWith("..\\")
      && !isAbsolute(pathFromRenderer)
    );
  } catch {
    return false;
  }
}

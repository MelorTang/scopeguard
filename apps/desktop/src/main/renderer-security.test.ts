import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  isTrustedRendererUrl,
  resolveDevelopmentRendererUrl,
} from "./renderer-security.js";

test("packaged builds ignore a configured remote renderer URL", () => {
  assert.equal(
    resolveDevelopmentRendererUrl({
      configuredUrl: "https://attacker.example/app",
      isPackaged: true,
    }),
    null,
  );
});

test("development renderer only accepts localhost origins", () => {
  assert.equal(
    resolveDevelopmentRendererUrl({
      configuredUrl: "http://localhost:5173",
      isPackaged: false,
    }),
    "http://localhost:5173/",
  );
  assert.equal(
    resolveDevelopmentRendererUrl({
      configuredUrl: "http://127.0.0.1:5173",
      isPackaged: false,
    }),
    "http://127.0.0.1:5173/",
  );
  assert.throws(
    () =>
      resolveDevelopmentRendererUrl({
        configuredUrl: "https://attacker.example/app",
        isPackaged: false,
      }),
    /localhost development server/,
  );
  assert.throws(
    () =>
      resolveDevelopmentRendererUrl({
        configuredUrl: "http://localhost.example:5173",
        isPackaged: false,
      }),
    /localhost development server/,
  );
});

test("renderer trust is limited to the selected dev origin or packaged files", () => {
  const rendererDirectory = join(process.cwd(), "dist-renderer");
  assert.equal(
    isTrustedRendererUrl("http://127.0.0.1:5173/settings", {
      developmentRendererUrl: "http://127.0.0.1:5173/",
      rendererDirectory,
    }),
    true,
  );
  assert.equal(
    isTrustedRendererUrl("http://localhost:5173/", {
      developmentRendererUrl: "http://127.0.0.1:5173/",
      rendererDirectory,
    }),
    false,
  );

  assert.equal(
    isTrustedRendererUrl(
      pathToFileURL(join(rendererDirectory, "index.html")).toString(),
      {
        developmentRendererUrl: null,
        rendererDirectory,
      },
    ),
    true,
  );
  assert.equal(
    isTrustedRendererUrl(
      pathToFileURL(join(rendererDirectory, "..", "main.js")).toString(),
      {
        developmentRendererUrl: null,
        rendererDirectory,
      },
    ),
    false,
  );
  assert.equal(
    isTrustedRendererUrl("https://scopeguard.example/", {
      developmentRendererUrl: null,
      rendererDirectory,
    }),
    false,
  );
});

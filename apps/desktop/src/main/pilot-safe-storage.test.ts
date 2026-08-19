import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  assertDesktopPilotCredentialStoreIsolation,
  assertDesktopPilotLaunchAllowed,
  createDesktopPilotSafeStorage,
  parseDesktopPilotPhase,
} from "./pilot-safe-storage.js";

test("encrypts Pilot credentials for a second Desktop process without plaintext", () => {
  const key = randomBytes(32).toString("base64url");
  const firstProcessStorage = createDesktopPilotSafeStorage(key);
  const encrypted = firstProcessStorage.encryptString("pilot-provider-secret");

  assert.equal(encrypted.includes(Buffer.from("pilot-provider-secret")), false);
  const secondProcessStorage = createDesktopPilotSafeStorage(key);
  assert.equal(
    secondProcessStorage.decryptString(encrypted),
    "pilot-provider-secret",
  );
});

test("rejects tampered Pilot credential ciphertext", () => {
  const storage = createDesktopPilotSafeStorage(
    randomBytes(32).toString("base64url"),
  );
  const encrypted = storage.encryptString("pilot-provider-secret");
  encrypted[encrypted.length - 1] ^= 0xff;

  assert.throws(
    () => storage.decryptString(encrypted),
    /failed authentication/,
  );
});

test("rejects missing, malformed, or different Pilot storage keys", () => {
  assert.throws(
    () => createDesktopPilotSafeStorage(""),
    /base64url-encoded 32-byte key/,
  );
  assert.throws(
    () => createDesktopPilotSafeStorage("not-a-key"),
    /base64url-encoded 32-byte key/,
  );

  const encrypted = createDesktopPilotSafeStorage(
    randomBytes(32).toString("base64url"),
  ).encryptString("pilot-provider-secret");
  const otherStorage = createDesktopPilotSafeStorage(
    randomBytes(32).toString("base64url"),
  );
  assert.throws(
    () => otherStorage.decryptString(encrypted),
    /failed authentication/,
  );
});

test("fails before Pilot startup without the platform credential-store isolation switch", () => {
  const missing = {
    getSwitchValue: () => "",
    hasSwitch: () => false,
  };
  assert.throws(
    () => assertDesktopPilotCredentialStoreIsolation("darwin", missing),
    /use-mock-keychain/,
  );
  assert.throws(
    () => assertDesktopPilotCredentialStoreIsolation("linux", missing),
    /password-store=basic/,
  );

  assert.doesNotThrow(() =>
    assertDesktopPilotCredentialStoreIsolation("darwin", {
      getSwitchValue: (name) =>
        name === "disable-features" ? "DialMediaRouteProvider" : "",
      hasSwitch: (name) => name === "use-mock-keychain",
    }),
  );
  assert.throws(
    () => assertDesktopPilotCredentialStoreIsolation("darwin", {
      getSwitchValue: () => "",
      hasSwitch: (name) => name === "use-mock-keychain",
    }),
    /DialMediaRouteProvider/,
  );
  assert.doesNotThrow(() =>
    assertDesktopPilotCredentialStoreIsolation("linux", {
      getSwitchValue: (name) => name === "password-store" ? "basic" : "",
      hasSwitch: () => false,
    }),
  );
});

test("enters the Pilot seam only for an explicit supported phase", () => {
  assert.equal(parseDesktopPilotPhase(undefined), null);
  assert.equal(parseDesktopPilotPhase("1"), "1");
  assert.equal(parseDesktopPilotPhase("2"), "2");
  assert.throws(() => parseDesktopPilotPhase(""), /must be 1 or 2/);
  assert.throws(() => parseDesktopPilotPhase("pilot"), /must be 1 or 2/);
});

test("blocks unsigned macOS Pilot automation before Electron can launch", () => {
  assert.throws(
    () => assertDesktopPilotLaunchAllowed("darwin", undefined),
    /disabled for unsigned macOS/,
  );
  assert.doesNotThrow(() =>
    assertDesktopPilotLaunchAllowed("darwin", "1"),
  );
  assert.doesNotThrow(() =>
    assertDesktopPilotLaunchAllowed("win32", undefined),
  );
  assert.doesNotThrow(() =>
    assertDesktopPilotLaunchAllowed("linux", undefined),
  );
});

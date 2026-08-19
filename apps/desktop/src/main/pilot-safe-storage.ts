import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import type { SafeStorage } from "electron";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_HEADER = Buffer.from("SGP1", "ascii");
const AUTHENTICATED_CONTEXT = Buffer.from(
  "scopeguard-desktop-pilot-safe-storage-v1",
  "utf8",
);

export type PilotSafeStorage = Pick<
  SafeStorage,
  | "decryptString"
  | "encryptString"
  | "getSelectedStorageBackend"
  | "isEncryptionAvailable"
>;

type PilotCommandLine = {
  getSwitchValue(name: string): string;
  hasSwitch(name: string): boolean;
};

export type DesktopPilotPhase = "1" | "2";

export function parseDesktopPilotPhase(
  value: string | undefined,
): DesktopPilotPhase | null {
  if (value === undefined) return null;
  if (value === "1" || value === "2") return value;
  throw new Error("SCOPEGUARD_DESKTOP_PILOT_PHASE must be 1 or 2.");
}

export function assertDesktopPilotLaunchAllowed(
  platform: NodeJS.Platform,
  signedMacosDistribution: string | undefined,
): void {
  if (platform === "darwin" && signedMacosDistribution !== "1") {
    throw new Error(
      "Automated Desktop Pilot is disabled for unsigned macOS development builds because Electron can present a blocking Keychain dialog. Use Windows or Linux, or the Phase 5 signed macOS distribution gate.",
    );
  }
}

export function assertDesktopPilotCredentialStoreIsolation(
  platform: NodeJS.Platform,
  commandLine: PilotCommandLine,
): void {
  if (platform === "darwin" && !commandLine.hasSwitch("use-mock-keychain")) {
    throw new Error(
      "Desktop Pilot on macOS requires --use-mock-keychain before Electron starts.",
    );
  }
  if (
    platform === "darwin" &&
    !commandLine
      .getSwitchValue("disable-features")
      .split(",")
      .includes("DialMediaRouteProvider")
  ) {
    throw new Error(
      "Desktop Pilot on macOS requires DialMediaRouteProvider to be disabled before Electron starts.",
    );
  }
  if (
    platform === "linux" &&
    commandLine.getSwitchValue("password-store") !== "basic"
  ) {
    throw new Error(
      "Desktop Pilot on Linux requires --password-store=basic before Electron starts.",
    );
  }
}

export function createDesktopPilotSafeStorage(
  encodedKey: string,
): PilotSafeStorage {
  const key = decodePilotKey(encodedKey);

  return {
    decryptString(encrypted: Buffer): string {
      const minimumLength = FORMAT_HEADER.length + NONCE_BYTES + TAG_BYTES;
      if (
        encrypted.length < minimumLength ||
        !encrypted.subarray(0, FORMAT_HEADER.length).equals(FORMAT_HEADER)
      ) {
        throw new Error("Desktop Pilot credential ciphertext is invalid.");
      }
      const nonceStart = FORMAT_HEADER.length;
      const tagStart = encrypted.length - TAG_BYTES;
      const nonce = encrypted.subarray(nonceStart, nonceStart + NONCE_BYTES);
      const ciphertext = encrypted.subarray(nonceStart + NONCE_BYTES, tagStart);
      const tag = encrypted.subarray(tagStart);
      try {
        const decipher = createDecipheriv(ALGORITHM, key, nonce);
        decipher.setAAD(AUTHENTICATED_CONTEXT);
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("Desktop Pilot credential ciphertext failed authentication.");
      }
    },
    encryptString(plainText: string): Buffer {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, nonce);
      cipher.setAAD(AUTHENTICATED_CONTEXT);
      const ciphertext = Buffer.concat([
        cipher.update(plainText, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([
        FORMAT_HEADER,
        nonce,
        ciphertext,
        cipher.getAuthTag(),
      ]);
    },
    getSelectedStorageBackend: () => "unknown",
    isEncryptionAvailable: () => true,
  };
}

function decodePilotKey(encodedKey: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) {
    throw new Error(
      "SCOPEGUARD_DESKTOP_PILOT_STORAGE_KEY must be a base64url-encoded 32-byte key.",
    );
  }
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      "SCOPEGUARD_DESKTOP_PILOT_STORAGE_KEY must be a base64url-encoded 32-byte key.",
    );
  }
  return key;
}

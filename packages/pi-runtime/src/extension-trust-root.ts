import { SCOPEGUARD_PI_VERSION } from "@scopeguard/domain";

export const TRUSTED_EXTENSION_MANIFEST = {
  schemaVersion: 1,
  piVersion: SCOPEGUARD_PI_VERSION,
  composition: [
    {
      id: "scopeguard-tool-policy",
      role: "policy",
      entrypoint: "approval-extension.js",
    },
  ],
  files: {
    "approval-extension.js": "7a5c202185c5bf01187f1f4f407e4fbcc9d2f6dfd492fb5a196f82f28445dfed",
    "approval-policy.js": "2067ab5020b0ef6860c1712dbc4453a5188c61d58f5459195a93749e614e58a4",
  },
} as const;

export const TRUSTED_EXTENSION_ENTRYPOINT =
  TRUSTED_EXTENSION_MANIFEST.composition[0].entrypoint;

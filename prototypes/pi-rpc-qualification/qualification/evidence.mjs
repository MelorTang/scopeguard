import assert from "node:assert/strict";

export const Classification = Object.freeze({
  EXACT: "exact",
  LOSSY: "lossy",
  UNSUPPORTED: "unsupported",
});

const classifications = new Set(Object.values(Classification));

export class EvidenceRecorder {
  constructor() {
    this.results = [];
  }

  record(name, classification, evidence) {
    assert.ok(
      classifications.has(classification),
      `invalid evidence classification: ${classification}`,
    );
    this.results.push({ name, classification, evidence });
    process.stdout.write(`PASS ${name}: ${evidence}\n`);
  }

  summary(runtime) {
    return {
      ...runtime,
      checks: this.results.length,
      exact: this.results.filter(
        (item) => item.classification === Classification.EXACT,
      ).length,
      lossy: this.results.filter(
        (item) => item.classification === Classification.LOSSY,
      ).length,
      unsupported: this.results.filter(
        (item) => item.classification === Classification.UNSUPPORTED,
      ).length,
      result: "qualification-complete",
    };
  }
}

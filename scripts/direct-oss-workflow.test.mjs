import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  ),
);
test("R2 remains the default and every R2 publication is gated away from OSS", () => {
  assert.equal(
    workflow.on.workflow_call.inputs["storage-provider"].default,
    "r2",
  );
  let publications = 0;
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps || []) {
      if (step.run?.includes("r2-put.mjs") && step.run.includes("$R2_BUCKET")) {
        publications++;
        assert.equal(step.if, "${{ inputs['storage-provider'] == 'r2' }}");
      }
    }
  assert.equal(publications, 3);
});
test("OSS uploads consume signed local files and promotion waits for both platforms", () => {
  for (const [jobName, signStep] of [
    ["publish-macos", "Verify release artifacts (manifest ↔ disk)"],
    ["sign-windows", "Verify signed installer has a certificate table"],
  ]) {
    const steps = workflow.jobs[jobName].steps;
    const uploadIndex = steps.findIndex((step) =>
      step.run?.includes("publish-oss-release.mjs --mode upload"),
    );
    assert.ok(uploadIndex > steps.findIndex((step) => step.name === signStep));
    assert.equal(
      steps[uploadIndex].if,
      "${{ inputs['storage-provider'] == 'oss' }}",
    );
    assert.ok(
      steps.some((step) => step.with?.path?.includes("oss-receipt.json")),
    );
  }
  assert.deepEqual(workflow.jobs.promote.needs, [
    "publish-macos",
    "sign-windows",
  ]);
  assert.ok(
    workflow.jobs.promote.steps.some((step) =>
      step.run?.includes("--mode promote"),
    ),
  );
  assert.ok(workflow.concurrency.group.includes("'oss'"));
});

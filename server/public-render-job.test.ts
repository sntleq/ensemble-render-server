import assert from "node:assert/strict";
import { test } from "node:test";
import { publicRenderJob } from "./public-render-job";

test("render status retains progress and download metadata without exposing source URLs", () => {
  const data = { projectName: "Project", type: "video", format: "mp4", trackItemsMap: { image: { details: { src: "private-signed-source" } } } };
  const job = { status: "completed", progress: 100, videoUrl: "output.mp4", data };
  const result = publicRenderJob(job);
  assert.equal(result.videoUrl, "output.mp4");
  assert.equal(result.progress, 100);
  assert.deepEqual(result.data, { projectName: "Project", type: "video", format: "mp4" });
  assert.equal(JSON.stringify(result).includes("private-signed-source"), false);
  assert.equal(job.data.trackItemsMap.image.details.src, "private-signed-source");
});


test("render failures do not echo private input URLs", () => {
  const job = { status: "failed", error: "Could not fetch private-signed-source", data: { projectName: "Project" } };
  assert.equal(publicRenderJob(job).error, "Render failed.");
});

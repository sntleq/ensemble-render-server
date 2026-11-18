// Source URLs are private render inputs, not part of the progress API.
export function publicRenderJob<T extends { data: { projectName?: string; type?: string; format?: string; portfolioFrameRange?: [number, number] } }>(job: T) {
  const error = "error" in job ? job.error : undefined;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const timedOut = /timed out|Task timed out|TimeoutError/i.test(message);
  return {
    ...job,
    ...("error" in job ? { error: "Render failed." } : {}),
    ...(timedOut ? { errorCode: "RENDER_TIMEOUT" } : {}),
    data: { projectName: job.data.projectName, type: job.data.type, format: job.data.format,
      ...(job.data.portfolioFrameRange ? { portfolioFrameRange: job.data.portfolioFrameRange } : {}) },
  };
}

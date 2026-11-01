// Source URLs are private render inputs, not part of the progress API.
export function publicRenderJob<T extends { data: { projectName?: string; type?: string; format?: string } }>(job: T) {
  return { ...job, ...("error" in job ? { error: "Render failed." } : {}), data: { projectName: job.data.projectName, type: job.data.type, format: job.data.format } };
}

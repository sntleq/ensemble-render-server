import express from "express";
import cors from "cors";
import { makeRenderQueue } from "./render-queue";
import { makeLambdaRenderQueue } from "./lambda-render-queue";
import { getTierForUser, getRenderTarget, checkTierLimits } from "./tiers";
import { bundle } from "@remotion/bundler";
import path from "node:path";
import { ensureBrowser } from "@remotion/renderer";
import { videoEditorSchema } from "../remotion/schema";
import { contentDispositionFor, sanitizeFilename } from "./filename";
import {
  renderThumbnail,
  isInternalSecret,
  THUMBNAIL_KEY_PATTERN,
} from "./thumbnail";

const {
  PORT = 3001,
  REMOTION_SERVE_URL,
  CLIENT_ORIGIN = "http://localhost:3000",
} = process.env;

function setupApp({ remotionBundleUrl }: { remotionBundleUrl: string }) {
  const app = express();

  const rendersDir = path.resolve("renders");

  const queue = makeRenderQueue({
    port: Number(PORT),
    serveUrl: remotionBundleUrl,
    rendersDir,
  });

  const lambdaQueue = makeLambdaRenderQueue();

  app.use(cors({ origin: CLIENT_ORIGIN }));
  app.use(
    "/renders",
    express.static(rendersDir, {
      setHeaders: (res, filePath) => {
        const ext = path.extname(filePath);
        const jobId = path.basename(filePath, ext);
        const job = queue.jobs.get(jobId);
        const projectName =
          job?.status === "completed" ? job.data.projectName : undefined;

        res.setHeader(
          "Content-Disposition",
          contentDispositionFor(projectName ?? jobId, ext),
        );

        if (res.req.method === "GET") {
          res.on("finish", () => {
            queue.deleteJob(jobId).catch((error) => {
              console.error(
                `Failed to delete render output after download for job ${jobId}:`,
                error,
              );
            });
          });
        }
      },
    }),
  );
  app.use(express.json({ limit: "50mb" }));

  app.post("/renders", async (req, res) => {
    const parsed = videoEditorSchema.safeParse(req.body);

    if (!parsed.success) {
      res
        .status(400)
        .json({
          message: "Invalid render payload",
          issues: parsed.error.issues,
        });
      return;
    }

    const userId = req.header("x-user-id");
    if (!userId) {
      res.status(401).json({ message: "Missing user identity" });
      return;
    }

    const existing =
      queue.getActiveJobForUser(userId) ??
      lambdaQueue.getActiveJobForUser(userId);
    if (existing) {
      res.status(409).json({
        message:
          "You already have an export in progress or ready for download.",
        jobId: existing.jobId,
        status: existing.job.status,
      });
      return;
    }

    const tier = getTierForUser(userId);

    const violations = checkTierLimits(parsed.data, tier);
    if (violations.length > 0) {
      res
        .status(403)
        .json({ message: "Render exceeds plan limits", tier, violations });
      return;
    }

    const target = getRenderTarget(parsed.data.type, tier);
    const jobId =
      target === "server"
        ? queue.createJob(parsed.data, userId)
        : lambdaQueue.createJob(parsed.data, tier, userId);

    res.json({ jobId, target });
  });

  app.get("/renders/mine", (req, res) => {
    const userId = req.header("x-user-id");
    if (!userId) {
      res.status(401).json({ message: "Missing user identity" });
      return;
    }

    const existing =
      queue.getActiveJobForUser(userId) ??
      lambdaQueue.getActiveJobForUser(userId);

    if (!existing) {
      res.json({ jobId: null });
      return;
    }

    const { jobId, job } = existing;

    if (job.status === "queued") {
      const inServerQueue = queue.jobs.has(jobId);
      const queuePosition = inServerQueue
        ? queue.getQueuePosition(jobId)
        : lambdaQueue.getQueuePosition(jobId);
      res.json({ jobId, ...job, queuePosition });
      return;
    }

    res.json({ jobId, ...job });
  });

  app.get("/renders/:jobId", (req, res) => {
    const jobId = req.params.jobId;

    const userId = req.header("x-user-id");
    if (!userId) {
      res.status(401).json({ message: "Missing user identity" });
      return;
    }

    const inServerQueue = queue.jobs.has(jobId);
    const job = inServerQueue
      ? queue.jobs.get(jobId)
      : lambdaQueue.jobs.get(jobId);

    // 404 (not 403) for a job that exists but belongs to someone else -
    // don't confirm a jobId is valid to a caller who doesn't own it.
    if (!job || job.userId !== userId) {
      res.status(404).json({ message: "Job not found" });
      return;
    }

    if (job.status === "queued") {
      const queuePosition = inServerQueue
        ? queue.getQueuePosition(jobId)
        : lambdaQueue.getQueuePosition(jobId);
      res.json({ ...job, queuePosition });
      return;
    }

    res.json(job);
  });

  app.delete("/renders/:jobId", async (req, res) => {
    const jobId = req.params.jobId;

    const userId = req.header("x-user-id");
    if (!userId) {
      res.status(401).json({ message: "Missing user identity" });
      return;
    }

    const inServerQueue = queue.jobs.has(jobId);
    const job = inServerQueue
      ? queue.jobs.get(jobId)
      : lambdaQueue.jobs.get(jobId);

    if (!job || job.userId !== userId) {
      res.status(404).json({ message: "Job not found" });
      return;
    }

    const deleted = inServerQueue
      ? await queue.deleteJob(jobId)
      : await lambdaQueue.deleteJob(jobId);

    if (!deleted) {
      res.status(404).json({ message: "Job not found" });
      return;
    }

    res.json({ message: "Job deleted" });
  });

  // Server-to-server only (the editor's collab server). No user identity, no
  // per-user queue, no tier limits.
  app.post("/thumbnails", async (req, res) => {
    if (!isInternalSecret(req.header("x-internal-secret"))) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const { payload, outKey } = req.body ?? {};

    if (typeof outKey !== "string" || !THUMBNAIL_KEY_PATTERN.test(outKey)) {
      res.status(400).json({ message: "Invalid outKey" });
      return;
    }

    const parsed = videoEditorSchema.safeParse(payload);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          message: "Invalid thumbnail payload",
          issues: parsed.error.issues,
        });
      return;
    }

    try {
      const result = await renderThumbnail(parsed.data, outKey);
      res.json(result);
    } catch (error) {
      console.error("Thumbnail render failed:", error);
      res.status(502).json({ message: "Thumbnail render failed" });
    }
  });

  const shutdown = (signal: string) => {
    console.info(`Received ${signal}, shutting down.`);
    queue.stopExpirySweep();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return app;
}

async function main() {
  await ensureBrowser();

  const remotionBundleUrl = REMOTION_SERVE_URL
    ? REMOTION_SERVE_URL
    : await bundle({
        entryPoint: path.resolve("remotion/index.ts"),
        onProgress(progress) {
          console.info(`Bundling Remotion project: ${progress}%`);
        },
      });

  const app = setupApp({ remotionBundleUrl });

  app.listen(PORT, () => {
    console.info(`Server is running on port ${PORT}`);
  });
}

main();

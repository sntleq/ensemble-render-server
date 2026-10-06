import {
  makeCancelSignal,
  renderMedia,
  renderStill,
  renderFrames,
  selectComposition,
} from "@remotion/renderer";
import type { Codec } from "@remotion/renderer";
import {
  renderMediaOnLambda,
  getRenderProgress,
} from "@remotion/lambda/client";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { ZipArchive } from "archiver";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { VideoEditorSchemaProps } from "../remotion/schema";
import { asciiFileName } from "./filename";

type JobData = VideoEditorSchemaProps;

type JobState =
  | {
      status: "queued";
      data: JobData;
      userId: string;
      createdAt: number;
      cancel: () => void;
    }
  | {
      status: "in-progress";
      progress: number;
      data: JobData;
      userId: string;
      createdAt: number;
      cancel: () => void;
    }
  | {
      status: "completed";
      videoUrl: string;
      data: JobData;
      userId: string;
      createdAt: number;
      completedAt: number;
      renderedVia: "local";
      outputPath: string;
    }
  | {
      status: "completed";
      videoUrl: string;
      data: JobData;
      userId: string;
      createdAt: number;
      completedAt: number;
      renderedVia: "lambda-overflow";
      s3Key: string;
    }
  | {
      status: "failed";
      error: Error;
      data: JobData;
      userId: string;
      createdAt: number;
    };

const compositionId = "VideoEditor";

// video/audio containers -> Remotion codec + output file extension (local render)
const MEDIA_FORMAT_MAP: Record<string, { codec: Codec; ext: string }> = {
  mp4: { codec: "h264", ext: "mp4" },
  mov: { codec: "prores", ext: "mov" },
  mkv: { codec: "h264-mkv", ext: "mkv" },
  gif: { codec: "gif", ext: "gif" },
  mp3: { codec: "mp3", ext: "mp3" },
  wav: { codec: "wav", ext: "wav" },
  aac: { codec: "aac", ext: "aac" },
};

// still-image formats -> Remotion imageFormat (shared by "image" and "image-sequence" types)
const STILL_FORMAT_MAP: Record<string, "png" | "jpeg"> = {
  png: "png",
  jpeg: "jpeg",
};

// video-only codec map for the lambda overflow path - overflow never handles
// audio/stills, those always go to the stillsAudio lane in lambda-render-queue.ts
const LAMBDA_MEDIA_CODEC_MAP: Record<
  string,
  Parameters<typeof renderMediaOnLambda>[0]["codec"]
> = {
  mp4: "h264",
  mov: "prores",
  mkv: "h264",
  gif: "gif",
};

const zipDirectory = (
  sourceDir: string,
  outputZipPath: string,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputZipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", (err: Error) => reject(err));
    archive.on("error", (err: Error) => reject(err));

    archive.pipe(output);
    // `false` = don't nest files under a subfolder, put them at the zip root
    archive.directory(sourceDir, false);
    archive.finalize();
  });
};

const DOWNLOAD_GRACE_MS = 10 * 60 * 1000;

export const makeRenderQueue = ({
  port,
  serveUrl,
  rendersDir,
}: {
  port: number;
  serveUrl: string;
  rendersDir: string;
}) => {
  const jobs = new Map<string, JobState>();
  const cancelledJobIds = new Set<string>(); // local renders - cancelSignal race guard
  const cancelledOverflowJobIds = new Set<string>(); // lambda overflow renders - best effort only

  const MAX_LOCAL_JOBS = 4;
  const PER_JOB_CONCURRENCY = 2;

  const MAX_OVERFLOW_JOBS = 16; // lambda, video only
  const OVERFLOW_LAMBDA_COUNT = 2; // + 1 orchestrator = 3 per render

  const {
    REMOTION_AWS_REGION,
    REMOTION_LAMBDA_SERVE_URL,
    REMOTION_LAMBDA_FUNCTION_NAME,
    OUTPUT_BUCKET_NAME,
    CLOUDFRONT_DOMAIN,
  } = process.env;

  const publicBaseUrl =
    process.env.RENDER_SERVER_URL ?? `http://localhost:${port}`;

  const missingOverflowEnv = [
    ["REMOTION_AWS_REGION", REMOTION_AWS_REGION],
    ["REMOTION_LAMBDA_SERVE_URL", REMOTION_LAMBDA_SERVE_URL],
    ["REMOTION_LAMBDA_FUNCTION_NAME", REMOTION_LAMBDA_FUNCTION_NAME],
    ["OUTPUT_BUCKET_NAME", OUTPUT_BUCKET_NAME],
    ["CLOUDFRONT_DOMAIN", CLOUDFRONT_DOMAIN],
  ].filter(([, v]) => !v);
  if (missingOverflowEnv.length > 0) {
    throw new Error(
      `Missing lambda overflow env vars: ${missingOverflowEnv.map(([n]) => n).join(", ")}`,
    );
  }

  const overflowRegion = REMOTION_AWS_REGION as Parameters<
    typeof renderMediaOnLambda
  >[0]["region"];
  const overflowFunctionName = REMOTION_LAMBDA_FUNCTION_NAME as string;
  const overflowServeUrl = REMOTION_LAMBDA_SERVE_URL as string;
  const overflowBucketName = OUTPUT_BUCKET_NAME as string;
  const overflowCdnUrl = (key: string) => `${CLOUDFRONT_DOMAIN}/${key}`;

  const s3 = new S3Client({
    region: overflowRegion,
    credentials: {
      accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY as string,
    },
  });

  const rendersDirPath = rendersDir;

  const pendingJobIds: string[] = [];
  let activeLocalCount = 0;
  let activeOverflowCount = 0;

  // only free-tier video ever reaches this queue as type "video" - image
  // (any tier) and image-sequence (any tier) can't be chunked/rendered via
  // lambda at all, so they never overflow, only ever wait for a local slot
  const canOverflow = (data: JobData) => data.type === "video";

  const runNext = () => {
    for (let i = 0; i < pendingJobIds.length; i++) {
      const jobId = pendingJobIds[i];
      const job = jobs.get(jobId);
      if (!job) {
        pendingJobIds.splice(i, 1);
        i--;
        continue;
      }

      const hasLocalSlot = activeLocalCount < MAX_LOCAL_JOBS;
      const hasOverflowSlot =
        canOverflow(job.data) && activeOverflowCount < MAX_OVERFLOW_JOBS;

      if (!hasLocalSlot && !hasOverflowSlot) continue;

      pendingJobIds.splice(i, 1);
      i--;

      if (hasLocalSlot) {
        activeLocalCount++;
        processLocalRender(jobId)
          .catch((error) =>
            console.error(`Unhandled error processing job ${jobId}:`, error),
          )
          .finally(() => {
            activeLocalCount--;
            runNext();
          });
      } else {
        activeOverflowCount++;
        processOverflowRender(jobId)
          .catch((error) =>
            console.error(
              `Unhandled error processing overflow job ${jobId}:`,
              error,
            ),
          )
          .finally(() => {
            activeOverflowCount--;
            runNext();
          });
      }
    }
  };

  function createJob(data: JobData, userId: string) {
    const jobId = randomUUID();
    const createdAt = Date.now();

    jobs.set(jobId, {
      status: "queued",
      data,
      userId,
      createdAt,
      cancel: () => {
        const idx = pendingJobIds.indexOf(jobId);
        if (idx !== -1) pendingJobIds.splice(idx, 1);
        console.info(`Render ${jobId} was cancelled.`);
        jobs.delete(jobId);
      },
    });

    pendingJobIds.push(jobId);
    runNext();

    return jobId;
  }

  const getQueuePosition = (
    jobId: string,
  ): { position: number; total: number } | null => {
    const index = pendingJobIds.indexOf(jobId);
    if (index === -1) return null;
    return { position: index + 1, total: pendingJobIds.length };
  };

  // "Active" = still holds the user's one-export-at-a-time slot: queued,
  // rendering, or completed but not yet downloaded (download deletes the
  // job). Failed jobs don't block - the user needs to be able to retry.
  const getActiveJobForUser = (
    userId: string,
  ): { jobId: string; job: JobState } | null => {
    for (const [jobId, job] of jobs.entries()) {
      if (job.userId !== userId) continue;
      if (
        job.status === "queued" ||
        job.status === "in-progress" ||
        job.status === "completed"
      ) {
        return { jobId, job };
      }
    }
    return null;
  };

  // === local rendering: image, image-sequence, video (free), audio ===

  const processLocalRender = async (jobId: string) => {
    const job = jobs.get(jobId);
    if (!job) return;

    const { cancel, cancelSignal } = makeCancelSignal();

    const cancelHandler = () => {
      cancelledJobIds.add(jobId);
      cancel();
    };

    jobs.set(jobId, {
      progress: 0,
      status: "in-progress",
      cancel: cancelHandler,
      data: job.data,
      userId: job.userId,
      createdAt: job.createdAt,
    });

    const inputProps = job.data;
    let expectedOutputPaths: string[] = [];

    try {
      const composition = await selectComposition({
        serveUrl,
        id: compositionId,
        inputProps,
      });

      if (job.data.type === "image") {
        const imageFormat = STILL_FORMAT_MAP[job.data.format];
        if (!imageFormat) {
          throw new Error(
            `Unsupported image format for stills: ${job.data.format}`,
          );
        }

        const frame = Math.round(
          ((job.data.currentTime ?? 0) / 1000) * job.data.fps,
        );
        const outputPath = path.join(
          rendersDirPath,
          `${jobId}.${job.data.format}`,
        );
        expectedOutputPaths = [outputPath];

        await renderStill({
          serveUrl,
          composition,
          inputProps,
          imageFormat,
          frame,
          output: outputPath,
          cancelSignal,
          onBrowserLog: (info) => {
            console.log(`[browser] ${info.type}: ${info.text}`);
          },
        });

        if (await handleIfCancelled(jobId, expectedOutputPaths)) return;

        jobs.set(jobId, {
          status: "completed",
          videoUrl: `${publicBaseUrl}/renders/${jobId}.${job.data.format}`,
          data: job.data,
          renderedVia: "local",
          outputPath,
          completedAt: Date.now(),
          userId: job.userId,
          createdAt: job.createdAt,
        });
        return;
      }

      if (job.data.type === "image-sequence") {
        const imageFormat = STILL_FORMAT_MAP[job.data.format];
        if (!imageFormat) {
          throw new Error(
            `Unsupported image format for image sequences: ${job.data.format}`,
          );
        }

        const framesDir = path.join(rendersDirPath, `${jobId}-frames`);
        const zipPath = path.join(rendersDirPath, `${jobId}.zip`);
        expectedOutputPaths = [framesDir, zipPath];

        await fs.mkdir(framesDir, { recursive: true });

        const totalFrames = composition.durationInFrames || 1;

        await renderFrames({
          serveUrl,
          composition,
          inputProps,
          outputDir: framesDir,
          imageFormat,
          imageSequencePattern: "[frame].[ext]",
          cancelSignal,
          onStart: () => {
            console.info(`${jobId} frame render starting`);
          },
          onFrameUpdate: (framesRendered) => {
            const progress = framesRendered / totalFrames;
            console.info(`${jobId} render progress:`, progress);
            jobs.set(jobId, {
              progress,
              status: "in-progress",
              cancel: cancelHandler,
              data: job.data,
              userId: job.userId,
              createdAt: job.createdAt,
            });
          },
          onBrowserLog: (info) => {
            console.log(`[browser] ${info.type}: ${info.text}`);
          },
          concurrency: PER_JOB_CONCURRENCY,
        });

        if (await handleIfCancelled(jobId, expectedOutputPaths)) return;

        await zipDirectory(framesDir, zipPath);
        await fs
          .rm(framesDir, { recursive: true, force: true })
          .catch(() => {});

        if (await handleIfCancelled(jobId, [zipPath])) return;

        jobs.set(jobId, {
          status: "completed",
          videoUrl: `${publicBaseUrl}/renders/${jobId}.zip`,
          data: job.data,
          renderedVia: "local",
          outputPath: zipPath,
          completedAt: Date.now(),
          userId: job.userId,
          createdAt: job.createdAt,
        });
        return;
      }

      const mediaFormat = MEDIA_FORMAT_MAP[job.data.format];
      if (!mediaFormat) {
        throw new Error(
          `Unsupported format for media render: ${job.data.format}`,
        );
      }

      const shorterDimension = Math.min(
        job.data.size.width,
        job.data.size.height,
      );
      const scale = job.data.resolution / shorterDimension;

      type FfmpegBitrate = `${number}k` | `${number}K` | `${number}M`;

      const toFfmpegBitrate = (
        kbps: number | null | undefined,
      ): FfmpegBitrate | undefined => {
        if (kbps == null) return undefined;
        return `${kbps}k`;
      };
      const bitrateArg = toFfmpegBitrate(job.data.bitrate);

      const isGif = mediaFormat.codec === "gif";
      const outputPath = path.join(
        rendersDirPath,
        `${jobId}.${mediaFormat.ext}`,
      );
      expectedOutputPaths = [outputPath];

      await renderMedia({
        cancelSignal,
        serveUrl,
        composition,
        inputProps,
        codec: mediaFormat.codec,
        scale: job.data.type === "video" ? scale : undefined,
        videoBitrate:
          job.data.type === "video" && !isGif ? bitrateArg : undefined,
        audioBitrate: job.data.type === "audio" ? bitrateArg : undefined,
        audioCodec: mediaFormat.codec === "h264-mkv" ? "mp3" : undefined,
        onProgress: (progress) => {
          console.info(`${jobId} render progress:`, progress.progress);
          jobs.set(jobId, {
            progress: progress.progress,
            status: "in-progress",
            cancel: cancelHandler,
            data: job.data,
            userId: job.userId,
            createdAt: job.createdAt,
          });
        },
        outputLocation: outputPath,
        onBrowserLog: (info) => {
          console.log(`[browser] ${info.type}: ${info.text}`);
        },
        concurrency: PER_JOB_CONCURRENCY,
      });

      if (await handleIfCancelled(jobId, expectedOutputPaths)) return;

      jobs.set(jobId, {
        status: "completed",
        videoUrl: `${publicBaseUrl}/renders/${jobId}.${mediaFormat.ext}`,
        data: job.data,
        renderedVia: "local",
        outputPath,
        completedAt: Date.now(),
        userId: job.userId,
        createdAt: job.createdAt,
      });
    } catch (error) {
      if (await handleIfCancelled(jobId, expectedOutputPaths)) return;

      console.error(error);
      jobs.set(jobId, {
        status: "failed",
        error: error as Error,
        data: job.data,
        userId: job.userId,
        createdAt: job.createdAt,
      });
    }
  };

  // === lambda overflow rendering: free-tier video only, when local is full ===

  const processOverflowRender = async (jobId: string) => {
    const job = jobs.get(jobId);
    if (!job || job.data.type !== "video") return;

    const data = job.data;
    const codec = LAMBDA_MEDIA_CODEC_MAP[data.format];
    if (!codec) {
      jobs.set(jobId, {
        status: "failed",
        error: new Error(
          `Unsupported format for overflow render: ${data.format}`,
        ),
        data,
        userId: job.userId,
        createdAt: job.createdAt,
      });
      return;
    }

    jobs.set(jobId, {
      status: "in-progress",
      progress: 0,
      data,
      cancel: () => cancelledOverflowJobIds.add(jobId),
      userId: job.userId,
      createdAt: job.createdAt,
    });

    const outKey = `renders/${jobId}.${data.format}`;
    const shorterDimension = Math.min(data.size.width, data.size.height);
    const scale = data.resolution / shorterDimension;
    const bitrateArg =
      data.bitrate != null ? (`${data.bitrate}k` as const) : undefined;

    try {
      const { renderId, bucketName: siteBucketName } =
        await renderMediaOnLambda({
          region: overflowRegion,
          functionName: overflowFunctionName,
          serveUrl: overflowServeUrl,
          composition: "VideoEditor",
          inputProps: data,
          codec,
          scale,
          videoBitrate: codec !== "gif" ? bitrateArg : undefined,
          concurrency: OVERFLOW_LAMBDA_COUNT,
          privacy: "no-acl",
          outName: { bucketName: overflowBucketName, key: outKey },
          downloadBehavior: {
            type: "download",
            fileName: `${asciiFileName(data.projectName)}.${data.format}`,
          },
        });

      while (true) {
        if (cancelledOverflowJobIds.has(jobId)) {
          cancelledOverflowJobIds.delete(jobId);
          jobs.delete(jobId);
          return;
        }

        const progress = await getRenderProgress({
          renderId,
          bucketName: siteBucketName,
          functionName: overflowFunctionName,
          region: overflowRegion,
        });

        if (progress.fatalErrorEncountered) {
          jobs.set(jobId, {
            status: "failed",
            error: new Error(
              progress.errors[0]?.message ?? "Lambda overflow render failed",
            ),
            data,
            userId: job.userId,
            createdAt: job.createdAt,
          });
          return;
        }

        if (progress.done) {
          jobs.set(jobId, {
            status: "completed",
            videoUrl: overflowCdnUrl(outKey),
            data,
            renderedVia: "lambda-overflow",
            s3Key: outKey,
            completedAt: Date.now(),
            userId: job.userId,
            createdAt: job.createdAt,
          });
          return;
        }

        jobs.set(jobId, {
          status: "in-progress",
          progress: progress.overallProgress,
          data,
          cancel: () => cancelledOverflowJobIds.add(jobId),
          userId: job.userId,
          createdAt: job.createdAt,
        });

        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch (error) {
      if (cancelledOverflowJobIds.has(jobId)) {
        cancelledOverflowJobIds.delete(jobId);
        jobs.delete(jobId);
        return;
      }
      jobs.set(jobId, {
        status: "failed",
        error: error as Error,
        data,
        userId: job.userId,
        createdAt: job.createdAt,
      });
    }
  };

  const deleteJob = async (jobId: string): Promise<boolean> => {
    const job = jobs.get(jobId);
    if (!job) return false;

    if (job.status === "queued" || job.status === "in-progress") {
      job.cancel();
      return true;
    }

    if (job.status === "completed") {
      if (job.renderedVia === "local") {
        await fs
          .rm(job.outputPath, { recursive: true, force: true })
          .catch(() => {});
      } else {
        const key = job.s3Key;
        // the browser downloads straight from CloudFront, so give its GET time to finish
        setTimeout(() => {
          s3.send(
            new DeleteObjectCommand({ Bucket: overflowBucketName, Key: key }),
          ).catch((error) =>
            console.error(
              `Failed to delete S3 object for overflow job ${jobId}:`,
              error,
            ),
          );
        }, DOWNLOAD_GRACE_MS);
      }
    }

    jobs.delete(jobId);
    return true;
  };

  // Checks whether a job was cancelled mid-render. If so, cleans up any
  // partial output and removes the job from the map. Call this right after
  // any local render call resolves, BEFORE marking the job "completed" -
  // Remotion's cancelSignal doesn't guarantee the render promise rejects in
  // every case, so without this check a cancelled job can still race its
  // way to "completed".
  const handleIfCancelled = async (
    jobId: string,
    cleanupPaths: string[] = [],
  ): Promise<boolean> => {
    if (!cancelledJobIds.has(jobId)) return false;

    cancelledJobIds.delete(jobId);
    console.info(`Render ${jobId} was cancelled.`);

    for (const p of cleanupPaths) {
      await fs.rm(p, { recursive: true, force: true }).catch(() => {});
    }

    jobs.delete(jobId);
    return true;
  };

  const RENDER_TTL_MS = 1000 * 60 * 60 * 3; // render expiry: 3 hrs

  const startExpirySweep = (intervalMs = 1000 * 60 * 15) => {
    const sweep = async () => {
      const now = Date.now();

      for (const [jobId, job] of jobs.entries()) {
        if (
          job.status === "completed" &&
          now - job.completedAt > RENDER_TTL_MS
        ) {
          if (job.renderedVia === "local") {
            await fs
              .rm(job.outputPath, { recursive: true, force: true })
              .catch(() => {});
          } else {
            await s3
              .send(
                new DeleteObjectCommand({
                  Bucket: overflowBucketName,
                  Key: job.s3Key,
                }),
              )
              .catch(() => {});
          }
          jobs.delete(jobId);
        }
      }

      try {
        const entries = await fs.readdir(rendersDirPath);
        for (const entry of entries) {
          const entryPath = path.join(rendersDirPath, entry);
          const stat = await fs.stat(entryPath).catch(() => null);
          if (stat && now - stat.mtimeMs > RENDER_TTL_MS) {
            await fs
              .rm(entryPath, { recursive: true, force: true })
              .catch(() => {});
          }
        }
      } catch (error) {
        console.error("Expiry sweep failed to read renders dir:", error);
      }
    };

    sweep().catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("Expiry sweep failed to read renders dir:", error);
      }
    });

    return setInterval(
      () =>
        sweep().catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error("Expiry sweep failed to read renders dir:", error);
          }
        }),
      intervalMs,
    );
  };

  const sweepInterval = startExpirySweep();

  return {
    jobs,
    createJob,
    getQueuePosition,
    getActiveJobForUser,
    deleteJob,
    stopExpirySweep: () => clearInterval(sweepInterval),
  };
};

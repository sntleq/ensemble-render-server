import {
  renderMediaOnLambda,
  renderStillOnLambda,
  getRenderProgress,
} from "@remotion/lambda/client";
import { randomUUID } from "node:crypto";
import type { VideoEditorSchemaProps } from "../remotion/schema";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Tier } from "./tiers";
import { asciiFileName } from "./filename";

type JobData = VideoEditorSchemaProps;

type LambdaRegion = Parameters<typeof renderMediaOnLambda>[0]["region"];
type LambdaCodec = Parameters<typeof renderMediaOnLambda>[0]["codec"];

type JobState =
  | {
      status: "queued";
      data: JobData;
      userId: string;
      createdAt: number;
      tier: Tier;
      cancel: () => void;
    }
  | {
      status: "in-progress";
      progress: number;
      data: JobData;
      userId: string;
      createdAt: number;
      tier: Tier;
      cancel: () => void;
    }
  | {
      status: "completed";
      videoUrl: string;
      data: JobData;
      userId: string;
      createdAt: number;
      tier: Tier;
      key: string;
      completedAt: number;
    }
  | {
      status: "failed";
      error: Error;
      data: JobData;
      userId: string;
      createdAt: number;
      tier: Tier;
    };

const {
  REMOTION_AWS_REGION,
  REMOTION_LAMBDA_SERVE_URL,
  REMOTION_LAMBDA_FUNCTION_NAME,
  OUTPUT_BUCKET_NAME,
  CLOUDFRONT_DOMAIN,
} = process.env;

const MEDIA_CODEC_MAP: Record<string, LambdaCodec> = {
  mp4: "h264",
  mov: "prores",
  mkv: "h264",
  gif: "gif",
  mp3: "mp3",
  wav: "wav",
  aac: "aac",
};
const STILL_FORMAT_MAP: Record<string, "png" | "jpeg"> = {
  png: "png",
  jpeg: "jpeg",
};

type Lane = "stillsAudio" | "proBusiness";

const getLane = (data: JobData): Lane =>
  data.type === "image" || data.type === "audio"
    ? "stillsAudio"
    : "proBusiness";

// Worker concurrency per video tier (+1 orchestrator invocation each, added
// automatically by renderMediaOnLambda - not part of the concurrency count)
const VIDEO_WORKER_CONCURRENCY: Record<"pro" | "business", number> = {
  pro: 21, // 21 + 1 = 22 invocations per render
  business: 40, // 40 + 1 = 41 invocations per render
};

// Invocation cost per render, used against each lane's budget below.
// image: single renderStillOnLambda call, no chunking = 1
// audio: concurrency:1 + 1 orchestrator = 2
// video: tier-based worker count + 1 orchestrator (see VIDEO_WORKER_CONCURRENCY)
const invocationCost = (data: JobData, tier: Tier): number => {
  if (data.type === "audio") return 2;
  if (data.type === "image") return 1;
  const workers =
    VIDEO_WORKER_CONCURRENCY[tier as "pro" | "business"] ??
    VIDEO_WORKER_CONCURRENCY.pro;
  return workers + 1;
};

// Both lanes draw from the same 1000-invocation AWS account limit, reserved
// as fixed budgets: stillsAudio gets 50, proBusiness gets the remaining 902
// (free-overflow, handled entirely in render-queue.ts, reserves the other 48)
const LANE_INVOCATION_BUDGET: Record<Lane, number> = {
  stillsAudio: 50,
  proBusiness: 902,
};

const DOWNLOAD_GRACE_MS = 10 * 60 * 1000;

export const makeLambdaRenderQueue = () => {
  const missing = [
    ["REMOTION_AWS_REGION", REMOTION_AWS_REGION],
    ["REMOTION_LAMBDA_SERVE_URL", REMOTION_LAMBDA_SERVE_URL],
    ["REMOTION_LAMBDA_FUNCTION_NAME", REMOTION_LAMBDA_FUNCTION_NAME],
    ["OUTPUT_BUCKET_NAME", OUTPUT_BUCKET_NAME],
    ["CLOUDFRONT_DOMAIN", CLOUDFRONT_DOMAIN],
  ].filter(([, v]) => !v);
  if (missing.length > 0) {
    throw new Error(
      `Missing lambda env vars: ${missing.map(([n]) => n).join(", ")}`,
    );
  }

  const region = REMOTION_AWS_REGION as LambdaRegion;
  const functionName = REMOTION_LAMBDA_FUNCTION_NAME as string;
  const serveUrl = REMOTION_LAMBDA_SERVE_URL as string;
  const bucketName = OUTPUT_BUCKET_NAME as string;
  const cdnUrl = (key: string) => `${CLOUDFRONT_DOMAIN}/${key}`;

  const jobs = new Map<string, JobState>();
  // Lambda has no cancel API once chunks are invoked (see caveat below) -
  // this just stops the app from tracking/reporting on a job after cancel.
  const cancelledJobIds = new Set<string>();

  const activeInvocations: Record<Lane, number> = {
    stillsAudio: 0,
    proBusiness: 0,
  };

  const pendingJobIds: string[] = [];

  const canAdmit = (data: JobData, tier: Tier): boolean => {
    const lane = getLane(data);
    return (
      activeInvocations[lane] + invocationCost(data, tier) <=
      LANE_INVOCATION_BUDGET[lane]
    );
  };

  const runNext = () => {
    for (let i = 0; i < pendingJobIds.length; i++) {
      const jobId = pendingJobIds[i];
      const job = jobs.get(jobId);
      if (!job) {
        pendingJobIds.splice(i, 1);
        i--;
        continue;
      }

      if (!canAdmit(job.data, job.tier)) continue;

      pendingJobIds.splice(i, 1);
      i--;

      const lane = getLane(job.data);
      const cost = invocationCost(job.data, job.tier);
      activeInvocations[lane] += cost;

      const start =
        job.data.type === "image"
          ? startStillRender(
              jobId,
              job.data,
              job.userId,
              job.createdAt,
              job.tier,
            )
          : startMediaRender(
              jobId,
              job.data,
              job.userId,
              job.createdAt,
              job.tier,
            );
      start
        .catch((error) =>
          jobs.set(jobId, {
            status: "failed",
            error,
            data: job.data,
            tier: job.tier,
            userId: job.userId,
            createdAt: job.createdAt,
          }),
        )
        .finally(() => {
          activeInvocations[lane] -= cost;
          runNext();
        });
    }
  };

  function createJob(data: JobData, tier: Tier, userId: string): string {
    const jobId = randomUUID();
    const createdAt = Date.now();
    jobs.set(jobId, {
      status: "queued",
      data,
      tier,
      userId,
      createdAt,
      cancel: () => {
        const idx = pendingJobIds.indexOf(jobId);
        if (idx !== -1) pendingJobIds.splice(idx, 1);
        jobs.delete(jobId);
      },
    });
    pendingJobIds.push(jobId);
    runNext();
    return jobId;
  }

  // scoped to the job's own lane so position/total don't mix stillsAudio
  // and proBusiness counts when both have queued jobs
  const getQueuePosition = (
    jobId: string,
  ): { position: number; total: number } | null => {
    const job = jobs.get(jobId);
    if (!job) return null;

    const lane = getLane(job.data);
    const laneJobIds = pendingJobIds.filter((id) => {
      const j = jobs.get(id);
      return j && getLane(j.data) === lane;
    });

    const index = laneJobIds.indexOf(jobId);
    if (index === -1) return null;
    return { position: index + 1, total: laneJobIds.length };
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

  const startMediaRender = async (
    jobId: string,
    data: JobData,
    userId: string,
    createdAt: number,
    tier: Tier,
  ) => {
    const codec = MEDIA_CODEC_MAP[data.format];
    if (!codec)
      throw new Error(
        `Unsupported format for lambda media render: ${data.format}`,
      );

    const outKey = `renders/${jobId}.${data.format}`;
    const shorterDimension = Math.min(data.size.width, data.size.height);
    const scale = data.resolution / shorterDimension;
    const bitrateArg =
      data.bitrate != null ? (`${data.bitrate}k` as const) : undefined;
    const concurrency =
      data.type === "audio"
        ? 1
        : (VIDEO_WORKER_CONCURRENCY[tier as "pro" | "business"] ??
          VIDEO_WORKER_CONCURRENCY.pro);

    const { renderId, bucketName: siteBucketName } = await renderMediaOnLambda({
      region,
      functionName,
      serveUrl,
      composition: "VideoEditor",
      inputProps: data,
      codec,
      scale: data.type === "video" ? scale : undefined,
      videoBitrate:
        data.type === "video" && codec !== "gif" ? bitrateArg : undefined,
      audioBitrate: data.type === "audio" ? bitrateArg : undefined,
      concurrency,
      privacy: "no-acl",
      outName: { bucketName, key: outKey },
      downloadBehavior: {
        type: "download",
        fileName: `${asciiFileName(data.projectName)}.${data.format}`,
      },
    });

    jobs.set(jobId, {
      status: "in-progress",
      progress: 0,
      data,
      tier,
      cancel: () => cancelledJobIds.add(jobId),
      userId: userId,
      createdAt: createdAt,
    });
    pollUntilDone(
      jobId,
      renderId,
      siteBucketName,
      outKey,
      data,
      userId,
      createdAt,
      tier,
    ).catch((error) => {
      jobs.set(jobId, {
        status: "failed",
        error,
        data,
        tier,
        userId: userId,
        createdAt: createdAt,
      });
    });
  };

  const startStillRender = async (
    jobId: string,
    data: JobData,
    userId: string,
    createdAt: number,
    tier: Tier,
  ) => {
    const imageFormat = STILL_FORMAT_MAP[data.format];
    if (!imageFormat)
      throw new Error(
        `Unsupported image format for lambda still: ${data.format}`,
      );

    const outKey = `renders/${jobId}.${data.format}`;
    const frame = Math.round(((data.currentTime ?? 0) / 1000) * data.fps);

    jobs.set(jobId, {
      status: "in-progress",
      progress: 0,
      data,
      tier,
      cancel: () => cancelledJobIds.add(jobId),
      userId: userId,
      createdAt: createdAt,
    });

    await renderStillOnLambda({
      region,
      functionName,
      serveUrl,
      composition: "VideoEditor",
      inputProps: data,
      imageFormat,
      frame,
      privacy: "no-acl",
      outName: { bucketName, key: outKey },
      downloadBehavior: {
        type: "download",
        fileName: `${asciiFileName(data.projectName)}.${data.format}`,
      },
    });

    if (cancelledJobIds.has(jobId)) {
      cancelledJobIds.delete(jobId);
      jobs.delete(jobId);
      return;
    }

    jobs.set(jobId, {
      status: "completed",
      videoUrl: cdnUrl(outKey),
      data,
      tier,
      key: outKey,
      completedAt: Date.now(),
      userId: userId,
      createdAt: createdAt,
    });
  };

  const pollUntilDone = async (
    jobId: string,
    renderId: string,
    siteBucketName: string,
    outKey: string,
    data: JobData,
    userId: string,
    createdAt: number,
    tier: Tier,
  ) => {
    while (true) {
      if (cancelledJobIds.has(jobId)) {
        cancelledJobIds.delete(jobId);
        jobs.delete(jobId);
        return;
      }

      const progress = await getRenderProgress({
        renderId,
        bucketName: siteBucketName,
        functionName,
        region,
      });

      if (progress.fatalErrorEncountered) {
        console.error(
          `Lambda render ${renderId} failed:`,
          JSON.stringify(progress.errors, null, 2),
        );
        jobs.set(jobId, {
          status: "failed",
          error: new Error(
            progress.errors[0]?.message ?? "Lambda render failed",
          ),
          data,
          tier,
          userId: userId,
          createdAt: createdAt,
        });
        return;
      }

      if (progress.done) {
        jobs.set(jobId, {
          status: "completed",
          videoUrl: cdnUrl(outKey),
          data,
          tier,
          key: outKey,
          completedAt: Date.now(),
          userId: userId,
          createdAt: createdAt,
        });
        return;
      }

      jobs.set(jobId, {
        status: "in-progress",
        progress: progress.overallProgress,
        data,
        tier,
        cancel: () => cancelledJobIds.add(jobId),
        userId: userId,
        createdAt: createdAt,
      });

      await new Promise((r) => setTimeout(r, 1200));
    }
  };

  const s3 = new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY as string,
    },
  });

  const deleteJob = async (jobId: string): Promise<boolean> => {
    const job = jobs.get(jobId);
    if (!job) return false;

    if (job.status === "queued" || job.status === "in-progress") {
      job.cancel();
      jobs.delete(jobId);
      return true;
    }

    if (job.status === "completed") {
      const key = job.key;
      // slot is freed right away, but the file stays long enough for the browser's GET to finish
      setTimeout(() => {
        s3.send(
          new DeleteObjectCommand({ Bucket: bucketName, Key: key }),
        ).catch((error) =>
          console.error(`Failed to delete S3 object for job ${jobId}:`, error),
        );
      }, DOWNLOAD_GRACE_MS);
    }

    jobs.delete(jobId);
    return true;
  };

  return {
    jobs,
    createJob,
    getQueuePosition,
    getActiveJobForUser,
    deleteJob,
  };
};

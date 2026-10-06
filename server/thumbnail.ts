import { renderStillOnLambda } from "@remotion/lambda/client";
import { timingSafeEqual } from "node:crypto";
import type { VideoEditorSchemaProps } from "../remotion/schema";

type LambdaRegion = Parameters<typeof renderStillOnLambda>[0]["region"];

const {
  REMOTION_AWS_REGION,
  REMOTION_LAMBDA_SERVE_URL,
  REMOTION_LAMBDA_FUNCTION_NAME,
  OUTPUT_BUCKET_NAME,
  INTERNAL_API_SECRET,
} = process.env;

const JPEG_QUALITY = 80;
// Thumbnails run outside the lambda queue's lane accounting, so keep them
// from piling onto Lambda when many rooms empty at once.
const MAX_CONCURRENT = 3;

// Only lets the editor write under thumbnails/<projectId>/<hash>.jpg
export const THUMBNAIL_KEY_PATTERN = /^thumbnails\/[\w-]+\/[0-9a-f]{16}\.jpg$/;

export const isInternalSecret = (provided: string | undefined): boolean => {
  if (!INTERNAL_API_SECRET || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(INTERNAL_API_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
};

let active = 0;
const waiting: Array<() => void> = [];

const acquire = async (): Promise<void> => {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  // the releasing job hands its slot straight to us, so active stays as is
  await new Promise<void>((resolve) => waiting.push(resolve));
};

const release = (): void => {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
};

export async function renderThumbnail(
  data: VideoEditorSchemaProps,
  outKey: string,
): Promise<{ key: string; sizeBytes: number }> {
  const missing = [
    ["REMOTION_AWS_REGION", REMOTION_AWS_REGION],
    ["REMOTION_LAMBDA_SERVE_URL", REMOTION_LAMBDA_SERVE_URL],
    ["REMOTION_LAMBDA_FUNCTION_NAME", REMOTION_LAMBDA_FUNCTION_NAME],
    ["OUTPUT_BUCKET_NAME", OUTPUT_BUCKET_NAME],
  ].filter(([, v]) => !v);
  if (missing.length > 0) {
    throw new Error(
      `Missing lambda env vars: ${missing.map(([n]) => n).join(", ")}`,
    );
  }

  await acquire();
  try {
    const shorterDimension = Math.min(data.size.width, data.size.height);
    // never upscale a composition that's already smaller than the target
    const scale = Math.min(1, data.resolution / shorterDimension);
    const frame = Math.max(
      0,
      Math.round(((data.currentTime ?? 0) / 1000) * data.fps),
    );

    const result = await renderStillOnLambda({
      region: REMOTION_AWS_REGION as LambdaRegion,
      functionName: REMOTION_LAMBDA_FUNCTION_NAME as string,
      serveUrl: REMOTION_LAMBDA_SERVE_URL as string,
      composition: "VideoEditor",
      inputProps: data,
      imageFormat: "jpeg",
      jpegQuality: JPEG_QUALITY,
      scale,
      frame,
      privacy: "no-acl",
      outName: { bucketName: OUTPUT_BUCKET_NAME as string, key: outKey },
      // no downloadBehavior: it should display inline, not force a download
    });

    return { key: outKey, sizeBytes: result.sizeInBytes };
  } finally {
    release();
  }
}
import type { VideoEditorSchemaProps } from "../remotion/schema";
import { readTierExportFeatures } from "./render-settings-repository";

export const TIERS = ["free", "pro", "business"] as const;
export type Tier = (typeof TIERS)[number];

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

export type RenderTarget = "server" | "lambda";

export interface TierLimits {
  maxResolution: number; // matches the schema's `resolution` field (shorter-dimension px)
  maxFps: number;
  videoRenderTarget: RenderTarget;
}

// Routing remains fixed; only quality and frame-rate entitlements come from DB.
const VIDEO_RENDER_TARGET: Record<Tier, RenderTarget> = {
  free: "server",
  pro: "lambda",
  business: "lambda",
};

async function readTierLimits(tier: Tier): Promise<TierLimits> {
  const rows = await readTierExportFeatures(tier);
  if (rows.length !== 2 || new Set(rows.map(row => row.feature_key)).size !== 2) {
    throw new Error("Missing or ambiguous export limits");
  }
  // Match the editor's stored feature formats; these are label conversions,
  // not tier defaults. Missing or invalid settings never grant fallback limits.
  const quality = rows.find(row => row.feature_key === "export_resolution")?.value?.trim().toLowerCase();
  const kResolutions: Record<string, number> = { "2k": 1440, "4k": 2160, "8k": 4320 };
  const resolutionMatch = quality?.match(/^(\d+)\s*p?$/);
  const maxResolution = quality && Object.prototype.hasOwnProperty.call(kResolutions, quality)
    ? kResolutions[quality] : resolutionMatch ? Number(resolutionMatch[1]) : NaN;
  const frameRate = rows.find(row => row.feature_key === "export_frame_rate")?.value;
  const fpsMatch = frameRate?.trim().match(/^(\d+(?:\.\d+)?)\s*(?:fps)?$/i);
  const maxFps = fpsMatch ? Number(fpsMatch[1]) : NaN;
  if (!Number.isSafeInteger(maxResolution) || maxResolution < 2 || !Number.isFinite(maxFps) || maxFps <= 0) {
    throw new Error("Invalid export limits");
  }
  return { maxResolution, maxFps, videoRenderTarget: VIDEO_RENDER_TARGET[tier] };
}

// The editor resolves subscriptions server-side and sends this only over the
// authenticated internal bridge. Missing/invalid entitlements fail closed.
export function parseRenderTier(tier: string | undefined): Tier | null {
  return tier && isTier(tier) ? tier : null;
}

export function getRenderTarget(
  type: VideoEditorSchemaProps["type"],
  tier: Tier,
): RenderTarget {
  if (type === "image-sequence") return "server";
  if (type !== "video") return "lambda";
  return VIDEO_RENDER_TARGET[tier];
}

export async function checkTierLimits(
  data: VideoEditorSchemaProps,
  tier: Tier,
): Promise<string[]> {
  // Re-read on each submission so admin changes require no server restart.
  const limits = await readTierLimits(tier);
  const violations: string[] = [];

  // Audio has no exported image dimensions; match the editor's validation.
  if (data.type !== "audio") {
    if (!Number.isSafeInteger(data.resolution) || data.resolution < 2) {
      violations.push("Invalid export resolution");
    } else if (data.resolution > limits.maxResolution) {
      violations.push(
        `resolution ${data.resolution}p exceeds the ${tier} plan's limit of ${limits.maxResolution}p`,
      );
    }
  }
  if (!Number.isFinite(data.fps) || data.fps <= 0) {
    violations.push("Invalid export frame rate");
  } else if (data.fps > limits.maxFps) {
    violations.push(
      `frame rate ${data.fps}fps exceeds the ${tier} plan's limit of ${limits.maxFps}fps`,
    );
  }

  return violations;
}

import type { VideoEditorSchemaProps } from "../remotion/schema";

export const TIERS = ["free", "pro", "business"] as const;
export type Tier = (typeof TIERS)[number];

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

export type RenderTarget = "server" | "lambda";

export interface TierLimits {
  maxResolution: number; // matches the schema's `resolution` field (shorter-dimension px)
  maxFps: number;
  // only applies to `type: "video"` - image/image-sequence/audio always go
  // to lambda, see getRenderTarget() below
  videoRenderTarget: RenderTarget;
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: {
    maxResolution: 720,
    maxFps: 30,
    videoRenderTarget: "server",
  },
  pro: {
    maxResolution: 1080,
    maxFps: 60,
    videoRenderTarget: "lambda",
  },
  business: {
    maxResolution: 2160,
    maxFps: 60,
    videoRenderTarget: "lambda",
  },
};

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
  return TIER_LIMITS[tier].videoRenderTarget;
}

export function checkTierLimits(
  data: VideoEditorSchemaProps,
  tier: Tier,
): string[] {
  const limits = TIER_LIMITS[tier];
  const violations: string[] = [];

  if (data.resolution && data.resolution > limits.maxResolution) {
    violations.push(
      `resolution ${data.resolution}p exceeds the ${tier} plan's limit of ${limits.maxResolution}p`,
    );
  }
  if (data.fps && data.fps > limits.maxFps) {
    violations.push(
      `frame rate ${data.fps}fps exceeds the ${tier} plan's limit of ${limits.maxFps}fps`,
    );
  }

  return violations;
}

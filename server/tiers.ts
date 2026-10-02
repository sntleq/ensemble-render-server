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
  maxDurationMs: number;
  // only applies to `type: "video"` - image/image-sequence/audio always go
  // to lambda, see getRenderTarget() below
  videoRenderTarget: RenderTarget;
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: {
    maxResolution: 720,
    maxFps: 30,
    maxDurationMs: 20 * 60 * 1000,
    videoRenderTarget: "server",
  },
  pro: {
    maxResolution: 1080,
    maxFps: 60,
    maxDurationMs: 60 * 60 * 1000,
    videoRenderTarget: "lambda",
  },
  business: {
    maxResolution: 2160,
    maxFps: 60,
    maxDurationMs: 2 * 60 * 60 * 1000,
    videoRenderTarget: "lambda",
  },
};

/**
 * TODO: swap for a real entitlement lookup once auth/billing is wired up
 * (e.g. `getPlanForUser(userId)` against your users table or Stripe).
 *
 * Until then, DEBUG_TIER lets you exercise the enforcement + routing logic:
 *
 *   DEBUG_TIER=pro npm run dev
 *
 * No env var set -> falls back to "free". Fails closed, not open - if the
 * lookup isn't wired up yet, better to under-grant than let something
 * past a limit it shouldn't have.
 */
export function getTierForUser(userId: string | undefined): Tier {
  const debugTier = process.env.DEBUG_TIER;

  if (debugTier) {
    if (!isTier(debugTier)) {
      throw new Error(
        `DEBUG_TIER="${debugTier}" is invalid - must be one of: ${TIERS.join(", ")}`
      );
    }
    return debugTier;
  }

  return "free";
}

export function getRenderTarget(
  type: VideoEditorSchemaProps["type"],
  tier: Tier
): RenderTarget {
  if (type === "image-sequence") return "server";
  if (type !== "video") return "lambda";
  return TIER_LIMITS[tier].videoRenderTarget;
}

export function checkTierLimits(
  data: VideoEditorSchemaProps,
  tier: Tier
): string[] {
  const limits = TIER_LIMITS[tier];
  const violations: string[] = [];

  if (data.resolution && data.resolution > limits.maxResolution) {
    violations.push(
      `resolution ${data.resolution}p exceeds the ${tier} plan's limit of ${limits.maxResolution}p`
    );
  }
  if (data.fps && data.fps > limits.maxFps) {
    violations.push(
      `frame rate ${data.fps}fps exceeds the ${tier} plan's limit of ${limits.maxFps}fps`
    );
  }
  if (data.duration && data.duration > limits.maxDurationMs) {
    violations.push(
      `duration exceeds the ${tier} plan's limit of ${Math.round(limits.maxDurationMs / 60_000)} minutes`
    );
  }

  return violations;
}
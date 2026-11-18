import { z } from "zod";
import { videoEditorSchema } from "../remotion/schema";

// Job options are consumed by the render queues, outside the composition.
export const renderJobSchema = videoEditorSchema.extend({
  portfolioFrameRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
}).refine(data => {
  if (!data.portfolioFrameRange) return true;
  const [first, last] = data.portfolioFrameRange;
  return data.type === "video" && data.format === "mp4" && last >= first &&
    last < Math.round(data.duration * data.fps / 1000) + 1;
}, "Invalid portfolio frame range");

export type RenderJobData = z.infer<typeof renderJobSchema>;

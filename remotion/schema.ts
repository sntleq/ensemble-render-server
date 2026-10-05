import { z } from "zod";

export const sizeSchema = z.object({
  width: z.number(),
  height: z.number()
});

export const backgroundSchema = z.object({
  type: z.enum(["color", "image"]),
  value: z.string()
});

export const exportTypeSchema =
  z.enum(["video", "audio", "image", "image-sequence"]);
export const exportFormatSchema =
  z.enum(["mp4", "mov", "mkv", "gif", "png", "jpeg", "mp3", "wav", "aac"]);

export const videoEditorSchema = z.object({
  id: z.string(),
  trackItemIds: z.array(z.string()),
  trackItemsMap: z.record(z.string(), z.any()),
  transitionsMap: z.record(z.string(), z.any()),
  fps: z.number(),
  size: sizeSchema,
  duration: z.number(),
  projectName: z.string(),
  background: backgroundSchema,
  type: exportTypeSchema,
  format: exportFormatSchema,
  resolution: z.number(),
  bitrate: z.number().nullable(),
  currentTime: z.number().optional()
});

export type VideoEditorSchemaProps = z.infer<typeof videoEditorSchema>;
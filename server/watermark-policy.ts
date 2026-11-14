import { readUserWatermarkFeature } from "./watermark-repository";

// Resolve the authenticated exporting user's current plan, not a client flag.
export async function isWatermarkRequired(userId: string): Promise<boolean> {
  const value = (await readUserWatermarkFeature(userId))?.trim().toLowerCase();
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  throw new Error("Invalid watermark configuration");
}

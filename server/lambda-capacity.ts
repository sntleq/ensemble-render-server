import { z } from "zod";
import type { Tier } from "./tiers";
import { readRenderSettings, closeRenderSettingsDatabase } from "./render-settings-repository";

export const AWS_LAMBDA_LIMIT = 1000;
const REFRESH_MS = 5000;
const MAX_SETTINGS_AGE_MS = 10000;

const settingsSchema = z.object({
  workers: z.object({
    free: z.number().int().min(1).max(AWS_LAMBDA_LIMIT - 1),
    pro: z.number().int().min(1).max(AWS_LAMBDA_LIMIT - 1),
    business: z.number().int().min(1).max(AWS_LAMBDA_LIMIT - 1),
  }),
  stillsAudioBudget: z.number().int().min(0).max(AWS_LAMBDA_LIMIT),
  freeOverflowBudget: z.number().int().min(0).max(AWS_LAMBDA_LIMIT),
}).refine((settings) => settings.stillsAudioBudget + settings.freeOverflowBudget <= AWS_LAMBDA_LIMIT);

type Settings = z.infer<typeof settingsSchema>;
type Lane = "stillsAudio" | "freeOverflow" | "proBusiness";
export type LambdaReservation = { workers: number; release: () => void };

// One shared allocator for every Lambda path in this render-server process.
// Local render slots and local worker concurrency do not use this allocator.
export function makeLambdaCapacity() {
  let settings: Settings | null = null;
  let loadedAt = 0;
  let refreshing = false;
  let stopped = false;
  const active: Record<Lane, number> = { stillsAudio: 0, freeOverflow: 0, proBusiness: 0 };
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };

  const refresh = async () => {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      settings = settingsSchema.parse(await readRenderSettings());
      loadedAt = Date.now();
    } catch {
      // Never silently revert to hardcoded allocations. Already running jobs
      // retain their original reservations; local rendering remains available.
      settings = null;
      console.error("Lambda configuration unavailable; new Lambda starts are paused.");
    } finally {
      refreshing = false;
      if (!stopped) notify();
    }
  };

  const tryAcquire = (lane: Lane, tier: Tier, type: "image" | "audio" | "video"): LambdaReservation | null => {
    if (!settings || Date.now() - loadedAt > MAX_SETTINGS_AGE_MS || stopped) return null;
    const workers = type === "video" ? settings.workers[tier] : 1;
    const cost = type === "image" ? 1 : workers + 1;
    const budget = lane === "stillsAudio" ? settings.stillsAudioBudget
      : lane === "freeOverflow" ? settings.freeOverflowBudget
      : AWS_LAMBDA_LIMIT - settings.stillsAudioBudget - settings.freeOverflowBudget;
    const totalActive = active.stillsAudio + active.freeOverflow + active.proBusiness;
    if (active[lane] + cost > budget || totalActive + cost > AWS_LAMBDA_LIMIT) return null;
    active[lane] += cost;
    let released = false;
    return {
      workers,
      release: () => {
        if (released) return;
        released = true;
        active[lane] -= cost;
        if (!stopped) notify();
      },
    };
  };

  const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
  timer.unref();
  void refresh();
  return {
    tryAcquire,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      listeners.clear();
      void closeRenderSettingsDatabase().catch(() => {});
    },
  };
}

export type LambdaCapacity = ReturnType<typeof makeLambdaCapacity>;

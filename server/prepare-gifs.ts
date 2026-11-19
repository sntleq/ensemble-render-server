import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isGifSource, type PreparedGif } from "../remotion/prepared-gif";
import { renderDownloadUrl } from "./auth";
import type { RenderJobData } from "./portfolio-render";

const exec = promisify(execFile);
type Destination = { directory: string; port: number } | { s3: S3Client; bucket: string };

function collectSources(data: RenderJobData) {
  const sources = new Set<string>();
  function visit(ids: string[], items: RenderJobData["trackItemsMap"], nested: boolean) {
    for (const id of ids) {
      const item = items[id];
      if (!item || item.details?.hidden) continue;
      const src = item.details?.src;
      if (item.type === "image" && typeof src === "string" && isGifSource(src)) sources.add(src);
      const content = item.details?.content;
      if (!nested && item.type === "scene" && content?.trackItemsMap && Array.isArray(content.trackItemIds)) {
        visit(content.trackItemIds, content.trackItemsMap, true);
      }
    }
  }
  if (data.type === "video" || data.type === "image-sequence") visit(data.trackItemIds, data.trackItemsMap, false);
  return sources;
}

// Fetch only inline data or media from the project's storage providers on the server.
// Other URLs retain their existing browser-side GIF path.
function canDownload(src: string) {
  if (/^data:image\/gif[;,]/i.test(src)) return true;
  const url = URL.canParse(src) ? new URL(src) : null;
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const cdn = process.env.CLOUDFRONT_DOMAIN;
  return /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(url.hostname)
    || url.hostname.endsWith(".cloudfront.net") || (!!cdn && URL.canParse(cdn) && url.origin === new URL(cdn).origin);
}

async function download(src: string, file: string) {
  const response = await fetch(src, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error("GIF download failed");
  const hash = createHash("sha256");
  let size = 0;
  const reader = response.body.getReader();
  await pipeline(async function* () {
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > 128 * 1024 * 1024) throw new Error("GIF exceeds preparation size");
        hash.update(chunk);
        yield chunk;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }, createWriteStream(file));
  return hash.digest("hex");
}

async function convert(input: string, output: string) {
  // One frame per GIF image. The separate delay table preserves centisecond
  // timing even when a loop doesn't span a whole number of composition frames.
  const inputOptions = ["-v", "error", "-protocol_whitelist", "file", "-f", "gif", "-ignore_loop", "1", "-min_delay", "1"];
  const { stdout } = await exec("ffprobe", [...inputOptions, "-show_entries", "packet=duration_time",
    "-of", "csv=p=0", input], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  let endMs = 0;
  const endsMs = stdout.trim().split(/\r?\n/).map(line => {
    const ms = Math.round(Number(line) * 1000);
    if (!Number.isFinite(ms) || ms <= 0) throw new Error("Invalid GIF frame duration");
    return endMs += ms;
  });
  await exec("ffmpeg", ["-nostdin", ...inputOptions, "-i", input, "-an",
    "-vf", "settb=1/25,setpts=N", "-enc_time_base", "1:25", "-fps_mode", "passthrough",
    "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
    "-threads", "2", "-movflags", "+faststart", "-y", output], { timeout: 180_000 });
  return endsMs;
}

export function createGifPreparation(destination: Destination) {
  const release: Array<() => Promise<unknown>> = [];

  async function publish(file: string) {
    const name = `gif-${randomUUID()}.mov`;
    if ("directory" in destination) {
      await mkdir(destination.directory, { recursive: true });
      const output = path.join(destination.directory, name);
      release.push(() => rm(output, { force: true }));
      await copyFile(file, output);
      return renderDownloadUrl(`http://127.0.0.1:${destination.port}`, name);
    }
    const object = { Bucket: destination.bucket, Key: `renders/${name}` };
    release.push(() => destination.s3.send(new DeleteObjectCommand(object)));
    const body = createReadStream(file);
    try {
      await destination.s3.send(new PutObjectCommand({ ...object, Body: body,
        ContentLength: (await stat(file)).size, ContentType: "video/quicktime" }));
    } finally {
      body.destroy();
    }
    return getSignedUrl(destination.s3, new GetObjectCommand(object), { expiresIn: 10800 });
  }

  return {
    async prepare(data: RenderJobData, cancelled: () => boolean) {
      const sources = [...collectSources(data)].filter(canDownload);
      if (!sources.length) return data;
      const directory = await mkdtemp(path.join(tmpdir(), "ensemble-gif-"));
      const preparedGifs: Record<string, PreparedGif> = {};
      const byDigest = new Map<string, PreparedGif>();
      const input = path.join(directory, "source.gif");
      const output = path.join(directory, "prepared.mov");
      try {
        for (const src of sources) {
          if (cancelled()) break;
          try {
            const digest = await download(src, input);
            let gif = byDigest.get(digest);
            if (!gif) {
              const endsMs = await convert(input, output);
              if (cancelled()) break;
              gif = { src: await publish(output), endsMs };
              byDigest.set(digest, gif);
            }
            preparedGifs[src] = gif;
          } catch (error) {
            // The original GIF remains available if the host cannot prepare a proxy.
            console.warn("GIF preparation failed; using the original GIF.", error instanceof Error ? error.name : "Error");
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      return { ...data, preparedGifs };
    },
    async dispose() {
      await Promise.all(release.map(cleanup => cleanup().catch(() => console.warn("Could not remove prepared GIF video."))));
    },
  };
}

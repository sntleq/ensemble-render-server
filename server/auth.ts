import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export function isInternalSecret(provided: string | undefined): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const requireRenderIdentity: RequestHandler = (req, res, next) => {
  if (!isInternalSecret(req.header("x-internal-secret")) ||
      !/^[0-9a-f-]{36}$/i.test(req.header("x-user-id") ?? "")) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  next();
};

function downloadSignature(pathname: string, expires: string) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) throw new Error("Render authentication is not configured");
  return createHmac("sha256", secret).update(`render-download\n${pathname}\n${expires}`).digest("hex");
}

export function renderDownloadUrl(baseUrl: string, filename: string): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/renders/${filename}`);
  // Matches the local output retention period.
  const expires = String(Math.floor(Date.now() / 1000) + 3 * 60 * 60);
  url.searchParams.set("expires", expires);
  url.searchParams.set("signature", downloadSignature(url.pathname, expires));
  return url.toString();
}

export const requireDownloadSignature: RequestHandler = (req, res, next) => {
  const { expires, signature } = req.query;
  if (!process.env.INTERNAL_API_SECRET || typeof expires !== "string" ||
      !/^\d+$/.test(expires) || Number(expires) <= Date.now() / 1000 ||
      typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) {
    res.status(401).json({ message: "Invalid or expired download link" });
    return;
  }
  const expected = downloadSignature(`${req.baseUrl}${req.path}`, expires);
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
    res.status(401).json({ message: "Invalid or expired download link" });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  next();
};

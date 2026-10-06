// filename.ts
// Shared by index.ts, render-queue.ts and lambda-render-queue.ts.

// Safe to use as a download file name: no control characters or newlines, none
// of the characters Windows forbids, no trailing dots or spaces, capped in
// length. Unicode is kept.
export const sanitizeFilename = (name: string): string => {
  const cleaned = Array.from(
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/[/\\?%*:|"<>]/g, "-")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 150)
    .join("")
    .replace(/[. ]+$/, "");
  return cleaned || "Untitled";
};

// For header values that can't carry Unicode: anything outside printable ASCII becomes "_".
export const asciiFileName = (name: string): string =>
  sanitizeFilename(name).replace(/[^\x20-\x7e]/g, "_");

// Content-Disposition with an ASCII fallback plus the real UTF-8 name (RFC 6266).
// ext includes the dot, e.g. ".mp4".
export const contentDispositionFor = (name: string, ext: string): string => {
  const base = sanitizeFilename(name);
  const encoded = encodeURIComponent(`${base}${ext}`).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFileName(base)}${ext}"; filename*=UTF-8''${encoded}`;
};
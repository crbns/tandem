import { ConvexError } from "convex/values";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const BINARY_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "application/octet-stream",
]);

export function validateBinaryUpload(
  size: number,
  mimeType: string | undefined,
) {
  if (size < 1 || size > MAX_UPLOAD_BYTES)
    throw new ConvexError({
      code: "INVALID_UPLOAD_SIZE",
      maxBytes: MAX_UPLOAD_BYTES,
    });
  if (!mimeType || !BINARY_MIME_TYPES.has(mimeType))
    throw new ConvexError({ code: "UNSUPPORTED_MIME_TYPE" });
  return mimeType;
}

// Includes filename and attachment framing without clipping any accepted input.
export const LIMITS = {
  draftText: 6000,
  attachmentText: 20000,
  imageDataUrl: 3_000_000,
  fileName: 260,
  message: 27000,
} as const;

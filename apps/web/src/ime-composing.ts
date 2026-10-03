/**
 * Whether a key event belongs to an IME conversion (mock imeComposing), so the Enter that confirms
 * a conversion is not taken as a request to send. Safari and older Chromium do not set
 * isComposing (or set it late) and deliver those keys with keyCode 229 instead.
 */
export const isImeComposing = (event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean =>
  // keyCode is deprecated, but 229 is the only field that marks a composing key where isComposing
  // is missing; no standard replacement carries it.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- 229 is the only IME mark in Safari
  event.isComposing || event.keyCode === 229;

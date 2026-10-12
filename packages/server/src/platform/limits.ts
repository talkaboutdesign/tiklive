/** Bounds for the built-in server platform layers. */
export const MAX_OUTGOING_BYTES = 1024 * 1024;
export const BUN_WEBSOCKET_LIMITS = {
  maxPayloadLength: 64 * 1024,
  backpressureLimit: MAX_OUTGOING_BYTES,
  closeOnBackpressureLimit: true,
} as const;

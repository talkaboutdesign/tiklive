import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { decode, ProtoWriter } from "./wire.ts";

const gunzipAsync = promisify(gunzip);
const textEncoder = new TextEncoder();

/** Envelope for every binary frame on the webcast WebSocket. */
export interface PushFrame {
  seqId: string;
  logId: string;
  service: string;
  method: string;
  headers: Record<string, string>;
  payloadEncoding: string;
  /** 'msg' for event batches, 'im_enter_room_resp', 'hb', 'ack', ... */
  payloadType: string;
  payload: Uint8Array;
}

/** A single event inside a {@link FetchResult}; `method` names its schema, e.g. 'WebcastChatMessage'. */
export interface RawMessage {
  method: string;
  payload: Uint8Array;
  msgId: string;
  isHistory: boolean;
}

/** Batch of events returned by `im/fetch` and pushed over the WebSocket. */
export interface FetchResult {
  messages: RawMessage[];
  cursor: string;
  fetchInterval: number;
  now: string;
  internalExt: string;
  routeParams: Record<string, string>;
  heartbeatDuration: number;
  needAck: boolean;
  pushServer: string;
  isFirst: boolean;
}

export function decodePushFrame(buf: Uint8Array): PushFrame {
  const m = decode(buf);
  const headers: Record<string, string> = {};
  for (const h of m.msgs(5)) headers[h.str(1)] = h.str(2);
  return {
    seqId: m.id(1),
    logId: m.id(2),
    service: m.id(3),
    method: m.id(4),
    headers,
    payloadEncoding: m.str(6),
    payloadType: m.str(7),
    payload: m.bytes(8),
  };
}

export function encodePushFrame(frame: {
  logId?: string;
  payloadType: string;
  payload: Uint8Array;
  payloadEncoding?: string;
}): Uint8Array {
  return new ProtoWriter()
    .varint(2, frame.logId)
    .string(6, frame.payloadEncoding ?? "pb")
    .string(7, frame.payloadType)
    .bytes(8, frame.payload)
    .finish();
}

export function decodeFetchResult(buf: Uint8Array): FetchResult {
  const m = decode(buf);
  const routeParams: Record<string, string> = {};
  for (const entry of m.msgs(7)) routeParams[entry.str(1)] = entry.str(2);
  return {
    messages: m.msgs(1).map((msg) => ({
      method: msg.str(1),
      payload: msg.bytes(2),
      msgId: msg.id(3),
      isHistory: msg.bool(6),
    })),
    cursor: m.str(2),
    fetchInterval: m.num(3),
    now: m.id(4),
    internalExt: m.str(5),
    routeParams,
    heartbeatDuration: m.num(8),
    needAck: m.bool(9),
    pushServer: m.str(10),
    isFirst: m.bool(11),
  };
}

function isGzip(buf: Uint8Array): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08;
}

/** Decodes a WebSocket frame, unzipping and parsing the event batch when present. */
export async function decodeSocketFrame(
  buf: Uint8Array,
): Promise<{ frame: PushFrame; result?: FetchResult }> {
  const frame = decodePushFrame(buf);
  if (frame.payloadType !== "msg" || frame.payloadEncoding !== "pb" || frame.payload.length === 0) {
    return { frame };
  }
  const payload = isGzip(frame.payload) ? new Uint8Array(await gunzipAsync(frame.payload)) : frame.payload;
  return { frame, result: decodeFetchResult(payload) };
}

export function encodeHeartbeat(roomId: string): Uint8Array {
  const hb = new ProtoWriter().varint(1, roomId).finish();
  return encodePushFrame({ payloadType: "hb", payload: hb });
}

/** Joins the room on an open socket. Mirrors the frame TikTok's web client sends. */
export function encodeEnterRoom(roomId: string, cursor?: string): Uint8Array {
  const enter = new ProtoWriter()
    .varint(1, roomId)
    .varint(4, 12) // live_id: constant for TikTok LIVE
    .string(5, "audience")
    .string(6, cursor)
    .finish();
  return encodePushFrame({ payloadType: "im_enter_room", payload: enter });
}

/** Acknowledges a message batch. The web client sends '-' as the payload. */
export function encodeAck(logId: string, payload = "-"): Uint8Array {
  return encodePushFrame({ logId, payloadType: "ack", payload: textEncoder.encode(payload) });
}

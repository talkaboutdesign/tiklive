/**
 * Minimal protobuf wire-format codec.
 *
 * TikTok's schemas are huge and change often, so instead of generated code we
 * parse each message into a field table and read only the fields we care
 * about. Unknown fields are ignored, which keeps decoding forward-compatible.
 */

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export const WireType = {
  Varint: 0,
  Fixed64: 1,
  LengthDelimited: 2,
  Fixed32: 5,
} as const;
export type WireType = (typeof WireType)[keyof typeof WireType];

type FieldValue = bigint | Uint8Array;

export class ProtoDecodeError extends Error {}

/** A parsed protobuf message with typed accessors by field number. */
export class ProtoMessage {
  private readonly fields = new Map<number, FieldValue[]>();
  readonly buffer: Uint8Array;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    let pos = 0;
    const buf = buffer;

    const readVarint = (): bigint => {
      let result = 0n;
      let shift = 0n;
      for (;;) {
        if (pos >= buf.length) throw new ProtoDecodeError("Truncated varint");
        const byte = buf[pos++]!;
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return result;
        shift += 7n;
        if (shift > 70n) throw new ProtoDecodeError("Varint too long");
      }
    };

    const readFixed = (bytes: number): bigint => {
      if (pos + bytes > buf.length) throw new ProtoDecodeError("Truncated fixed field");
      let value = 0n;
      for (let i = bytes - 1; i >= 0; i--) value = (value << 8n) | BigInt(buf[pos + i]!);
      pos += bytes;
      return value;
    };

    while (pos < buf.length) {
      const tag = Number(readVarint());
      const field = tag >>> 3;
      const wire = tag & 7;
      if (field === 0) throw new ProtoDecodeError("Invalid field number 0");

      let value: FieldValue;
      switch (wire) {
        case WireType.Varint:
          value = readVarint();
          break;
        case WireType.Fixed64:
          value = readFixed(8);
          break;
        case WireType.LengthDelimited: {
          const len = Number(readVarint());
          if (pos + len > buf.length) throw new ProtoDecodeError("Truncated length-delimited field");
          value = buf.subarray(pos, pos + len);
          pos += len;
          break;
        }
        case WireType.Fixed32:
          value = readFixed(4);
          break;
        default:
          throw new ProtoDecodeError(`Unsupported wire type ${wire}`);
      }

      const list = this.fields.get(field);
      if (list) list.push(value);
      else this.fields.set(field, [value]);
    }
  }

  has(field: number): boolean {
    return this.fields.has(field);
  }

  private last(field: number): FieldValue | undefined {
    const list = this.fields.get(field);
    return list?.[list.length - 1];
  }

  private asVarint(field: number): bigint | undefined {
    const v = this.last(field);
    return typeof v === "bigint" ? v : undefined;
  }

  /** int32/int64/uint/enum as a JS number. Use {@link id} for 64-bit identifiers. */
  num(field: number): number {
    const v = this.asVarint(field);
    return v === undefined ? 0 : Number(BigInt.asIntN(64, v));
  }

  /** 64-bit integer as a decimal string (safe for IDs that exceed 2^53). */
  id(field: number): string {
    const v = this.asVarint(field);
    return v === undefined ? "" : BigInt.asIntN(64, v).toString();
  }

  bool(field: number): boolean {
    const v = this.asVarint(field);
    return v !== undefined && v !== 0n;
  }

  bytes(field: number): Uint8Array {
    const v = this.last(field);
    return v instanceof Uint8Array ? v : new Uint8Array();
  }

  str(field: number): string {
    const v = this.last(field);
    return v instanceof Uint8Array ? textDecoder.decode(v) : "";
  }

  strs(field: number): string[] {
    return (this.fields.get(field) ?? [])
      .filter((v): v is Uint8Array => v instanceof Uint8Array)
      .map((v) => textDecoder.decode(v));
  }

  msg(field: number): ProtoMessage | undefined {
    const v = this.last(field);
    return v instanceof Uint8Array ? new ProtoMessage(v) : undefined;
  }

  msgs(field: number): ProtoMessage[] {
    return (this.fields.get(field) ?? [])
      .filter((v): v is Uint8Array => v instanceof Uint8Array)
      .map((v) => new ProtoMessage(v));
  }
}

export function decode(buffer: Uint8Array): ProtoMessage {
  return new ProtoMessage(buffer);
}

/** Builds a protobuf message. Zero/empty values are skipped, matching proto3 defaults. */
export class ProtoWriter {
  private readonly chunks: Uint8Array[] = [];

  private pushVarint(value: bigint): void {
    let v = BigInt.asUintN(64, value);
    const out: number[] = [];
    while (v > 0x7fn) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v));
    this.chunks.push(Uint8Array.from(out));
  }

  private tag(field: number, wire: WireType): void {
    this.pushVarint(BigInt((field << 3) | wire));
  }

  varint(field: number, value: number | bigint | string | boolean | undefined): this {
    if (value === undefined || value === "") return this;
    const big = typeof value === "boolean" ? (value ? 1n : 0n) : BigInt(value);
    if (big === 0n) return this;
    this.tag(field, WireType.Varint);
    this.pushVarint(big);
    return this;
  }

  bytes(field: number, value: Uint8Array | undefined): this {
    if (!value || value.length === 0) return this;
    this.tag(field, WireType.LengthDelimited);
    this.pushVarint(BigInt(value.length));
    this.chunks.push(value);
    return this;
  }

  string(field: number, value: string | undefined): this {
    return value ? this.bytes(field, textEncoder.encode(value)) : this;
  }

  message(field: number, value: ProtoWriter): this {
    const bytes = value.finish();
    this.tag(field, WireType.LengthDelimited);
    this.pushVarint(BigInt(bytes.length));
    this.chunks.push(bytes);
    return this;
  }

  finish(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

// src/llm/protobuf.ts - Minimal protobuf encode/decode and Connect framing for the Connect-based wires

/** proto3 writer; zero values are omitted like a generated encoder does. */
export class ProtoWriter {
  private readonly parts: Uint8Array[] = [];

  private varint(value: number | bigint): void {
    let v = BigInt(value);
    const bytes: number[] = [];
    while (v > 0x7fn) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v));
    this.parts.push(Uint8Array.from(bytes));
  }

  private tag(field: number, wireType: number): void {
    this.varint((field << 3) | wireType);
  }

  uint(field: number, value: number | bigint): this {
    if (value) {
      this.tag(field, 0);
      this.varint(value);
    }
    return this;
  }

  bool(field: number, value: boolean | undefined): this {
    return this.uint(field, value ? 1 : 0);
  }

  double(field: number, value: number): this {
    if (value) {
      this.tag(field, 1);
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, value, true);
      this.parts.push(bytes);
    }
    return this;
  }

  bytes(field: number, value: Uint8Array): this {
    if (value.length > 0) {
      this.tag(field, 2);
      this.varint(value.length);
      this.parts.push(value);
    }
    return this;
  }

  string(field: number, value: string | undefined): this {
    return this.bytes(field, new TextEncoder().encode(value ?? ''));
  }

  /** Embedded message; written even when empty, since presence can matter for a message field. */
  message(field: number, value: ProtoWriter): this {
    const body = value.finish();
    this.tag(field, 2);
    this.varint(body.length);
    this.parts.push(body);
    return this;
  }

  finish(): Uint8Array {
    return Buffer.concat(this.parts);
  }
}

/** Decoded message: field number -> values in wire order (varints as bigint, everything else as bytes). */
export type ProtoFields = Map<number, (bigint | Uint8Array)[]>;

export function decodeProto(data: Uint8Array): ProtoFields {
  const fields: ProtoFields = new Map();
  let at = 0;
  const varint = (): bigint => {
    let result = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (at >= data.length || shift > 63n) throw new Error('protobuf: truncated varint');
      const byte = data[at++];
      result |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return result;
    }
  };
  const take = (n: number): Uint8Array => {
    if (at + n > data.length) throw new Error('protobuf: truncated field');
    return data.subarray(at, (at += n));
  };
  while (at < data.length) {
    const key = Number(varint());
    const field = key >>> 3;
    const wireType = key & 7;
    const value = wireType === 0 ? varint() : wireType === 1 ? take(8) : wireType === 2 ? take(Number(varint())) : wireType === 5 ? take(4) : undefined;
    if (value === undefined) throw new Error(`protobuf: unsupported wire type ${wireType}`);
    fields.set(field, [...(fields.get(field) ?? []), value]);
  }
  return fields;
}

const last = (fields: ProtoFields, field: number) => fields.get(field)?.at(-1);

export function protoString(fields: ProtoFields, field: number): string {
  const value = last(fields, field);
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : '';
}

export function protoNumber(fields: ProtoFields, field: number): number {
  const value = last(fields, field);
  return typeof value === 'bigint' ? Number(value) : 0;
}

export function protoDouble(fields: ProtoFields, field: number): number {
  const value = last(fields, field);
  return value instanceof Uint8Array && value.length === 8 ? new DataView(value.buffer, value.byteOffset, 8).getFloat64(0, true) : 0;
}

export function protoMessages(fields: ProtoFields, field: number): ProtoFields[] {
  return (fields.get(field) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array).map(decodeProto);
}

export function protoMessage(fields: ProtoFields, field: number): ProtoFields | undefined {
  return protoMessages(fields, field).at(-1);
}

export const CONNECT_COMPRESSED = 0x01;
export const CONNECT_END_STREAM = 0x02;

/** Connect streaming envelope: flags (1 byte) | length (4 bytes, big-endian) | payload. */
export function connectFrame(payload: Uint8Array, flags = 0): Uint8Array {
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/** Splits complete envelopes off the front of `buffer`; `rest` keeps a partial one for the next read. */
export function readConnectFrames(buffer: Buffer, maxPayload: number): { frames: { flags: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { flags: number; payload: Buffer }[] = [];
  let at = 0;
  while (buffer.length - at >= 5) {
    const length = buffer.readUInt32BE(at + 1);
    // The length prefix comes from the peer; a corrupt one must not make us buffer gigabytes.
    if (length > maxPayload) throw new Error(`Connect frame of ${length} bytes exceeds the ${maxPayload}-byte limit`);
    if (buffer.length - at - 5 < length) break;
    frames.push({ flags: buffer[at], payload: buffer.subarray(at + 5, at + 5 + length) });
    at += 5 + length;
  }
  return { frames, rest: buffer.subarray(at) };
}

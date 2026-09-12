/**
 * A MessagePack decoder (https://github.com/msgpack/msgpack/blob/master/spec.md),
 * for the checkpoints LangGraph's serializer writes with ormsgpack. Decoding
 * only: agit never writes this format.
 *
 * Extension types are returned as `{ $ext, data }` rather than interpreted
 * here; what an extension means is the writer's contract, and the adapter
 * that knows the writer decodes `data` itself. Integers outside the double's
 * safe range come back as bigint. Map keys are stringified: the format
 * allows any key type, JSON allows one.
 */

export type MsgpackExt = { $ext: number; data: Uint8Array };
export type MsgpackValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | MsgpackExt
  | MsgpackValue[]
  | { [key: string]: MsgpackValue };

export class MsgpackError extends Error {}

export function decodeMsgpack(bytes: Uint8Array): MsgpackValue {
  const d = new Decoder(bytes);
  const value = d.read();
  if (d.at !== bytes.length)
    throw new MsgpackError(`${bytes.length - d.at} trailing byte(s) after the value`);
  return value;
}

class Decoder {
  at = 0;
  private readonly view: DataView;
  private readonly text = new TextDecoder("utf-8", { fatal: false });

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  read(): MsgpackValue {
    const b = this.u8();
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if (b >= 0x80 && b <= 0x8f) return this.map(b & 0x0f);
    if (b >= 0x90 && b <= 0x9f) return this.array(b & 0x0f);
    if (b >= 0xa0 && b <= 0xbf) return this.str(b & 0x1f);
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return this.bin(this.u8());
      case 0xc5:
        return this.bin(this.u16());
      case 0xc6:
        return this.bin(this.u32());
      case 0xc7:
        return this.ext(this.u8());
      case 0xc8:
        return this.ext(this.u16());
      case 0xc9:
        return this.ext(this.u32());
      case 0xca: {
        const v = this.view.getFloat32(this.at);
        this.at += 4;
        return v;
      }
      case 0xcb: {
        const v = this.view.getFloat64(this.at);
        this.at += 8;
        return v;
      }
      case 0xcc:
        return this.u8();
      case 0xcd:
        return this.u16();
      case 0xce:
        return this.u32();
      case 0xcf: {
        const v = this.view.getBigUint64(this.at);
        this.at += 8;
        return safe(v);
      }
      case 0xd0: {
        const v = this.view.getInt8(this.at);
        this.at += 1;
        return v;
      }
      case 0xd1: {
        const v = this.view.getInt16(this.at);
        this.at += 2;
        return v;
      }
      case 0xd2: {
        const v = this.view.getInt32(this.at);
        this.at += 4;
        return v;
      }
      case 0xd3: {
        const v = this.view.getBigInt64(this.at);
        this.at += 8;
        return safe(v);
      }
      case 0xd4:
        return this.ext(1);
      case 0xd5:
        return this.ext(2);
      case 0xd6:
        return this.ext(4);
      case 0xd7:
        return this.ext(8);
      case 0xd8:
        return this.ext(16);
      case 0xd9:
        return this.str(this.u8());
      case 0xda:
        return this.str(this.u16());
      case 0xdb:
        return this.str(this.u32());
      case 0xdc:
        return this.array(this.u16());
      case 0xdd:
        return this.array(this.u32());
      case 0xde:
        return this.map(this.u16());
      case 0xdf:
        return this.map(this.u32());
      default:
        throw new MsgpackError(`unknown format byte 0x${b.toString(16)} at ${this.at - 1}`);
    }
  }

  private u8(): number {
    const v = this.bytes[this.at];
    if (v === undefined) throw new MsgpackError("unexpected end of data");
    this.at += 1;
    return v;
  }

  private u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.at);
    this.at += 2;
    return v;
  }

  private u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.at);
    this.at += 4;
    return v;
  }

  private need(n: number): void {
    if (this.at + n > this.bytes.length) throw new MsgpackError("unexpected end of data");
  }

  private take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  private str(n: number): string {
    return this.text.decode(this.take(n));
  }

  private bin(n: number): Uint8Array {
    return this.take(n);
  }

  private ext(n: number): MsgpackExt {
    const type = this.view.getInt8(this.at);
    this.at += 1;
    return { $ext: type, data: this.take(n) };
  }

  private array(n: number): MsgpackValue[] {
    const out: MsgpackValue[] = [];
    for (let i = 0; i < n; i++) out.push(this.read());
    return out;
  }

  private map(n: number): { [key: string]: MsgpackValue } {
    const out: { [key: string]: MsgpackValue } = {};
    for (let i = 0; i < n; i++) {
      const k = this.read();
      const key = typeof k === "string" ? k : keyOf(k);
      out[key] = this.read();
    }
    return out;
  }
}

function safe(v: bigint): number | bigint {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

function keyOf(k: MsgpackValue): string {
  if (k === null || typeof k === "boolean" || typeof k === "number" || typeof k === "bigint")
    return String(k);
  throw new MsgpackError("a map key that is neither a string nor a scalar");
}

// Prints a protobuf payload as a field tree, for mapping new message types: bun scripts/dump.ts <file.bin>
import { readFileSync } from "node:fs";
type F = { no: number; wt: number; v: bigint | Uint8Array };
function parse(b: Uint8Array): F[] | null {
  const out: F[] = [];
  let i = 0;
  const varint = () => {
    let r = 0n,
      s = 0n;
    while (true) {
      if (i >= b.length) throw 0;
      const x = b[i++]!;
      r |= BigInt(x & 0x7f) << s;
      s += 7n;
      if (!(x & 0x80)) return r;
    }
  };
  try {
    while (i < b.length) {
      const key = Number(varint());
      const no = key >> 3,
        wt = key & 7;
      if (no === 0) return null;
      if (wt === 0) out.push({ no, wt, v: varint() });
      else if (wt === 2) {
        const n = Number(varint());
        if (i + n > b.length) return null;
        out.push({ no, wt, v: b.subarray(i, i + n) });
        i += n;
      } else if (wt === 1) {
        i += 8;
        out.push({ no, wt, v: 0n });
      } else if (wt === 5) {
        i += 4;
        out.push({ no, wt, v: 0n });
      } else return null;
    }
  } catch {
    return null;
  }
  return out;
}
const printable = (u: Uint8Array) => {
  const s = new TextDecoder("utf-8", { fatal: false }).decode(u);
  return /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}\n]*$/u.test(s) ? s : null;
};
function show(b: Uint8Array, ind: string, depth: number) {
  for (const f of parse(b) ?? []) {
    if (f.wt !== 2) {
      console.log(`${ind}${f.no}: ${f.v}`);
      continue;
    }
    const u = f.v as Uint8Array;
    const s = printable(u);
    const sub = depth < 6 ? parse(u) : null;
    if (s !== null && (s.length < 3 || !sub || sub.length === 0 || /^https?:|^[\w .,!?@#'-]+$/.test(s)))
      console.log(`${ind}${f.no}: "${s.slice(0, 80)}"`);
    else if (sub && sub.length) {
      console.log(`${ind}${f.no}: {`);
      show(u, ind + "  ", depth + 1);
      console.log(`${ind}}`);
    } else console.log(`${ind}${f.no}: <${u.length} bytes>`);
  }
}
show(new Uint8Array(readFileSync(process.argv[2]!)), "", 0);

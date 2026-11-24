// PDFs built for tests: `pdfOf` lays out pages with the given content streams (deflated); `pdfBomb` is one page
// whose stream inflates to `mb` megabytes of spaces from well under a megabyte.
import zlib from "node:zlib";

const deflated = async (chunks: Iterable<Buffer>) => {
  const deflate = zlib.createDeflate({ level: 9 });
  const out: Array<Buffer> = [];
  deflate.on("data", (b: Buffer) => out.push(b));
  const done = new Promise((resolve) => deflate.on("end", resolve));
  for (const chunk of chunks) deflate.write(chunk);
  deflate.end();
  await done;
  return Buffer.concat(out);
};

export async function pdfOf(contents: ReadonlyArray<Iterable<Buffer>>): Promise<Uint8Array> {
  const n = contents.length;
  const kids = Array.from({ length: n }, (_, i) => `${4 + 2 * i} 0 R`).join(" ");
  const parts: Array<Buffer> = [Buffer.from("%PDF-1.4\n")];
  const offsets: Array<number> = [];
  let length = parts[0]!.length;
  const push = (b: Buffer) => (parts.push(b), (length += b.length));
  const object = (id: number, body: Buffer | string) => ((offsets[id] = length), push(Buffer.from(`${id} 0 obj\n`)), push(Buffer.from(body)), push(Buffer.from("\nendobj\n")));
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < n; i++) {
    object(4 + 2 * i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`);
    const stream = await deflated(contents[i]!);
    object(5 + 2 * i, Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from("\nendstream")]));
  }
  const xref = length;
  const size = 4 + 2 * n;
  const rows = Array.from({ length: size - 1 }, (_, i) => `${String(offsets[i + 1]).padStart(10, "0")} 00000 n \n`).join("");
  push(Buffer.from(`xref\n0 ${size}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

/** A page that shows `text`. */
export const textPage = (text: string) => [Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`)];

export function pdfBomb(mb: number): Promise<Uint8Array> {
  const spaces = Buffer.alloc(1024 * 1024, 0x20);
  return pdfOf([{ *[Symbol.iterator]() { for (let i = 0; i < mb; i++) yield spaces; } }]);
}

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

import { extractDocumentText } from "./documentTextWorker.ts";

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "document-text-worker-"));
afterAll(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

/** A zip of stored entries, as a .docx or .odt is. */
function zip(entries: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(NodeZlib.crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(NodeZlib.crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, filename, data);
    central.push(entry, filename);
    offset += header.length + filename.length + data.length;
  }
  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralDirectory, end]);
}

let documents = 0;
const extract = (extension: ".docx" | ".odt", part: string, content: string) => {
  const path = NodePath.join(directory, `document-${++documents}${extension}`);
  NodeFS.writeFileSync(path, zip({ [part]: content }));
  return extractDocumentText(path, extension);
};
const word = (body: string) =>
  extract(
    ".docx",
    "word/document.xml",
    '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc" xmlns:wps="urn:wps" xmlns:v="urn:v">' +
      `<w:body>${body}</w:body></w:document>`,
  );

describe("the text an agent reads from a document is the text the document shows", () => {
  it("leaves out a Word redline's deleted text and keeps its insertion", async () => {
    expect(
      await word(
        '<w:p><w:r><w:t xml:space="preserve">Fee: </w:t></w:r>' +
          "<w:del><w:r><w:delText>$5,000</w:delText></w:r></w:del>" +
          "<w:ins><w:r><w:t>$7,500</w:t></w:r></w:ins></w:p>",
      ),
    ).toBe("Fee: $7,500");
  });

  it("shows moved text once, where it was moved to", async () => {
    expect(
      await word(
        "<w:p><w:moveFrom><w:r><w:t>Moved clause</w:t></w:r></w:moveFrom></w:p>" +
          "<w:p><w:moveTo><w:r><w:t>Moved clause</w:t></w:r></w:moveTo></w:p>",
      ),
    ).toBe("Moved clause");
  });

  it("shows a table of contents line without its field codes", async () => {
    expect(
      await word(
        '<w:p><w:r><w:t xml:space="preserve">Introduction </w:t></w:r>' +
          '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
          '<w:r><w:instrText xml:space="preserve"> PAGEREF _Toc123 \\h </w:instrText></w:r>' +
          '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r>' +
          '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
          '<w:del><w:r><w:delInstrText xml:space="preserve"> TOC \\o "1-3" </w:delInstrText></w:r></w:del></w:p>',
      ),
    ).toBe("Introduction 3");
  });

  it("shows a paragraph's tabs, not its tab-stop definitions", async () => {
    expect(
      await word(
        "<w:p><w:r><w:t>Title</w:t></w:r></w:p>" +
          '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="right" w:pos="9350"/></w:tabs></w:pPr>' +
          "<w:r><w:t>Left</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Right</w:t></w:r></w:p>",
      ),
    ).toBe("Title\nLeft\tRight");
  });

  it("shows a Word text box once, not again from its VML fallback", async () => {
    expect(
      await word(
        "<w:p><w:r><w:t>Body</w:t></w:r></w:p>" +
          "<w:p><w:r><mc:AlternateContent>" +
          '<mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>' +
          "<w:p><w:r><w:t>Boxed note</w:t></w:r></w:p>" +
          "</w:txbxContent></wps:txbx></w:drawing></mc:Choice>" +
          "<mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>" +
          "<w:p><w:r><w:t>Boxed note</w:t></w:r></w:p>" +
          "</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>" +
          "</mc:AlternateContent></w:r></w:p>",
      ),
    ).toBe("Body\nBoxed note");
  });

  it("keeps a fallback's text when no choice carries any", async () => {
    expect(
      await word(
        "<w:p><w:r><mc:AlternateContent>" +
          '<mc:Choice Requires="cx"><w:drawing><cx:chart/></w:drawing></mc:Choice>' +
          "<mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>" +
          "<w:p><w:r><w:t>Chart caption</w:t></w:r></w:p>" +
          "</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>" +
          "</mc:AlternateContent></w:r></w:p>",
      ),
    ).toBe("Chart caption");
  });

  it("leaves out an ODF document's tracked deletions and who made them", async () => {
    expect(
      await extract(
        ".odt",
        "content.xml",
        '<office:document-content xmlns:office="urn:office" xmlns:text="urn:text" xmlns:dc="urn:dc">' +
          "<office:body><office:text><text:tracked-changes>" +
          '<text:changed-region text:id="c1"><text:deletion><office:change-info>' +
          "<dc:creator>Reviewer</dc:creator></office:change-info><text:p>$5,000</text:p>" +
          "</text:deletion></text:changed-region></text:tracked-changes>" +
          '<text:p>Fee: <text:change text:change-id="c1"/>$7,500</text:p>' +
          "</office:text></office:body></office:document-content>",
      ),
    ).toBe("Fee: $7,500");
  });
});

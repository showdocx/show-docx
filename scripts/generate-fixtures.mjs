import { randomFillSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

const outputDirectory = join(process.cwd(), 'test', 'fixtures');
const workspaceDirectory = join(process.cwd(), 'test', 'workspace');
await mkdir(outputDirectory, { recursive: true });
await mkdir(workspaceDirectory, { recursive: true });

const commonSections = {
  headers: {
    default: new Header({
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: 'ShowDocx fixture', color: '64748B', size: 18 })],
        }),
      ],
    }),
  },
  footers: {
    default: new Footer({
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun('Page '),
            new TextRun({ children: [PageNumber.CURRENT] }),
          ],
        }),
      ],
    }),
  },
};

const simple = new Document({
  creator: 'ShowDocx',
  title: 'ShowDocx sample document',
  description: 'A test document for visual and semantic rendering.',
  sections: [
    {
      ...commonSections,
      children: [
        new Paragraph({
          text: 'ShowDocx Sample',
          heading: HeadingLevel.TITLE,
        }),
        new Paragraph({
          text: 'High-fidelity DOCX preview inside Visual Studio Code',
          heading: HeadingLevel.SUBTITLE,
        }),
        new Paragraph({
          text: 'Overview',
          heading: HeadingLevel.HEADING_1,
        }),
        new Paragraph({
          children: [
            new TextRun('This document includes '),
            new TextRun({ text: 'bold', bold: true }),
            new TextRun(', '),
            new TextRun({ text: 'italic', italics: true }),
            new TextRun(', and '),
            new TextRun({ text: 'underlined text', underline: {} }),
            new TextRun('.'),
          ],
        }),
        new Paragraph({
          text: 'Visual mode preserves page layout, while Text mode creates clean semantic HTML.',
        }),
        new Paragraph({
          text: 'Features',
          heading: HeadingLevel.HEADING_2,
        }),
        new Paragraph({ text: 'Visual page rendering', bullet: { level: 0 } }),
        new Paragraph({ text: 'Theme-aware text rendering', bullet: { level: 0 } }),
        new Paragraph({ text: 'Zoom and state persistence', bullet: { level: 0 } }),
        new Paragraph({
          children: [
            new TextRun('Project link: '),
            new TextRun({
              text: 'Visual Studio Code',
              color: '2563EB',
              underline: {},
            }),
          ],
        }),
      ],
    },
  ],
});

const border = {
  style: BorderStyle.SINGLE,
  size: 1,
  color: 'CBD5E1',
};
const table = new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [
    new TableRow({
      children: [
        cell('Feature', true),
        cell('Visual mode', true),
        cell('Text mode', true),
      ],
    }),
    new TableRow({
      children: [cell('Page layout'), cell('Preserved'), cell('Simplified')],
    }),
    new TableRow({
      children: [cell('Theme colors'), cell('Paper view'), cell('VS Code theme')],
    }),
    new TableRow({
      children: [cell('Export HTML'), cell('Available'), cell('Available')],
    }),
  ],
});
const withTables = new Document({
  sections: [
    {
      ...commonSections,
      children: [
        new Paragraph({ text: 'Table Rendering', heading: HeadingLevel.TITLE }),
        new Paragraph('The table below exercises borders, widths, and cell content.'),
        table,
      ],
    },
  ],
});

const samplePng = createPng(320, 160, false);
const withImages = new Document({
  sections: [
    {
      ...commonSections,
      children: [
        new Paragraph({ text: 'Embedded Image', heading: HeadingLevel.TITLE }),
        new Paragraph('The image below is generated locally and embedded in the DOCX package.'),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: samplePng,
              type: 'png',
              transformation: { width: 320, height: 160 },
              altText: {
                title: 'ShowDocx test image',
                description: 'Blue gradient fixture image',
                name: 'showdocx-fixture.png',
              },
            }),
          ],
        }),
      ],
    },
  ],
});

const empty = new Document({
  sections: [{ children: [new Paragraph('')] }],
});

await Promise.all([
  writeDocx('simple.docx', simple),
  writeDocx('with-tables.docx', withTables),
  writeDocx('with-images.docx', withImages),
  writeDocx('empty.docx', empty),
  writeFile(join(outputDirectory, 'corrupted.docx'), Buffer.from('not a valid OOXML package')),
]);

const simpleBuffer = await Packer.toBuffer(simple);
await writeFile(join(workspaceDirectory, 'simple.docx'), simpleBuffer);
await writeFile(
  join(workspaceDirectory, 'README.md'),
  '# ShowDocx Test Workspace\n\nOpen `simple.docx` while running the Extension Development Host.\n',
);

if (!process.argv.includes('--skip-large')) {
  const largePng = createPng(1500, 1200, true);
  const largeDocument = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Large Document Fixture', heading: HeadingLevel.TITLE }),
          new Paragraph('This valid DOCX is intentionally larger than 5 MB.'),
          new Paragraph({
            children: [
              new ImageRun({
                data: largePng,
                type: 'png',
                transformation: { width: 600, height: 480 },
              }),
            ],
          }),
        ],
      },
    ],
  });
  await writeDocx('large-file.docx', largeDocument);
}

console.log(`Generated DOCX fixtures in ${outputDirectory}`);

async function writeDocx(fileName, document) {
  const buffer = await Packer.toBuffer(document);
  await writeFile(join(outputDirectory, fileName), buffer);
}

function cell(text, bold = false) {
  return new TableCell({
    width: { size: 33, type: WidthType.PERCENTAGE },
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
    },
    children: [
      new Paragraph({
        children: [new TextRun({ text, bold })],
      }),
    ],
  });
}

function createPng(width, height, randomize) {
  const bytesPerPixel = 4;
  const raw = Buffer.alloc((width * bytesPerPixel + 1) * height);
  const randomRow = randomize ? Buffer.alloc(width * 3) : undefined;

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * bytesPerPixel + 1);
    raw[rowStart] = 0;
    if (randomRow) {
      randomFillSync(randomRow);
    }
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * bytesPerPixel;
      if (randomRow) {
        raw[pixel] = randomRow[x * 3];
        raw[pixel + 1] = randomRow[x * 3 + 1];
        raw[pixel + 2] = randomRow[x * 3 + 2];
      } else {
        raw[pixel] = 30 + Math.round((x / width) * 25);
        raw[pixel + 1] = 90 + Math.round((y / height) * 90);
        raw[pixel + 2] = 200 + Math.round((x / width) * 45);
      }
      raw[pixel + 3] = 255;
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: randomize ? 1 : 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

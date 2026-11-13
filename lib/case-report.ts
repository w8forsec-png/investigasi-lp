import "server-only";
import PDFDocument from "pdfkit";
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  Header,
  Packer,
  Paragraph,
  TextRun
} from "docx";

type ReportCase = {
  lp_number: string;
  title: string;
  reported_at: string;
  status: string;
  statute?: string | null;
  location?: string | null;
  team_name: string;
};

type ReportProfile = {
  profile_type: string;
  name: string;
  alias?: string | null;
  nik?: string | null;
  address?: string | null;
  phone?: string | null;
  role_in_case?: string | null;
  notes?: string | null;
};

type ReportFieldEntry = {
  source_unit: string;
  title: string;
  reference?: string | null;
  details: string;
  created_at: string;
  author: string;
};

type ReportTechnicalEntry = {
  category: string;
  title: string;
  target_ref?: string | null;
  progress_status: string;
  findings: string;
  created_at: string;
  author: string;
  source_report_title?: string | null;
  previous_title?: string | null;
};

type ReportMember = {
  name?: string;
  rank_number?: string;
  specialty?: string;
  duty?: string;
};

export type CaseReportData = {
  case: ReportCase;
  profiles: ReportProfile[];
  field_reports: ReportFieldEntry[];
  technical_entries: ReportTechnicalEntry[];
  members: ReportMember[];
};

const colors = {
  navy: "#15243B",
  blue: "#3D62E8",
  ink: "#29364B",
  muted: "#748197",
  line: "#E5EAF2",
  pale: "#F4F7FC"
};

function display(value?: string | null) {
  return value?.trim() || "—";
}

function dateLabel(value?: string | null) {
  if (!value) return "—";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit", month: "long", year: "numeric"
  }).format(date);
}

function addPdfSection(doc: PDFKit.PDFDocument, title: string) {
  if (doc.y + 42 > doc.page.height - 60) doc.addPage();
  doc.moveDown(0.7);
  const top = doc.y;
  doc.roundedRect(48, top, 5, 17, 2).fill(colors.blue);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(colors.navy)
    .text(title, 62, top + 1, { width: doc.page.width - 110 });
  doc.y = top + 25;
}

function addPdfField(doc: PDFKit.PDFDocument, label: string, value?: string | null) {
  doc.font("Helvetica-Bold").fontSize(8).fillColor(colors.muted)
    .text(label.toLocaleUpperCase("id-ID"));
  doc.moveDown(0.15);
  doc.font("Helvetica").fontSize(10).fillColor(colors.ink)
    .text(display(value), { width: doc.page.width - 96, lineGap: 2 });
  doc.moveDown(0.45);
}

function addPdfCard(doc: PDFKit.PDFDocument, title: string, fields: Array<[string, string | null | undefined]>) {
  const x = 48;
  const width = doc.page.width - 96;
  const innerX = x + 12;
  const contentWidth = width - 24;
  const lines = fields.map(([label, value]) => `${label}: ${display(value)}`).join("\n");
  const topPadding = 10;
  const titleBodyGap = 6;
  const bottomPadding = 10;
  doc.font("Helvetica-Bold").fontSize(10);
  const titleHeight = doc.heightOfString(title, { width: contentWidth, lineGap: 2 });
  doc.font("Helvetica").fontSize(9);
  const bodyHeight = doc.heightOfString(lines, { width: contentWidth, lineGap: 3 });
  const height = Math.max(50, topPadding + titleHeight + titleBodyGap + bodyHeight + bottomPadding);
  if (doc.y + height + 10 > doc.page.height - 58) doc.addPage();
  const y = doc.y;
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(colors.pale, colors.line);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(colors.navy).text(title, innerX, y + topPadding, {
    width: contentWidth,
    lineGap: 2
  });
  doc.font("Helvetica").fontSize(9).fillColor(colors.ink).text(lines, innerX, y + topPadding + titleHeight + titleBodyGap, {
    width: contentWidth,
    lineGap: 3
  });
  doc.y = y + height + 9;
}

export function createCasePdf(data: CaseReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 48, right: 48, bottom: 56, left: 48 },
      bufferPages: true,
      info: {
        Title: `Laporan ${data.case.lp_number}`,
        Subject: "Laporan penanganan perkara",
        Creator: "Dashboard Penanganan Perkara"
      }
    });
    const chunks: Buffer[] = [];
    doc.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.rect(0, 0, doc.page.width, 12).fill(colors.blue);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(colors.blue)
      .text("DOKUMEN INTERNAL  /  PENANGANAN PERKARA", 48, 42, { characterSpacing: 0.6 });
    doc.moveDown(1.2);
    doc.font("Helvetica-Bold").fontSize(23).fillColor(colors.navy)
      .text(data.case.title, { width: doc.page.width - 96, lineGap: 2 });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(11).fillColor(colors.muted)
      .text(`${data.case.lp_number}  ·  ${data.case.team_name}`);
    doc.moveDown(1.1);

    addPdfSection(doc, "Ringkasan perkara");
    addPdfCard(doc, "Identitas dan status", [
      ["Nomor LP", data.case.lp_number],
      ["Tanggal LP", dateLabel(data.case.reported_at)],
      ["Tim penanggung jawab", data.case.team_name],
      ["Status", data.case.status],
      ["Pasal / dasar perkara", data.case.statute],
      ["Tempat kejadian perkara", data.case.location]
    ]);

    addPdfSection(doc, `Profil korban & terduga (${data.profiles.length})`);
    if (!data.profiles.length) addPdfField(doc, "Data", "Belum ada profil yang dicatat.");
    for (const profile of data.profiles) {
      addPdfCard(doc, `${profile.profile_type}: ${profile.name}`, [
        ["Alias", profile.alias],
        ["NIK", profile.nik],
        ["Nomor HP", profile.phone],
        ["Alamat", profile.address],
        ["Peran dalam perkara", profile.role_in_case],
        ["Catatan", profile.notes]
      ]);
    }

    addPdfSection(doc, `Informasi lapangan (${data.field_reports.length})`);
    if (!data.field_reports.length) addPdfField(doc, "Data", "Belum ada informasi lapangan yang dicatat.");
    for (const report of data.field_reports) {
      addPdfCard(doc, report.title, [
        ["Sumber", report.source_unit],
        ["Referensi", report.reference],
        ["Waktu pencatatan", dateLabel(report.created_at)],
        ["Pencatat", report.author],
        ["Rincian", report.details]
      ]);
    }

    addPdfSection(doc, `Analisis teknis (${data.technical_entries.length})`);
    if (!data.technical_entries.length) addPdfField(doc, "Data", "Belum ada analisis teknis yang dicatat.");
    for (const entry of data.technical_entries) {
      addPdfCard(doc, `${entry.category}: ${entry.title}`, [
        ["Status", entry.progress_status],
        ["Referensi data", entry.target_ref],
        ["Waktu pencatatan", dateLabel(entry.created_at)],
        ["Analis", entry.author],
        ["Sumber lapangan", entry.source_report_title],
        ["Melanjutkan analisis", entry.previous_title],
        ["Hasil / catatan", entry.findings]
      ]);
    }

    addPdfSection(doc, `Personel ditugaskan (${data.members.length})`);
    if (!data.members.length) addPdfField(doc, "Data", "Belum ada personel yang ditugaskan.");
    for (const member of data.members) {
      addPdfCard(doc, display(member.name), [
        ["Pangkat / NRP", member.rank_number],
        ["Spesialisasi", member.specialty],
        ["Tugas khusus", member.duty]
      ]);
    }

    const generatedAt = new Intl.DateTimeFormat("id-ID", {
      dateStyle: "long", timeStyle: "short"
    }).format(new Date());
    const pages = doc.bufferedPageRange();
    for (let index = 0; index < pages.count; index += 1) {
      doc.switchToPage(pages.start + index);
      const footerY = doc.page.height - 39;
      doc.moveTo(48, footerY - 8).lineTo(doc.page.width - 48, footerY - 8)
        .lineWidth(0.7).strokeColor(colors.line).stroke();
      doc.font("Helvetica").fontSize(8).fillColor(colors.muted)
        .text(`Dibuat ${generatedAt}  ·  Untuk keperluan internal`, 48, footerY, {
          width: doc.page.width - 110, lineBreak: false
        });
      doc.text(`${index + 1} / ${pages.count}`, doc.page.width - 86, footerY, {
        width: 38, align: "right", lineBreak: false
      });
    }
    doc.end();
  });
}

function docParagraph(label: string, value?: string | null) {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: `, bold: true, color: "52627A" }),
      new TextRun({ text: display(value), color: "29364B" })
    ],
    spacing: { after: 100 }
  });
}

function docHeading(text: string) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 300, after: 140 },
    border: { bottom: { color: "DCE4F1", space: 6, style: "single", size: 5 } }
  });
}

export async function createCaseDocx(data: CaseReportData): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      text: "LAPORAN PENANGANAN PERKARA",
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 }
    }),
    new Paragraph({
      text: data.case.title,
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 }
    }),
    new Paragraph({
      text: `${data.case.lp_number}  |  ${data.case.team_name}`,
      alignment: AlignmentType.CENTER,
      spacing: { after: 360 }
    }),
    docHeading("Ringkasan perkara"),
    docParagraph("Nomor LP", data.case.lp_number),
    docParagraph("Tanggal LP", dateLabel(data.case.reported_at)),
    docParagraph("Tim penanggung jawab", data.case.team_name),
    docParagraph("Status", data.case.status),
    docParagraph("Pasal / dasar perkara", data.case.statute),
    docParagraph("Tempat kejadian perkara", data.case.location),
    docHeading(`Profil korban & terduga (${data.profiles.length})`)
  ];

  if (!data.profiles.length) children.push(new Paragraph({ text: "Belum ada profil yang dicatat." }));
  for (const profile of data.profiles) {
    children.push(
      new Paragraph({ text: `${profile.profile_type}: ${profile.name}`, heading: HeadingLevel.HEADING_2 }),
      docParagraph("Alias", profile.alias),
      docParagraph("NIK", profile.nik),
      docParagraph("Nomor HP", profile.phone),
      docParagraph("Alamat", profile.address),
      docParagraph("Peran dalam perkara", profile.role_in_case),
      docParagraph("Catatan", profile.notes)
    );
  }

  children.push(docHeading(`Informasi lapangan (${data.field_reports.length})`));
  if (!data.field_reports.length) children.push(new Paragraph({ text: "Belum ada informasi lapangan yang dicatat." }));
  for (const report of data.field_reports) {
    children.push(
      new Paragraph({ text: report.title, heading: HeadingLevel.HEADING_2 }),
      docParagraph("Sumber", report.source_unit),
      docParagraph("Referensi", report.reference),
      docParagraph("Waktu pencatatan", dateLabel(report.created_at)),
      docParagraph("Pencatat", report.author),
      docParagraph("Rincian", report.details)
    );
  }

  children.push(docHeading(`Analisis teknis (${data.technical_entries.length})`));
  if (!data.technical_entries.length) children.push(new Paragraph({ text: "Belum ada analisis teknis yang dicatat." }));
  for (const entry of data.technical_entries) {
    children.push(
      new Paragraph({ text: `${entry.category}: ${entry.title}`, heading: HeadingLevel.HEADING_2 }),
      docParagraph("Status", entry.progress_status),
      docParagraph("Referensi data", entry.target_ref),
      docParagraph("Waktu pencatatan", dateLabel(entry.created_at)),
      docParagraph("Analis", entry.author),
      docParagraph("Sumber lapangan", entry.source_report_title),
      docParagraph("Melanjutkan analisis", entry.previous_title),
      docParagraph("Hasil / catatan", entry.findings)
    );
  }

  children.push(docHeading(`Personel ditugaskan (${data.members.length})`));
  if (!data.members.length) children.push(new Paragraph({ text: "Belum ada personel yang ditugaskan." }));
  for (const member of data.members) {
    children.push(
      new Paragraph({ text: display(member.name), heading: HeadingLevel.HEADING_2 }),
      docParagraph("Pangkat / NRP", member.rank_number),
      docParagraph("Spesialisasi", member.specialty),
      docParagraph("Tugas khusus", member.duty)
    );
  }

  const generatedAt = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "long", timeStyle: "short"
  }).format(new Date());
  const document = new Document({
    creator: "Dashboard Penanganan Perkara",
    title: `Laporan ${data.case.lp_number}`,
    subject: "Laporan penanganan perkara",
    styles: {
      default: {
        document: { run: { font: "Aptos", size: 20, color: "29364B" } },
        heading1: { run: { font: "Aptos Display", size: 30, bold: true, color: "15243B" } },
        heading2: { run: { font: "Aptos", size: 24, bold: true, color: "3D62E8" } },
        title: { run: { font: "Aptos Display", size: 38, bold: true, color: "3D62E8" } }
      }
    },
    sections: [{
      properties: {},
      headers: {
        default: new Header({ children: [
          new Paragraph({ text: "DOKUMEN INTERNAL  /  PENANGANAN PERKARA" })
        ] })
      },
      footers: {
        default: new Footer({ children: [
          new Paragraph({
            text: `Dibuat ${generatedAt}  ·  Untuk keperluan internal`,
            alignment: AlignmentType.CENTER
          })
        ] })
      },
      children
    }]
  });
  return Packer.toBuffer(document);
}

/**
 * pdfScanner.ts
 * PDF accessibility scanner — checks tagged PDFs for WCAG/PDF-UA conformance.
 * Runs server-side using pdf-lib. Outputs issues + test cases in the same
 * shape as the web scanner, so all existing tabs (Issues, AI Fixes, WCAG,
 * etc.) work without further changes.
 */
import { PDFDocument, PDFName, PDFDict, PDFString, PDFBool } from "pdf-lib";
import type { ScanIssue, TestCase } from "./types";
import { logger } from "../utils/logger";

interface PdfScanResult {
  issues: ScanIssue[];
  testCases: TestCase[];
}

function makeIssue(p: Partial<ScanIssue> & Pick<ScanIssue, "ruleId" | "severity" | "message" | "url">): ScanIssue {
  return {
    priority: p.severity === "critical" ? 1 : p.severity === "serious" ? 2 : p.severity === "moderate" ? 3 : 4,
    category: "pdf",
    selector: "/Document",
    selectors: [],
    wcag: [],
    phase: "pdf",
    state: "initial",
    affectedCount: 1,
    ...p,
  } as ScanIssue;
}

export async function runPdfScan(url: string, _stateLabel: string = "default"): Promise<PdfScanResult> {
  const issues: ScanIssue[] = [];
  const testCases: TestCase[] = [];

  logger.info(`PDF scan starting: ${url}`);

  // ── Fetch ─────────────────────────────────────────────────────────────
  let bytes: Uint8Array;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error("PDF body is empty");
  } catch (err) {
    issues.push(makeIssue({
      ruleId: "pdf:fetch-failed",
      severity: "critical",
      message: `Could not download PDF: ${(err as Error).message}`,
      url,
      wcag: ["wcag2.4.2"],
      fixSuggestion: "Verify the PDF URL is reachable from the scanner host and serves a valid PDF document.",
    }));
    return { issues, testCases };
  }

  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (err) {
    issues.push(makeIssue({
      ruleId: "pdf:parse-failed",
      severity: "critical",
      message: `PDF could not be parsed: ${(err as Error).message}`,
      url,
      wcag: ["wcag4.1.2"],
      fixSuggestion: "Regenerate the PDF using an accessible PDF creator (Adobe Acrobat, Microsoft Word with 'Save as accessible PDF', or LibreOffice with tagged PDF enabled).",
    }));
    return { issues, testCases };
  }

  const catalog = pdf.catalog;
  const pageCount = pdf.getPageCount();

  // ── 1. Document Title (WCAG 2.4.2) ────────────────────────────────────
  const title = pdf.getTitle();
  if (!title || !title.trim()) {
    issues.push(makeIssue({
      ruleId: "pdf:missing-title",
      severity: "serious",
      message: "PDF document does not declare a title in its metadata. Screen readers and PDF viewers will show the filename instead of a meaningful title.",
      url,
      selector: "/Catalog/Metadata/Title",
      wcag: ["wcag2.4.2"],
      fixSuggestion: "Set the document Title property: File → Properties → Description → Title in Acrobat. The title should describe the document content, not be the filename.",
    }));
  }

  // ── 2. Document Language (WCAG 3.1.1) ─────────────────────────────────
  const langEntry = catalog.get(PDFName.of("Lang"));
  const lang = langEntry instanceof PDFString ? langEntry.asString() : "";
  if (!lang || !lang.trim()) {
    issues.push(makeIssue({
      ruleId: "pdf:missing-lang",
      severity: "serious",
      message: "PDF does not declare a document language. Screen readers cannot select correct pronunciation and word-emphasis rules.",
      url,
      selector: "/Catalog/Lang",
      wcag: ["wcag3.1.1"],
      fixSuggestion: "Set the document language: File → Properties → Advanced → Language. Use a BCP 47 code such as 'en', 'it', 'fr'.",
    }));
  }

  // ── 3. Tagged PDF (WCAG 1.3.1, 4.1.2) ─────────────────────────────────
  const markInfo = catalog.get(PDFName.of("MarkInfo"));
  let isTagged = false;
  if (markInfo instanceof PDFDict) {
    const marked = markInfo.get(PDFName.of("Marked"));
    isTagged = marked instanceof PDFBool && marked.asBoolean();
  }
  if (!isTagged) {
    issues.push(makeIssue({
      ruleId: "pdf:not-tagged",
      severity: "critical",
      message: "PDF is not a tagged PDF. Without structural tags, screen readers cannot determine reading order or content roles (headings, lists, tables).",
      url,
      selector: "/Catalog/MarkInfo/Marked",
      wcag: ["wcag1.3.1", "wcag4.1.2"],
      fixSuggestion: "Regenerate the PDF with tagging enabled. In Acrobat: Tools → Accessibility → 'Autotag Document'. From Word: File → Save As PDF → check 'Document structure tags for accessibility'.",
    }));
  }

  // ── 4. Structure Tree Root (PDF/UA-1) ─────────────────────────────────
  const structTreeRoot = catalog.get(PDFName.of("StructTreeRoot"));
  if (!structTreeRoot) {
    issues.push(makeIssue({
      ruleId: "pdf:no-structure-tree",
      severity: "critical",
      message: "PDF has no structure tree. The document has no semantic structure that assistive technologies can navigate.",
      url,
      selector: "/Catalog/StructTreeRoot",
      wcag: ["wcag1.3.1", "wcag2.4.6"],
      fixSuggestion: "Recreate the PDF from a source document (Word, InDesign, etc.) with the 'tagged PDF' option enabled. Adding structure tags after the fact in Acrobat is possible but slow.",
    }));
  }

  // ── 5. DisplayDocTitle viewer pref ───────────────────────────────────
  const viewerPrefs = catalog.get(PDFName.of("ViewerPreferences"));
  let displayDocTitle = false;
  if (viewerPrefs instanceof PDFDict) {
    const ddt = viewerPrefs.get(PDFName.of("DisplayDocTitle"));
    displayDocTitle = ddt instanceof PDFBool && ddt.asBoolean();
  }
  if (!displayDocTitle && title) {
    issues.push(makeIssue({
      ruleId: "pdf:display-doc-title-off",
      severity: "moderate",
      message: "PDF viewer preference 'DisplayDocTitle' is not enabled. Even though a title is set, PDF viewers show the filename in the title bar.",
      url,
      selector: "/Catalog/ViewerPreferences/DisplayDocTitle",
      wcag: ["wcag2.4.2"],
      fixSuggestion: "In Acrobat: File → Properties → Initial View → check 'Show: Document Title' under Window Options.",
    }));
  }

  // ── 6. Outline / Bookmarks (WCAG 2.4.5) ──────────────────────────────
  const outlines = catalog.get(PDFName.of("Outlines"));
  if (!outlines && pageCount > 5) {
    issues.push(makeIssue({
      ruleId: "pdf:no-bookmarks",
      severity: "moderate",
      message: `PDF has ${pageCount} pages but no bookmarks. Users cannot navigate by section without bookmarks for long documents.`,
      url,
      selector: "/Catalog/Outlines",
      wcag: ["wcag2.4.5"],
      fixSuggestion: "Add bookmarks for major sections. In Acrobat: View → Show/Hide → Navigation Panes → Bookmarks. Bookmarks should mirror the document heading structure.",
    }));
  }

  // ── 7. Tab Order on pages (WCAG 2.4.3) ───────────────────────────────
  const pages = pdf.getPages();
  let pagesWithoutTabOrder = 0;
  let pagesWithBadTabOrder = 0;
  for (const page of pages) {
    const tabs = page.node.get(PDFName.of("Tabs"));
    if (!tabs) {
      pagesWithoutTabOrder++;
    } else if (tabs instanceof PDFName) {
      const v = tabs.asString();
      if (v !== "/S" && v !== "S") pagesWithBadTabOrder++;
    }
  }
  if (pagesWithoutTabOrder > 0 && isTagged) {
    issues.push(makeIssue({
      ruleId: "pdf:no-tab-order",
      severity: "serious",
      message: `${pagesWithoutTabOrder} of ${pageCount} pages do not declare a tab order. Keyboard users may navigate fields and links in unpredictable order.`,
      url,
      selector: "/Pages/.../Tabs",
      wcag: ["wcag2.4.3"],
      affectedCount: pagesWithoutTabOrder,
      fixSuggestion: "Set tab order to structure-based: in Acrobat, Page Properties → Tab Order → 'Use Document Structure'.",
    }));
  }
  if (pagesWithBadTabOrder > 0) {
    issues.push(makeIssue({
      ruleId: "pdf:non-structure-tab-order",
      severity: "moderate",
      message: `${pagesWithBadTabOrder} of ${pageCount} pages use row/column tab order instead of structure-based order. Screen readers may announce content out of intended reading order.`,
      url,
      selector: "/Pages/.../Tabs",
      wcag: ["wcag2.4.3"],
      affectedCount: pagesWithBadTabOrder,
      fixSuggestion: "Change tab order to structure-based: Page Properties → Tab Order → 'Use Document Structure'.",
    }));
  }

  // ── 8. Form fields with tooltips (WCAG 1.3.1, 3.3.2) ──────────────────
  try {
    const form = pdf.getForm();
    const fields = form.getFields();
    let unlabeled = 0;
    for (const field of fields) {
      const fieldDict = (field as any).acroField?.dict;
      if (!fieldDict) continue;
      const tu = fieldDict.get(PDFName.of("TU"));
      const t  = fieldDict.get(PDFName.of("T"));
      const tuStr = tu instanceof PDFString ? tu.asString() : "";
      const tStr  = t  instanceof PDFString ? t.asString()  : "";
      if (!tuStr && !tStr) unlabeled++;
    }
    if (unlabeled > 0) {
      issues.push(makeIssue({
        ruleId: "pdf:form-field-unlabeled",
        severity: "critical",
        message: `${unlabeled} of ${fields.length} form fields have no tooltip or name. Screen readers cannot announce their purpose.`,
        url,
        selector: "/AcroForm/Fields",
        wcag: ["wcag1.3.1", "wcag3.3.2", "wcag4.1.2"],
        affectedCount: unlabeled,
        fixSuggestion: "In Acrobat: Tools → Prepare Form, double-click each field, fill in 'Tooltip' under General. The tooltip is what screen readers announce.",
      }));
    }
  } catch (err) {
    logger.debug(`PDF form inspection skipped: ${(err as Error).message}`);
  }

  // ── 9. Encryption check ──────────────────────────────────────────────
  if (pdf.isEncrypted) {
    issues.push(makeIssue({
      ruleId: "pdf:encrypted",
      severity: "moderate",
      message: "PDF is encrypted. Confirm encryption permissions allow assistive technology access (do NOT disable 'Enable text access for screen reader devices').",
      url,
      selector: "/Encrypt",
      wcag: ["wcag1.3.1"],
      fixSuggestion: "In Acrobat encryption settings: ensure 'Enable text access for screen reader devices for the visually impaired' is checked.",
    }));
  }

  // ── 10. Large document without navigation aids (WCAG 2.4.5) ───────────
  if (pageCount > 50 && !outlines) {
    issues.push(makeIssue({
      ruleId: "pdf:large-no-nav",
      severity: "serious",
      message: `PDF has ${pageCount} pages with no bookmarks. Users with disabilities cannot efficiently navigate a document this long.`,
      url,
      selector: "/Catalog/Outlines",
      wcag: ["wcag2.4.5"],
      fixSuggestion: "Add bookmarks for chapters/sections. For documents over 50 pages, navigation aids are essential, not optional.",
    }));
  }

  // ── 11. Author metadata (best practice) ──────────────────────────────
  const author = pdf.getAuthor();
  if (!author && !title) {
    issues.push(makeIssue({
      ruleId: "pdf:missing-metadata",
      severity: "minor",
      message: "PDF has no author or title in document metadata. Best practice for organisational document tracking.",
      url,
      selector: "/Catalog/Metadata",
      wcag: [],
      fixSuggestion: "In Acrobat: File → Properties → Description — fill in Title, Author, Subject.",
    }));
  }

  // ── Manual review test cases for things automation cannot verify ───────
  testCases.push(
    {
      name: "PDF — Reading order matches visual order",
      description: `Manually verify the reading order in this PDF reflects the visual layout: ${url}`,
      category: "manual-review",
      wcagRef: "WCAG 1.3.2",
      status: "pending",
      steps: [
        "Open the PDF in Adobe Acrobat",
        "Tools → Accessibility → Reading Order",
        "Verify highlighted regions appear in logical reading sequence",
        "Test with a screen reader (NVDA, VoiceOver) that announcement order matches visual order",
      ],
      result: "Manual review required — automation cannot verify whether visual reading order matches the tagged structure order.",
    },
    {
      name: "PDF — Alt text quality on images",
      description: `Manually verify all images in this PDF have meaningful, descriptive alt text: ${url}`,
      category: "manual-review",
      wcagRef: "WCAG 1.1.1",
      status: "pending",
      steps: [
        "Open the PDF in Adobe Acrobat",
        "Tools → Accessibility → Set Alternate Text",
        "Step through each image",
        "Verify alt text describes the meaningful content, not 'image.jpg' or generic text",
        "Decorative images should be marked as 'Decorative' (artifact)",
      ],
      result: "Manual review required — automation can detect missing alt text but not whether existing alt text is meaningful.",
    },
    {
      name: "PDF — Table structure markup",
      description: `Manually verify any tables in this PDF are tagged with proper TR/TH/TD structure: ${url}`,
      category: "manual-review",
      wcagRef: "WCAG 1.3.1",
      status: "pending",
      steps: [
        "Open the PDF in Adobe Acrobat",
        "View → Show/Hide → Navigation Panes → Tags",
        "Expand to find <Table> tags",
        "Verify each table has <TR> rows containing <TH> headers and <TD> data cells",
        "Verify the table makes sense when read row by row with a screen reader",
      ],
      result: "Manual review required — tables marked as containers without TR/TH/TD make screen reader announcements nonsensical.",
    },
  );

  logger.info(`PDF scan complete for ${url}: ${issues.length} issues, ${testCases.length} test cases`);
  return { issues, testCases };
}

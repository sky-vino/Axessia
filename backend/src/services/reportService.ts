/**
 * Generates a compact interactive HTML accessibility report.
 * The same HTML can be printed to PDF, but filters/expansion are intended for the HTML report.
 */

import { db } from "../utils/db";
import { format } from "date-fns";

function escapeHtml(value: any): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value: any): string {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function asArray(value: any): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return [value];
    }
  }
  return [value];
}

function affectedCount(issue: any): number {
  const selectors = asArray(issue.selectors);
  return Number(issue.affected_count || selectors.length || (issue.selector ? 1 : 0));
}

function friendlyElementName(selector: string): string {
  if (!selector) return "Page element";
  const id = selector.match(/#([a-zA-Z0-9_-]+)/)?.[1];
  const aria = selector.match(/\[aria-label=["']?([^"'\]]+)/i)?.[1];
  const tag = (selector.match(/^([a-z0-9]+)/i)?.[1] || "element").toLowerCase();
  const labels: Record<string, string> = {
    a: "Link",
    button: "Button",
    input: "Input",
    img: "Image",
    select: "Select field",
    textarea: "Text field",
    meta: "Page metadata",
    nav: "Navigation",
    header: "Header",
    footer: "Footer",
    main: "Main content",
    html: "Page root"
  };
  const label = labels[tag] || `${tag.charAt(0).toUpperCase()}${tag.slice(1)} element`;
  const name = id || aria;
  return name ? `${label}: ${String(name).replace(/[-_]+/g, " ")}` : label;
}

function issueTitle(issue: any): string {
  const rule = String(issue.rule_id || "");
  const message = String(issue.message || "").replace(/\s*\([^)]*affected elements grouped\)\s*$/i, "").trim();
  if (/text.*clip|truncat/i.test(message)) return "Text content may be clipped or truncated";
  if (/meta-viewport/i.test(rule)) return "Mobile zoom is restricted";
  if (/label|input-no-label/i.test(rule)) return "Form control is missing a clear label";
  if (/color|contrast/i.test(rule)) return "Text or control contrast is too low";
  if (/focus:invisible/i.test(rule)) return "Keyboard focus indicator is not visible";
  if (/focus:trap|trap-missing/i.test(rule)) return "Keyboard focus can become trapped or unusable";
  if (/aria-required-children/i.test(rule)) return "ARIA role is missing required child elements";
  if (/landmark.*unique|landmark-unique/i.test(rule)) return "Landmark needs a unique accessible name";
  if (/nested-interactive/i.test(rule)) return "Interactive controls are nested";
  if (/target-size/i.test(rule)) return "Interactive target is too small";
  if (/heading-order/i.test(rule)) return "Heading order is not logical";
  return message || rule || "Accessibility issue";
}

function conciseImpact(issue: any): string {
  const rule = `${issue.rule_id || ""} ${issue.message || ""}`;
  if (/clip|truncat|overflow/i.test(rule)) return "Important text may be hidden, especially at zoom or smaller viewport sizes.";
  if (/focus/i.test(rule)) return "Keyboard users may lose their place or be unable to operate the page predictably.";
  if (/meta-viewport/i.test(rule)) return "Mobile users may be blocked from zooming content.";
  if (/aria|role|landmark/i.test(rule)) return "Screen reader users may receive confusing structure, labels, or roles.";
  if (/label/i.test(rule)) return "Users may not understand what a form control is asking for.";
  if (/color|contrast/i.test(rule)) return "Low-vision users may not be able to read the affected content.";
  if (/target-size|pointer/i.test(rule)) return "Users may have difficulty selecting or tapping the control.";
  return "This can make the page harder to understand, navigate, or operate.";
}

function verifyStep(issue: any): string {
  const rule = `${issue.rule_id || ""} ${issue.message || ""}`;
  if (/clip|truncat|overflow/i.test(rule)) return "Zoom to 200%, resize the viewport, and confirm the full text remains visible or discoverable.";
  if (/focus/i.test(rule)) return "Use Tab and Shift+Tab and confirm visible focus on the affected control.";
  if (/meta-viewport/i.test(rule)) return "Use mobile emulation and confirm browser/pinch zoom is allowed.";
  if (/aria|role|landmark/i.test(rule)) return "Inspect with a screen reader or accessibility tree and confirm the correct name, role, and structure.";
  if (/label/i.test(rule)) return "Focus the control and confirm a clear visible label or accessible name is announced.";
  if (/color|contrast/i.test(rule)) return "Check the foreground/background colors against WCAG contrast thresholds.";
  return "Open the listed page, reproduce the issue, apply the fix, and re-run the scan.";
}

function recommendedFix(issue: any): string {
  const suggestion = String(issue.fix_suggestion || "").trim();
  if (suggestion && !/^fix any of the following/i.test(suggestion)) return suggestion;
  const rule = `${issue.rule_id || ""} ${issue.message || ""}`;
  if (/clip|truncat|overflow/i.test(rule)) return "Allow content to wrap, increase container height, or provide an accessible expansion/full-text pattern.";
  if (/focus/i.test(rule)) return "Add a visible focus style that is not hidden by overlays, clipping, or color-only changes.";
  if (/meta-viewport/i.test(rule)) return "Remove maximum-scale and user-scalable restrictions from the viewport meta tag.";
  if (/label/i.test(rule)) return "Associate each control with a visible label, aria-label, or aria-labelledby value.";
  if (/aria-required-children/i.test(rule)) return "Use the required child roles or replace the custom ARIA pattern with semantic HTML.";
  if (/landmark/i.test(rule)) return "Give repeated landmarks unique names, for example with aria-label or aria-labelledby.";
  if (/nested-interactive/i.test(rule)) return "Do not place a link, button, or input inside another interactive control.";
  if (/color|contrast/i.test(rule)) return "Adjust the text/icon and background colors to meet the applicable WCAG contrast ratio.";
  return "Fix the affected component, re-test the page, and close the issue only after verification.";
}

function severityColor(severity: string): string {
  return { critical: "#be123c", serious: "#b45309", moderate: "#a16207", minor: "#0369a1" }[severity] || "#475569";
}

function severityRank(severity: string): number {
  return { critical: 1, serious: 2, moderate: 3, minor: 4 }[severity] || 5;
}

function wcagLevel(issue: any): "A" | "AA" | "AAA" | "Advisory" | "Needs review" {
  const tags = asArray(issue.wcag_criteria).concat(asArray(issue.tags)).map(String).join(" ").toLowerCase();
  if (/wcag\d*aaa|\baaa\b/.test(tags)) return "AAA";
  if (/wcag\d*aa|\baa\b/.test(tags)) return "AA";
  if (/wcag\d*a|\blevel a\b|\ba\b/.test(tags)) return "A";
  if (String(issue.category || "").toLowerCase() === "advisory") return "Advisory";
  return "Needs review";
}

function wcagText(issue: any): string {
  const wcag = asArray(issue.wcag_criteria).slice(0, 3).map((item) => String(item).replace(/^wcag/i, "WCAG "));
  return wcag.length ? wcag.join(", ") : wcagLevel(issue);
}

function compactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.hostname}${path}`;
  } catch {
    return url || "Page URL unavailable";
  }
}

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function removeUrls(value: string): string {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+on\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function prettyRuleName(ruleId?: string): string {
  const rule = String(ruleId || "");
  const map: Record<string, string> = {
    "axe:autocomplete-valid": "Autocomplete Attribute Validation",
    "axe:aria-required-children": "ARIA Required Children",
    "axe:landmark-unique": "Landmark Naming",
    "axe:meta-viewport": "Mobile Zoom Support",
    "focus:escape-key-missing": "Escape Key Modal Dismissal",
    "focus:invisible": "Visible Keyboard Focus",
    "keyboard:arrow-key-no-response": "Composite Widget Arrow-Key Navigation",
    "pointer:target-size-minimum": "Touch Target Size",
    "heuristic:landmark-main-missing": "Main Landmark Availability",
    "heuristic:reflow": "Responsive Reflow",
    "heuristic:status-message": "Status Message Announcement",
    "color:focus-indicator-low-contrast": "Focus Indicator Contrast",
  };
  if (map[rule]) return map[rule];
  return rule
    .replace(/^(axe|heuristic|keyboard|focus|pointer|zoom|color):/i, "")
    .replace(/[-_:]+/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase()) || "Accessibility Requirement";
}

function testCaseDisplayName(tc: any, linkedIssue?: any): string {
  const raw = String(tc.name || "").trim();
  if (linkedIssue) return `${prettyRuleName(linkedIssue.rule_id)} Check`;
  const ruleMatch = `${tc.name || ""} ${tc.description || ""}`.match(/\b((?:axe|heuristic|keyboard|focus|pointer|zoom|color):[a-z0-9-]+)\b/i);
  if (ruleMatch) return `${prettyRuleName(ruleMatch[1])} Check`;
  return raw
    .replace(/^\[(MANUAL|HYBRID|CRITICAL|SERIOUS|MODERATE|MINOR)\]\s*/i, "")
    .replace(/^Automated check\s*:?\s*/i, "")
    .trim() || "Accessibility Verification";
}

function testCaseSummary(tc: any, linkedIssue?: any): string {
  if (linkedIssue) return `Verify that ${issueTitle(linkedIssue).toLowerCase()} is resolved for the affected page.`;
  const cleaned = removeUrls(String(tc.description || ""));
  if (/screen reader/i.test(`${tc.name} ${tc.description}`)) return "Validate reading order, announcements, names, roles, and state changes with assistive technology.";
  if (/keyboard-only|keyboard validation/i.test(`${tc.name} ${tc.description}`)) return "Validate the main task flow using keyboard-only navigation.";
  if (/dynamic|menus|modals|accordions|tabs/i.test(`${tc.name} ${tc.description}`)) return "Validate task-critical interactive states such as dialogs, menus, accordions, tabs, and validation states.";
  if (/responsive|zoom|touch/i.test(`${tc.name} ${tc.description}`)) return "Validate zoom, reflow, mobile viewport behavior, touch targets, and orientation support.";
  if (/form completion|error recovery|form validation/i.test(`${tc.name} ${tc.description}`)) return "Validate form submission, error identification, recovery guidance, autocomplete, and success messaging.";
  return cleaned || "Review the listed steps and mark the case after verification.";
}

function percent(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

const REPORT_SECTIONS = ["executive", "summary", "testcases", "states", "issues"] as const;
type ReportSection = typeof REPORT_SECTIONS[number];

function normalizeReportSections(sections?: string[]): Set<ReportSection> {
  const requested = new Set((sections || []).map(section => section.toLowerCase().trim()));
  const selected = REPORT_SECTIONS.filter(section => requested.size === 0 || requested.has(section));
  return new Set(selected.length ? selected : REPORT_SECTIONS);
}

function hasReportSection(sections: Set<ReportSection>, section: ReportSection): boolean {
  return sections.has(section);
}

export async function generateScanReport(scanId: string, requestedSections?: string[]): Promise<string> {
  const selectedSections = normalizeReportSections(requestedSections);
  const [scanResult, issuesResult, testCasesResult] = await Promise.all([
    db.query("SELECT s.*, u.full_name as created_by_name FROM scans s JOIN users u ON u.id = s.created_by WHERE s.id = $1", [scanId]),
    db.query(`SELECT * FROM issues WHERE scan_id = $1 AND COALESCE(false_positive, false) = false
      ORDER BY CASE WHEN is_resolved THEN 1 ELSE 0 END, priority ASC,
      CASE severity WHEN 'critical' THEN 1 WHEN 'serious' THEN 2 WHEN 'moderate' THEN 3 ELSE 4 END, created_at`, [scanId]),
    db.query("SELECT * FROM test_cases WHERE scan_id = $1 ORDER BY status, created_at", [scanId]),
  ]);

  const scan = scanResult.rows[0];
  if (!scan) throw new Error("Scan not found");

  const issues = issuesResult.rows;
  const unresolvedIssues = issues.filter((issue: any) => !issue.is_resolved);
  const resolvedIssues = issues.filter((issue: any) => issue.is_resolved);
  const testCases = testCasesResult.rows;
  const urls = asArray(scan.urls).map(String);
  const score = Math.round(Number(scan.score || 0));
  const completedAt = scan.completed_at ? new Date(scan.completed_at) : null;

  const sortedIssues = [...unresolvedIssues].sort((a: any, b: any) =>
    (a.priority || 5) - (b.priority || 5) || severityRank(a.severity) - severityRank(b.severity)
  );

  const sevCounts: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const levelCounts: Record<string, number> = { A: 0, AA: 0, AAA: 0, Advisory: 0, "Needs review": 0 };
  for (const issue of unresolvedIssues) {
    sevCounts[issue.severity] = (sevCounts[issue.severity] || 0) + 1;
    const level = wcagLevel(issue);
    levelCounts[level] = (levelCounts[level] || 0) + 1;
  }

  const passCount = testCases.filter((tc: any) => tc.status === "pass").length;
  const failCount = testCases.filter((tc: any) => tc.status === "fail").length;
  const inProgressCount = testCases.filter((tc: any) => tc.status === "pending").length;

  const severityOptions = ["critical", "serious", "moderate", "minor"]
    .filter((severity) => sevCounts[severity] > 0)
    .map((severity) => `<label><input type="checkbox" data-filter="severity" value="${severity}"> ${severity[0].toUpperCase()}${severity.slice(1)} (${sevCounts[severity]})</label>`)
    .join("");

  const priorityOptions = [...new Set(sortedIssues.map((issue: any) => Number(issue.priority || 5)))]
    .sort((a, b) => a - b)
    .map((priority) => `<label><input type="checkbox" data-filter="priority" value="${priority}"> P${priority}</label>`)
    .join("");

  const levelOptions = ["A", "AA", "AAA", "Advisory", "Needs review"]
    .filter((level) => levelCounts[level] > 0)
    .map((level) => `<label><input type="checkbox" data-filter="level" value="${escapeAttr(level)}"> ${escapeHtml(level)} (${levelCounts[level]})</label>`)
    .join("");

  const issueRows = sortedIssues.map((issue: any, index: number) => {
    const selectors = asArray(issue.selectors || issue.selector).filter(Boolean).map(String);
    const visibleSelectors = selectors.slice(0, 30);
    const issueId = String(issue.id || "").slice(0, 8).toUpperCase();
    const title = issueTitle(issue);
    const level = wcagLevel(issue);
    const pageUrl = String(issue.url || urls[0] || "");
    const selectorName = friendlyElementName(issue.selector || selectors[0] || "");
    const evidence = String(issue.evidence_explanation || "").trim();
    const dataSearch = `${title} ${issue.rule_id || ""} ${issue.message || ""} ${pageUrl} ${selectors.join(" ")}`.toLowerCase();
    return `
      <tbody class="issue-group" data-severity="${escapeAttr(issue.severity)}" data-priority="${escapeAttr(issue.priority || 5)}" data-level="${escapeAttr(level)}" data-search="${escapeAttr(dataSearch)}">
        <tr class="issue-row">
          <td class="narrow">${index + 1}</td>
          <td>
            <button class="expand" type="button" aria-expanded="false" aria-controls="details-${index}">+</button>
            <div class="issue-main">
              <strong>${escapeHtml(title)}</strong>
              <span class="muted">${escapeHtml(selectorName)}${affectedCount(issue) > 1 ? ` - ${affectedCount(issue)} grouped elements` : ""}</span>
            </div>
          </td>
          <td><span class="pill" style="--pill:${severityColor(issue.severity)}">${escapeHtml(issue.severity || "issue")}</span></td>
          <td>P${escapeHtml(issue.priority || 5)}</td>
          <td>${escapeHtml(wcagText(issue))}</td>
          <td>${affectedCount(issue)}</td>
          <td title="${escapeAttr(pageUrl)}">${escapeHtml(truncate(compactUrl(pageUrl), 42))}</td>
          <td class="issue-id">${escapeHtml(issueId)}</td>
        </tr>
        <tr id="details-${index}" class="details-row" hidden>
          <td></td>
          <td colspan="7">
            <div class="details-grid">
              <section>
                <h4>Tester view</h4>
                <p><b>Impact:</b> ${escapeHtml(conciseImpact(issue))}</p>
                <p><b>Verify:</b> ${escapeHtml(verifyStep(issue))}</p>
              </section>
              <section>
                <h4>Developer fix</h4>
                <p>${escapeHtml(recommendedFix(issue))}</p>
                <p class="muted"><b>Rule:</b> ${escapeHtml(issue.rule_id || "Not available")}${issue.help_url ? ` | <a href="${escapeAttr(issue.help_url)}" target="_blank" rel="noreferrer">Rule help</a>` : ""}</p>
              </section>
            </div>
            <div class="evidence-pack">
              <h4>Evidence and affected samples</h4>
              ${evidence ? `<p><b>Screenshot note:</b> ${escapeHtml(evidence)}</p>` : `<p class="muted">No screenshot note was captured for this issue.</p>`}
              ${issue.evidence_screenshot ? `<img src="${issue.evidence_screenshot}" alt="Screenshot evidence for ${escapeAttr(title)}">` : ""}
              <div class="selector-samples">
                <p><b>Selector samples:</b> ${selectors.length || affectedCount(issue)} affected element${(selectors.length || affectedCount(issue)) === 1 ? "" : "s"} grouped under this finding.</p>
                <p class="muted">These are DOM selector samples for locating affected elements in the rendered page. They are not source-code line numbers, so use them together with the page URL, component name, screenshot evidence, and browser DevTools.</p>
                ${visibleSelectors.length ? `<ol>${visibleSelectors.map((selector) => `<li><code>${escapeHtml(selector)}</code></li>`).join("")}</ol>` : `<p class="muted">No selector sample was captured for this grouped issue.</p>`}
                ${selectors.length > visibleSelectors.length ? `<p class="muted">Showing ${visibleSelectors.length} of ${selectors.length} selectors to keep the report readable.</p>` : ""}
              </div>
            </div>
          </td>
        </tr>
      </tbody>`;
  }).join("");

  const caseRows = testCases.map((tc: any, index: number) => {
    const typeText = `${tc.category || ""} ${tc.status || ""}`.toLowerCase();
    const type = typeText.includes("hybrid") ? "hybrid" : typeText.includes("manual") ? "manual" : "automated";
    const status = tc.status === "pass" ? "pass" : tc.status === "fail" ? "fail" : "pending";
    const steps = asArray(tc.steps).filter(Boolean).map(String).slice(0, 8);
    const linkedIssue = issues.find((issue: any) => issue.id === tc.issue_id);
    const pageUrl = linkedIssue?.url || urls[0] || "";
    const name = testCaseDisplayName(tc, linkedIssue);
    const summary = testCaseSummary(tc, linkedIssue);
    const searchText = `${name} ${summary} ${status} ${type} ${tc.wcag_ref || ""} ${linkedIssue?.message || ""}`.toLowerCase();
    return `
      <tbody class="case-group" data-case-status="${escapeAttr(status)}" data-case-type="${escapeAttr(type)}" data-search="${escapeAttr(searchText)}">
        <tr class="case-row">
          <td class="narrow">${index + 1}</td>
          <td><button class="expand" type="button" aria-expanded="false" aria-controls="case-details-${index}">+</button><div class="issue-main"><strong>${escapeHtml(name || "Accessibility test case")}</strong><span class="case-summary">${escapeHtml(summary)}</span></div></td>
          <td><span class="status ${status}">${status === "pass" ? "Pass" : status === "fail" ? "Fail" : "In progress"}</span></td>
          <td>${escapeHtml(type)}</td>
          <td>${escapeHtml(tc.wcag_ref ? String(tc.wcag_ref).replace(/^wcag/i, "WCAG ") : linkedIssue ? wcagText(linkedIssue) : "-")}</td>
          <td>${linkedIssue ? `P${escapeHtml(linkedIssue.priority || 5)}` : "-"}</td>
          <td title="${escapeAttr(pageUrl)}"><span class="url-chip">${escapeHtml(truncate(compactUrl(pageUrl), 34))}</span></td>
        </tr>
        <tr id="case-details-${index}" class="details-row" hidden>
          <td></td><td colspan="6"><div class="details-grid"><section><h4>How to test</h4>${steps.length ? `<ol>${steps.map(step => `<li>${escapeHtml(step)}</li>`).join("")}</ol>` : `<p>${linkedIssue ? escapeHtml(verifyStep(linkedIssue)) : "Review the described behavior and mark the case only after verification."}</p>`}</section><section><h4>Expected outcome</h4><p>${status === "pass" ? "The requirement currently passes or the linked issue is resolved." : status === "fail" ? "The requirement is failing and needs remediation." : "Verification is still pending or in progress."}</p>${linkedIssue ? `<p class="muted"><b>Linked issue:</b> ${escapeHtml(issueTitle(linkedIssue))}</p>` : ""}</section></div>${linkedIssue ? `<div class="evidence"><b>Developer note:</b> ${escapeHtml(recommendedFix(linkedIssue))}</div>` : ""}</td>
        </tr>
      </tbody>`;
  }).join("");

  const caseStatusOptions = ["pass", "fail", "pending"].filter(status => testCases.some((tc: any) => (tc.status === status || (status === "pending" && tc.status !== "pass" && tc.status !== "fail")))).map(status => `<label><input type="checkbox" data-case-filter="status" value="${status}"> ${status === "pass" ? "Pass" : status === "fail" ? "Fail" : "In progress"}</label>`).join("");
  const caseTypeOptions = ["automated", "manual", "hybrid"].filter(type => testCases.some((tc: any) => { const text = `${tc.category || ""} ${tc.status || ""}`.toLowerCase(); const actual = text.includes("hybrid") ? "hybrid" : text.includes("manual") ? "manual" : "automated"; return actual === type; })).map(type => `<label><input type="checkbox" data-case-filter="type" value="${type}"> ${type[0].toUpperCase()}${type.slice(1)}</label>`).join("");
  const stateCounts = issues.reduce((acc: Record<string, number>, issue: any) => { const state = issue.state_label || issue.phase || "default"; acc[state] = (acc[state] || 0) + 1; return acc; }, {});
  const stateRows = Object.entries(stateCounts).map(([state, count], index) => `<tr><td>${index + 1}</td><td>${escapeHtml(state)}</td><td>${count}</td><td>${issues.filter((issue: any) => (issue.state_label || issue.phase || "default") === state && issue.evidence_screenshot).length}</td></tr>`).join("");
  const urlList = urls.map((url) => `<li title="${escapeAttr(url)}">${escapeHtml(compactUrl(url))}</li>`).join("");
  const contentOptions = [
    ["executive", "Executive report"],
    ["summary", "Summary"],
    ["testcases", "Test cases"],
    ["states", "UI states"],
    ["issues", "Issues / developer evidence"],
  ].map(([value, label]) => `<label><input type="checkbox" data-section-filter value="${value}" ${selectedSections.has(value as ReportSection) ? "checked" : ""}> ${label}</label>`).join("");
  const initialFocusSection = selectedSections.size === 1 ? Array.from(selectedSections)[0] : "";

  const css = `
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f7fb; color: #172033; font-family: Arial, "Segoe UI", sans-serif; font-size: 13px; line-height: 1.45; }
    a { color: #0f766e; }
    .page { max-width: 1180px; margin: 0 auto; padding: 22px; }
    .report { background: #fff; border: 1px solid #d7deea; border-radius: 14px; overflow: hidden; box-shadow: 0 10px 24px rgba(15,23,42,.08); }
    header { padding: 22px 26px; background: linear-gradient(135deg,#f4f1ff,#ecfeff); border-bottom: 1px solid #d7deea; }
    .topline { display:flex; align-items:flex-start; justify-content:space-between; gap: 18px; }
    .brand { color:#0f766e; font-size:12px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    h1 { margin: 6px 0 5px; font-size: 28px; line-height: 1.15; color:#111827; }
    .subtitle { color:#5b6476; margin:0; max-width:760px; }
    .meta { color:#667085; font-size:12px; text-align:right; min-width:210px; }
    .metrics { display:grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap:10px; margin-top:18px; }
    .metric { background:rgba(255,255,255,.75); border:1px solid #d9deea; border-radius:12px; padding:12px; }
    .metric strong { display:block; font-size:24px; color:#111827; line-height:1.1; }
    .metric span { color:#667085; font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
    .section { padding: 18px 26px; border-bottom:1px solid #e7eaf2; }
    .section:last-child { border-bottom:0; }
    h2 { margin:0 0 12px; font-size:18px; color:#172033; }
    .summary-grid { display:grid; grid-template-columns: 1.2fr 1fr; gap:14px; }
    .counts { display:grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap:10px; }
    .count-card { border:1px solid #d9deea; border-radius:10px; padding:11px; background:#fbfcff; }
    .count-card strong { display:block; font-size:20px; }
    .count-card span { color:#667085; font-size:12px; text-transform:capitalize; }
    .url-box { border:1px solid #d9deea; border-radius:10px; background:#fbfcff; padding:11px; }
    .url-box ul { margin:0; padding-left:18px; max-height:92px; overflow:auto; }
    .url-box li { margin-bottom:4px; color:#475569; word-break:break-all; }
    .toolbar { display:grid; grid-template-columns: minmax(220px,1fr) auto; gap:10px; align-items:center; background:#fff; padding: 0 0 12px; z-index:2; position:relative; }
    .contents-toolbar { grid-template-columns: 1fr; }
    .section-picker { display:flex; flex-wrap:wrap; gap:8px; align-items:center; border:1px solid #d9deea; border-radius:12px; padding:10px; background:#fbfcff; }
    .section-picker strong { color:#172033; margin-right:6px; }
    .section-picker label { display:inline-flex; align-items:center; gap:7px; border:1px solid #cbd5e1; border-radius:999px; padding:7px 10px; background:#fff; color:#334155; cursor:pointer; }
    .section-picker label:has(input:checked) { border-color:#0f766e; background:#ecfdf5; color:#0f766e; }
    .section-picker input { width:auto; }
    input, select, button { font: inherit; }
    input[type="search"] { width:100%; border:1px solid #cbd5e1; border-radius:9px; padding:9px 10px; background:#fff; color:#172033; }
    .small-btn { border:1px solid #0f766e; color:#0f766e; background:#ecfdf5; border-radius:9px; padding:9px 11px; cursor:pointer; white-space:nowrap; }
    .filter-wrap { position:relative; }
    .filter-panel { position:fixed; right:max(18px, calc((100vw - 1180px) / 2 + 18px)); top:142px; width:340px; max-width:calc(100vw - 36px); max-height:calc(100vh - 170px); overflow:auto; background:#fff; border:1px solid #cbd5e1; border-radius:12px; box-shadow:0 16px 34px rgba(15,23,42,.16); padding:14px; z-index:20; }
    .filter-panel[hidden] { display:none; }
    .filter-head { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; }
    .filter-group { border-top:1px solid #eef2f7; padding-top:10px; margin-top:10px; }
    .filter-group strong { display:block; color:#475569; font-size:11px; text-transform:uppercase; letter-spacing:.06em; margin-bottom:7px; }
    .filter-group label { display:flex; align-items:center; gap:8px; color:#334155; font-size:12px; padding:4px 0; }
    .filter-group input { width:auto; }
    #filter-count:not([hidden]), #content-count:not([hidden]) { display:inline-flex; align-items:center; justify-content:center; min-width:18px; height:18px; margin-left:4px; border-radius:999px; background:#0f766e; color:#fff; font-size:11px; }
    .table-wrap { border:1px solid #d9deea; border-radius:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; min-width:860px; table-layout:fixed; }
    .case-table col:nth-child(1), .issue-table col:nth-child(1) { width:48px; }
    .case-table col:nth-child(2) { width:auto; }
    .case-table col:nth-child(3) { width:112px; }
    .case-table col:nth-child(4) { width:92px; }
    .case-table col:nth-child(5) { width:140px; }
    .case-table col:nth-child(6) { width:82px; }
    .case-table col:nth-child(7) { width:190px; }
    .issue-table col:nth-child(2) { width:auto; }
    .issue-table col:nth-child(3) { width:104px; }
    .issue-table col:nth-child(4) { width:78px; }
    .issue-table col:nth-child(5) { width:130px; }
    .issue-table col:nth-child(6) { width:86px; }
    .issue-table col:nth-child(7) { width:180px; }
    .issue-table col:nth-child(8) { width:86px; }
    th { background:#f8fafc; color:#64748b; font-size:11px; letter-spacing:.05em; text-transform:uppercase; text-align:left; padding:10px; border-bottom:1px solid #e2e8f0; position:static; }
    td { padding:10px; border-bottom:1px solid #eef2f7; vertical-align:top; }
    tbody:last-child td { border-bottom:0; }
    .narrow { width:46px; color:#667085; text-align:center; }
    .issue-row:hover td, .case-row:hover td { background:#fbfcff; }
    .expand { width:26px; height:26px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; color:#0f766e; font-weight:800; cursor:pointer; float:left; margin-right:8px; }
    .issue-main { display:grid; gap:4px; min-width:0; }
    .issue-main strong { color:#172033; font-size:13px; line-height:1.35; overflow-wrap:anywhere; }
    .case-summary { color:#667085; font-size:12px; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .muted { color:#667085; font-size:12px; }
    .url-chip { display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border:1px solid #d9deea; border-radius:999px; background:#f8fafc; color:#475569; padding:3px 8px; font-size:11px; }
    .pill { display:inline-flex; border-radius:999px; border:1px solid color-mix(in srgb, var(--pill), white 62%); background:color-mix(in srgb, var(--pill), white 92%); color:var(--pill); padding:3px 8px; font-size:11px; font-weight:800; text-transform:capitalize; }
    .issue-id { color:#475569; font-family:Consolas,monospace; font-size:12px; }
    .status { display:inline-flex; border-radius:999px; padding:3px 8px; font-size:11px; font-weight:800; }
    .status.pass { color:#047857; background:#ecfdf5; } .status.fail { color:#be123c; background:#fff1f2; } .status.pending { color:#475569; background:#f1f5f9; }
    .note { border:1px solid #d9deea; border-radius:10px; background:#fbfcff; padding:12px; color:#475569; }
    .details-row td { background:#fbfcff; }
    .details-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .details-grid section, .evidence, .selectors, .screenshot, .evidence-pack { border:1px solid #d9deea; border-radius:10px; padding:11px; background:#fff; margin-bottom:10px; }
    h4 { margin:0 0 6px; color:#172033; font-size:13px; }
    p { margin:0 0 6px; color:#475569; }
    details summary { cursor:pointer; color:#0f766e; font-weight:700; }
    code { background:#eef2f7; border-radius:5px; padding:2px 5px; color:#334155; word-break:break-all; }
    ol { margin:8px 0 0 18px; padding:0; }
    li { margin-bottom:4px; }
    .screenshot img, .evidence-pack img { display:block; max-width:100%; max-height:320px; object-fit:contain; border:1px solid #d9deea; border-radius:8px; margin-top:10px; }
    .selector-samples { border-top:1px solid #eef2f7; margin-top:10px; padding-top:10px; }
    .empty { padding:18px; color:#667085; text-align:center; }
    .print-note { color:#667085; font-size:12px; margin-top:10px; }
    .footer { display:flex; justify-content:space-between; gap:12px; padding:16px 26px 22px; color:#667085; font-size:11px; }
    @media print {
      body { background:#fff; }
      .page { padding:0; max-width:none; }
      .report { border:0; border-radius:0; box-shadow:none; }
      .toolbar, .expand, .small-btn, .filter-panel { display:none !important; }
      .details-row[hidden] { display:table-row !important; }
      .details-row { break-inside:avoid; }
      th { position:static; }
      table { min-width:0; }
      .table-wrap { overflow:visible; border:0; }
      header, .section, .footer { padding-left:0; padding-right:0; }
      .section[hidden] { display:none !important; }
    }
    @media (max-width: 860px) {
      .topline, .summary-grid, .details-grid { grid-template-columns:1fr; display:grid; }
      .meta { text-align:left; }
      .metrics, .counts, .toolbar { grid-template-columns:1fr; }
      .page { padding:12px; }
      header, .section { padding:18px; }
    }
  `;

  const script = `
    const groups = Array.from(document.querySelectorAll('.issue-group'));
    const caseGroups = Array.from(document.querySelectorAll('.case-group'));
    const search = document.getElementById('search');
    const caseSearch = document.getElementById('case-search');
    const shown = document.getElementById('shown-count');
    const caseShown = document.getElementById('case-shown-count');
    const filterButton = document.getElementById('filter-button');
    const filterPanel = document.getElementById('filter-panel');
    const filterCount = document.getElementById('filter-count');
    const caseFilterButton = document.getElementById('case-filter-button');
    const caseFilterPanel = document.getElementById('case-filter-panel');
    const contentButton = document.getElementById('content-button');
    const contentPanel = document.getElementById('content-panel');
    const contentCount = document.getElementById('content-count');
    const checks = Array.from(document.querySelectorAll('[data-filter]'));
    const caseChecks = Array.from(document.querySelectorAll('[data-case-filter]'));
    const sectionChecks = Array.from(document.querySelectorAll('[data-section-filter]'));
    const sections = Array.from(document.querySelectorAll('[data-report-section]'));
    const initialFocusSection = ${JSON.stringify(initialFocusSection)};

    function selectedValues(name) { return checks.filter(input => input.dataset.filter === name && input.checked).map(input => input.value); }
    function selectedCaseValues(name) { return caseChecks.filter(input => input.dataset.caseFilter === name && input.checked).map(input => input.value); }
    function includesSelected(selected, value) { return selected.length === 0 || selected.includes(value); }
    function closeFilterPanels(except) {
      [filterPanel, caseFilterPanel, contentPanel].filter(Boolean).forEach(panel => {
        if (panel !== except) panel.hidden = true;
      });
      if (filterPanel !== except) filterButton?.setAttribute('aria-expanded', 'false');
      if (caseFilterPanel !== except) caseFilterButton?.setAttribute('aria-expanded', 'false');
      if (contentPanel !== except) contentButton?.setAttribute('aria-expanded', 'false');
    }
    function togglePanel(button, panel) {
      if (!button || !panel) return;
      const open = panel.hidden;
      closeFilterPanels(open ? panel : null);
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    }
    function openRelevantFilters(sectionName) {
      if (sectionName === 'testcases' && caseFilterPanel) {
        closeFilterPanels(caseFilterPanel);
        caseFilterPanel.hidden = false;
        caseFilterButton?.setAttribute('aria-expanded', 'true');
      } else if (sectionName === 'issues' && filterPanel) {
        closeFilterPanels(filterPanel);
        filterPanel.hidden = false;
        filterButton?.setAttribute('aria-expanded', 'true');
      } else {
        closeFilterPanels(null);
      }
    }

    function applySectionFilters(focusSection) {
      const selected = sectionChecks.filter(input => input.checked).map(input => input.value);
      sections.forEach(section => { section.hidden = selected.length > 0 && !selected.includes(section.dataset.reportSection); });
      if (contentCount) {
        contentCount.textContent = selected.length ? String(selected.length) : '';
        contentCount.hidden = selected.length === 0;
      }
      if (focusSection) {
        const target = sections.find(section => section.dataset.reportSection === focusSection && !section.hidden);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        openRelevantFilters(focusSection);
      }
    }

    function applyFilters() {
      const q = (search?.value || '').trim().toLowerCase();
      const selectedSeverity = selectedValues('severity');
      const selectedPriority = selectedValues('priority');
      const selectedLevel = selectedValues('level');
      const activeCount = selectedSeverity.length + selectedPriority.length + selectedLevel.length;
      if (filterCount) {
        filterCount.textContent = activeCount ? String(activeCount) : '';
        filterCount.hidden = activeCount === 0;
      }
      let visible = 0;
      groups.forEach(group => {
        const ok = (!q || group.dataset.search.includes(q)) && includesSelected(selectedSeverity, group.dataset.severity) && includesSelected(selectedPriority, group.dataset.priority) && includesSelected(selectedLevel, group.dataset.level);
        group.hidden = !ok;
        if (ok) visible += 1;
      });
      if (shown) shown.textContent = String(visible);
    }

    function applyCaseFilters() {
      const q = (caseSearch?.value || '').trim().toLowerCase();
      const selectedStatus = selectedCaseValues('status');
      const selectedType = selectedCaseValues('type');
      let visible = 0;
      caseGroups.forEach(group => {
        const ok = (!q || group.dataset.search.includes(q)) && includesSelected(selectedStatus, group.dataset.caseStatus) && includesSelected(selectedType, group.dataset.caseType);
        group.hidden = !ok;
        if (ok) visible += 1;
      });
      if (caseShown) caseShown.textContent = String(visible);
    }

    if (search) search.addEventListener('input', applyFilters);
    if (caseSearch) caseSearch.addEventListener('input', applyCaseFilters);
    checks.forEach(input => input.addEventListener('change', applyFilters));
    caseChecks.forEach(input => input.addEventListener('change', applyCaseFilters));
    sectionChecks.forEach(input => input.addEventListener('change', () => applySectionFilters(input.checked ? input.value : null)));
    if (filterButton) filterButton.addEventListener('click', () => togglePanel(filterButton, filterPanel));
    if (caseFilterButton) caseFilterButton.addEventListener('click', () => togglePanel(caseFilterButton, caseFilterPanel));
    if (contentButton) contentButton.addEventListener('click', () => togglePanel(contentButton, contentPanel));
    document.getElementById('select-all-sections')?.addEventListener('click', () => { sectionChecks.forEach(input => input.checked = true); applySectionFilters('testcases'); });
    document.getElementById('executive-only')?.addEventListener('click', () => { sectionChecks.forEach(input => input.checked = input.value === 'executive'); applySectionFilters('executive'); });
    document.addEventListener('click', event => { if (!event.target.closest('.filter-wrap') && !event.target.closest('.section-picker')) closeFilterPanels(null); });
    document.getElementById('clear-filters')?.addEventListener('click', () => { checks.forEach(input => { input.checked = false; }); applyFilters(); });
    document.getElementById('clear-case-filters')?.addEventListener('click', () => { caseChecks.forEach(input => { input.checked = false; }); applyCaseFilters(); });
    document.querySelectorAll('.expand').forEach(button => button.addEventListener('click', () => { const row = document.getElementById(button.getAttribute('aria-controls')); if (!row) return; const expanded = button.getAttribute('aria-expanded') === 'true'; button.setAttribute('aria-expanded', String(!expanded)); button.textContent = expanded ? '+' : '-'; row.hidden = expanded; }));
    document.getElementById('expand-all')?.addEventListener('click', () => { const expand = document.getElementById('expand-all').dataset.expanded !== 'true'; document.querySelectorAll('.expand').forEach(button => { const row = document.getElementById(button.getAttribute('aria-controls')); button.setAttribute('aria-expanded', String(expand)); button.textContent = expand ? '-' : '+'; if (row) row.hidden = !expand; }); document.getElementById('expand-all').dataset.expanded = String(expand); document.getElementById('expand-all').textContent = expand ? 'Collapse all' : 'Expand all'; });
    applySectionFilters(); applyFilters(); applyCaseFilters();
    if (initialFocusSection) window.setTimeout(() => applySectionFilters(initialFocusSection), 120);
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Interactive Accessibility Report - ${escapeHtml(scan.name || "Scan")}</title>
  <style>${css}</style>
</head>
<body>
  <main class="page">
    <div class="report">
      <header>
        <div class="topline">
          <div>
            <div class="brand">Interactive Accessibility Report</div>
            <h1>${escapeHtml(scan.name || "Accessibility Audit")}</h1>
            <p class="subtitle">Choose the report contents you need. Test cases are listed first because they describe what a tester must verify; issues remain available as developer evidence.</p>
          </div>
          <div class="meta">
            <div>Generated ${escapeHtml(format(new Date(), "MMM d, yyyy HH:mm"))}</div>
            ${completedAt ? `<div>Completed ${escapeHtml(format(completedAt, "MMM d, yyyy HH:mm"))}</div>` : ""}
            <div>Scan ID ${escapeHtml(scanId)}</div>
          </div>
        </div>
        <div class="metrics">
          <div class="metric"><strong>${score}/100</strong><span>Score</span></div>
          <div class="metric"><strong>${unresolvedIssues.length}</strong><span>Open issues</span></div>
          <div class="metric"><strong>${testCases.length}</strong><span>Test cases</span></div>
          <div class="metric"><strong>${urls.length}</strong><span>URLs scanned</span></div>
          <div class="metric"><strong>${passCount}/${testCases.length || 0}</strong><span>Tests passed</span></div>
        </div>
      </header>

      <section class="section">
        <div class="toolbar contents-toolbar">
          <div class="section-picker" aria-label="Report contents">
            <strong>Report contents</strong>
            ${contentOptions}
            <button id="select-all-sections" class="small-btn" type="button">All</button>
            <button id="executive-only" class="small-btn" type="button">Executive</button>
          </div>
        </div>
      </section>
      ${hasReportSection(selectedSections, "executive") ? `<section class="section" data-report-section="executive"><h2>Executive Report</h2><div class="note"><p><b>Overall position:</b> The scan produced a score of ${score}/100 with ${unresolvedIssues.length} unresolved issue groups and ${testCases.length} verification cases.</p><p><b>Immediate focus:</b> Prioritize ${sevCounts.critical || 0} critical and ${sevCounts.serious || 0} serious issue groups, then use the test case section to confirm fixes in real user flows.</p><p><b>Why test cases are shown first:</b> they translate scanner findings into pass, fail, and in-progress verification work that testers can execute and managers can track.</p></div></section>` : ""}

      ${hasReportSection(selectedSections, "summary") ? `<section class="section" data-report-section="summary">
        <div class="summary-grid">
          <div>
            <h2>Issue Summary</h2>
            <div class="counts">
              ${["critical", "serious", "moderate", "minor"].map((sev) => `<div class="count-card"><strong style="color:${severityColor(sev)}">${sevCounts[sev] || 0}</strong><span>${sev}</span></div>`).join("")}
            </div>
          </div>
          <div>
            <h2>Scanned Pages</h2>
            <div class="url-box"><ul>${urlList || "<li>No URL recorded.</li>"}</ul></div>
          </div>
        </div>
      </section>` : ""}

      ${hasReportSection(selectedSections, "testcases") ? `<section class="section" data-report-section="testcases"><h2>Test Cases <span class="muted">(<span id="case-shown-count">${testCases.length}</span> shown of ${testCases.length})</span></h2><div class="toolbar" aria-label="Test case filters"><input id="case-search" type="search" placeholder="Search test cases..." /><div class="filter-wrap"><button id="case-filter-button" class="small-btn" type="button" aria-expanded="false" aria-controls="case-filter-panel">Filters</button><div id="case-filter-panel" class="filter-panel" hidden><div class="filter-head"><strong>Filter test cases</strong><button id="clear-case-filters" class="small-btn" type="button">Clear</button></div><div class="filter-group"><strong>Status</strong>${caseStatusOptions || "<span class='muted'>No status filters</span>"}</div><div class="filter-group"><strong>Type</strong>${caseTypeOptions || "<span class='muted'>No type filters</span>"}</div></div></div></div><div class="table-wrap"><table class="case-table"><colgroup><col><col><col><col><col><col><col></colgroup><thead><tr><th>#</th><th>Test case</th><th>Status</th><th>Type</th><th>WCAG</th><th>Priority</th><th>Page</th></tr></thead>${caseRows || `<tbody><tr><td colspan="7" class="empty">No test cases available.</td></tr></tbody>`}</table></div></section>` : ""}
      ${hasReportSection(selectedSections, "states") ? `<section class="section" data-report-section="states"><h2>UI States</h2><p class="note" style="margin-bottom:12px">UI states summarize issues captured during default, hover, focus, expanded, error, keyboard, zoom, or similar interaction states.</p><div class="table-wrap"><table><thead><tr><th>#</th><th>State</th><th>Issues</th><th>Screenshot evidence</th></tr></thead><tbody>${stateRows || `<tr><td colspan="4" class="empty">No UI state data captured.</td></tr>`}</tbody></table></div></section>` : ""}

      ${hasReportSection(selectedSections, "issues") ? `<section class="section" data-report-section="issues">
        <h2>Issues / Developer Evidence <span class="muted">(<span id="shown-count">${sortedIssues.length}</span> shown of ${sortedIssues.length})</span></h2>
        <div class="toolbar" aria-label="Issue filters">
          <input id="search" type="search" placeholder="Search issue, rule, URL, selector..." />
          <div class="filter-wrap">
            <button id="filter-button" class="small-btn" type="button" aria-expanded="false" aria-controls="filter-panel">Filters <span id="filter-count" hidden></span></button>
            <div id="filter-panel" class="filter-panel" hidden>
              <div class="filter-head"><strong>Filter issues</strong><button id="clear-filters" class="small-btn" type="button">Clear</button></div>
              <div class="filter-group"><strong>Severity</strong>${severityOptions || "<span class='muted'>No severity filters</span>"}</div>
              <div class="filter-group"><strong>Priority</strong>${priorityOptions || "<span class='muted'>No priority filters</span>"}</div>
              <div class="filter-group"><strong>WCAG level</strong>${levelOptions || "<span class='muted'>No WCAG filters</span>"}</div>
            </div>
          </div>
        </div>
        <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; margin-bottom:10px;">
          <button id="expand-all" class="small-btn" type="button">Expand all</button>
          <div class="print-note">Tip: expand rows before printing if you want details visible in the PDF.</div>
        </div>
        <div class="table-wrap">
          <table class="issue-table">
            <colgroup><col><col><col><col><col><col><col><col></colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>Issue</th>
                <th>Severity</th>
                <th>Priority</th>
                <th>WCAG</th>
                <th>Affected</th>
                <th>Page</th>
                <th>ID</th>
              </tr>
            </thead>
            ${issueRows || `<tbody><tr><td colspan="8" class="empty">No unresolved issues found.</td></tr></tbody>`}
          </table>
        </div>
      </section>` : ""}

      <footer class="footer">
        <span>Accessibility report generated by Accessibility</span>
        <span>Interactive HTML report. Choose sections before printing when a PDF copy is needed.</span>
      </footer>
    </div>
  </main>
  <script>${script}</script>
</body>
</html>`;
}








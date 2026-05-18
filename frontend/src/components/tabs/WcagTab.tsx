import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { issueApi, scanApi } from "../../services/api";
import { motion } from "framer-motion";
import {
  ShieldCheck, CheckCircle2, XCircle, AlertCircle, Loader2,
  Eye, MousePointerClick, FileText, Wrench,
} from "lucide-react";
import { normalizeCriterion, levelColor, getIssueCriteria } from "../../utils/wcag";

interface WcagTabProps {
  scanId: string;
}

interface WcagRule {
  sc: string;
  title: string;
  level: "A" | "AA" | "AAA";
  category: "Perceivable" | "Operable" | "Understandable" | "Robust";
}

const WCAG_RULES: WcagRule[] = [
  // Perceivable
  { sc: "1.1.1",  title: "Non-text Content",                     level: "A",   category: "Perceivable" },
  { sc: "1.3.1",  title: "Info and Relationships",               level: "A",   category: "Perceivable" },
  { sc: "1.3.2",  title: "Meaningful Sequence",                  level: "A",   category: "Perceivable" },
  { sc: "1.3.3",  title: "Sensory Characteristics",              level: "A",   category: "Perceivable" },
  { sc: "1.3.4",  title: "Orientation",                          level: "AA",  category: "Perceivable" },
  { sc: "1.3.5",  title: "Identify Input Purpose",               level: "AA",  category: "Perceivable" },
  { sc: "1.4.1",  title: "Use of Color",                         level: "A",   category: "Perceivable" },
  { sc: "1.4.2",  title: "Audio Control",                        level: "A",   category: "Perceivable" },
  { sc: "1.4.3",  title: "Contrast (Minimum)",                   level: "AA",  category: "Perceivable" },
  { sc: "1.4.4",  title: "Resize Text",                          level: "AA",  category: "Perceivable" },
  { sc: "1.4.5",  title: "Images of Text",                       level: "AA",  category: "Perceivable" },
  { sc: "1.4.10", title: "Reflow",                               level: "AA",  category: "Perceivable" },
  { sc: "1.4.11", title: "Non-text Contrast",                    level: "AA",  category: "Perceivable" },
  { sc: "1.4.12", title: "Text Spacing",                         level: "AA",  category: "Perceivable" },
  { sc: "1.4.13", title: "Content on Hover or Focus",            level: "AA",  category: "Perceivable" },
  // Operable
  { sc: "2.1.1",  title: "Keyboard",                             level: "A",   category: "Operable" },
  { sc: "2.1.2",  title: "No Keyboard Trap",                     level: "A",   category: "Operable" },
  { sc: "2.1.4",  title: "Character Key Shortcuts",              level: "A",   category: "Operable" },
  { sc: "2.2.1",  title: "Timing Adjustable",                    level: "A",   category: "Operable" },
  { sc: "2.2.2",  title: "Pause, Stop, Hide",                    level: "A",   category: "Operable" },
  { sc: "2.4.1",  title: "Bypass Blocks",                        level: "A",   category: "Operable" },
  { sc: "2.4.2",  title: "Page Titled",                          level: "A",   category: "Operable" },
  { sc: "2.4.3",  title: "Focus Order",                          level: "A",   category: "Operable" },
  { sc: "2.4.4",  title: "Link Purpose (In Context)",            level: "A",   category: "Operable" },
  { sc: "2.4.5",  title: "Multiple Ways",                        level: "AA",  category: "Operable" },
  { sc: "2.4.6",  title: "Headings and Labels",                  level: "AA",  category: "Operable" },
  { sc: "2.4.7",  title: "Focus Visible",                        level: "AA",  category: "Operable" },
  { sc: "2.5.1",  title: "Pointer Gestures",                     level: "A",   category: "Operable" },
  { sc: "2.5.2",  title: "Pointer Cancellation",                 level: "A",   category: "Operable" },
  { sc: "2.5.3",  title: "Label in Name",                        level: "A",   category: "Operable" },
  { sc: "2.5.4",  title: "Motion Actuation",                     level: "A",   category: "Operable" },
  { sc: "2.5.8",  title: "Target Size (Minimum)",                level: "AA",  category: "Operable" },
  // Understandable
  { sc: "3.1.1",  title: "Language of Page",                     level: "A",   category: "Understandable" },
  { sc: "3.1.2",  title: "Language of Parts",                    level: "AA",  category: "Understandable" },
  { sc: "3.2.1",  title: "On Focus",                             level: "A",   category: "Understandable" },
  { sc: "3.2.2",  title: "On Input",                             level: "A",   category: "Understandable" },
  { sc: "3.2.3",  title: "Consistent Navigation",                level: "AA",  category: "Understandable" },
  { sc: "3.2.4",  title: "Consistent Identification",            level: "AA",  category: "Understandable" },
  { sc: "3.3.1",  title: "Error Identification",                 level: "A",   category: "Understandable" },
  { sc: "3.3.2",  title: "Labels or Instructions",               level: "A",   category: "Understandable" },
  { sc: "3.3.3",  title: "Error Suggestion",                     level: "AA",  category: "Understandable" },
  { sc: "3.3.4",  title: "Error Prevention (Legal, Financial)",  level: "AA",  category: "Understandable" },
  // Robust
  { sc: "4.1.2",  title: "Name, Role, Value",                    level: "A",   category: "Robust" },
  { sc: "4.1.3",  title: "Status Messages",                      level: "AA",  category: "Robust" },
];

const CATEGORY_ORDER: Array<WcagRule["category"]> = ["Perceivable", "Operable", "Understandable", "Robust"];

const CATEGORY_INFO: Record<WcagRule["category"], { description: string; icon: any }> = {
  Perceivable:    { description: "Information and interface components must be presentable to users in ways they can perceive.", icon: Eye },
  Operable:       { description: "Interface components and navigation must be operable.",                                       icon: MousePointerClick },
  Understandable: { description: "Information and operation of the interface must be understandable.",                          icon: FileText },
  Robust:         { description: "Content must be robust enough for assistive technologies to interpret reliably.",             icon: Wrench },
};

type RuleStatus = "pass" | "fail" | "manual";

interface AnalyzedRule extends WcagRule {
  status: RuleStatus;
  failureCount: number;
  affectedPages: number;
}

export default function WcagTab({ scanId }: WcagTabProps) {
  const { data: issuesData, isLoading: issuesLoading } = useQuery({
    queryKey: ["wcag-issues", scanId],
    queryFn: () => issueApi.list({ scan_id: scanId, page: 1, limit: 1000 }),
    enabled: Boolean(scanId),
  });
  const { data: testCasesData, isLoading: tcLoading } = useQuery({
    queryKey: ["wcag-testcases", scanId],
    queryFn: () => scanApi.testCases(scanId),
    enabled: Boolean(scanId),
  });

  const issues: any[] = issuesData?.data?.issues || [];
  const testCases: any[] = testCasesData?.data?.test_cases || [];

  const analyzed: AnalyzedRule[] = useMemo(() => {
    const failuresByCriterion: Record<string, { count: number; pages: Set<string> }> = {};
    for (const issue of issues) {
      const criteria = getIssueCriteria(issue);
      for (const sc of criteria) {
        if (!failuresByCriterion[sc]) failuresByCriterion[sc] = { count: 0, pages: new Set() };
        failuresByCriterion[sc].count += 1;
        if (issue.url) failuresByCriterion[sc].pages.add(issue.url);
      }
    }
    const manualCriteria = new Set<string>();
    for (const tc of testCases) {
      if (tc.status === "pass") continue;
      const ref = String(tc.wcag_ref || "");
      const matches = ref.match(/\d+\.\d+\.\d+/g) || [];
      for (const m of matches) {
        const sc = normalizeCriterion(m);
        if (sc) manualCriteria.add(sc);
      }
    }
    return WCAG_RULES.map(rule => {
      const fail = failuresByCriterion[rule.sc];
      const failureCount = fail?.count || 0;
      const affectedPages = fail ? fail.pages.size : 0;
      const status: RuleStatus =
        failureCount > 0 ? "fail" :
        manualCriteria.has(rule.sc) ? "manual" : "pass";
      return { ...rule, status, failureCount, affectedPages };
    });
  }, [issues, testCases]);

  const summary = useMemo(() => ({
    total: analyzed.length,
    passed: analyzed.filter(r => r.status === "pass").length,
    failed: analyzed.filter(r => r.status === "fail").length,
    manual: analyzed.filter(r => r.status === "manual").length,
  }), [analyzed]);

  const isLoading = issuesLoading || tcLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={20} className="animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <ShieldCheck size={20} className="text-accent" />
        <div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-strong)" }}>WCAG 2.1 Coverage</h2>
          <p className="text-xs text-slate-600 mt-0.5">
            Status of {analyzed.length} success criteria tested in this scan
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <SummaryCard label="Total Criteria" value={summary.total} />
        <SummaryCard label="Passed"         value={summary.passed} tone="success" Icon={CheckCircle2} />
        <SummaryCard label="Failed"         value={summary.failed} tone="error"   Icon={XCircle} />
        <SummaryCard label="Needs Manual"   value={summary.manual} tone="warning" Icon={AlertCircle} />
      </div>

      {CATEGORY_ORDER.map((category, idx) => {
        const rules = analyzed.filter(r => r.category === category);
        const cInfo = CATEGORY_INFO[category];
        const passCount = rules.filter(r => r.status === "pass").length;
        const failCount = rules.filter(r => r.status === "fail").length;
        const manualCount = rules.filter(r => r.status === "manual").length;
        return (
          <motion.div
            key={category}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.05 }}
            className="rounded-xl overflow-hidden"
            style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}
          >
            <div className="px-5 py-4 flex items-start justify-between gap-3" style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-start gap-2.5">
                <cInfo.icon size={16} className="text-accent mt-0.5" />
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
                    {idx + 1}. {category}
                  </h3>
                  <p className="text-xs text-slate-600 mt-0.5 max-w-xl">{cInfo.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "rgba(34,197,94,0.12)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }}>
                  {passCount} pass
                </span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "rgba(255,77,109,0.12)", color: "#ff4d6d", border: "1px solid rgba(255,77,109,0.3)" }}>
                  {failCount} fail
                </span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "rgba(255,159,67,0.12)", color: "#ff9f43", border: "1px solid rgba(255,159,67,0.3)" }}>
                  {manualCount} manual
                </span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-slate-600" style={{ borderBottom: "1px solid var(--border)" }}>
                    <th className="px-5 py-2.5 text-left font-medium w-24">SC</th>
                    <th className="px-5 py-2.5 text-left font-medium">Success Criterion</th>
                    <th className="px-5 py-2.5 text-left font-medium w-20">Level</th>
                    <th className="px-5 py-2.5 text-left font-medium w-32">Status</th>
                    <th className="px-5 py-2.5 text-right font-medium w-24">Issues</th>
                    <th className="px-5 py-2.5 text-right font-medium w-24">Pages</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map(rule => (
                    <tr key={rule.sc} className="hover:bg-white/[0.02] transition-colors" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                      <td className="px-5 py-3 font-mono text-xs text-slate-400">{rule.sc}</td>
                      <td className="px-5 py-3 text-slate-200">{rule.title}</td>
                      <td className="px-5 py-3">
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border"
                          style={{ color: levelColor(rule.level), background: `${levelColor(rule.level)}14`, borderColor: `${levelColor(rule.level)}35` }}>
                          {rule.level}
                        </span>
                      </td>
                      <td className="px-5 py-3"><StatusPill status={rule.status} /></td>
                      <td className="px-5 py-3 text-right text-slate-300">
                        {rule.failureCount > 0
                          ? <span className="font-semibold" style={{ color: "#ff4d6d" }}>{rule.failureCount}</span>
                          : <span className="text-slate-700">—</span>}
                      </td>
                      <td className="px-5 py-3 text-right text-slate-400">
                        {rule.affectedPages > 0 ? rule.affectedPages : <span className="text-slate-700">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        );
      })}

      <div className="rounded-xl px-5 py-4" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
        <h3 className="text-xs font-semibold mb-2" style={{ color: "var(--text-strong)" }}>Legend</h3>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-[11px] text-slate-500 items-center">
          <div className="flex items-center gap-2"><StatusPill status="pass" /> No issues found in scope</div>
          <div className="flex items-center gap-2"><StatusPill status="fail" /> One or more automated failures</div>
          <div className="flex items-center gap-2"><StatusPill status="manual" /> Requires human review to confirm</div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, tone = "default", Icon }: { label: string; value: number; tone?: string; Icon?: any }) {
  const toneStyle: Record<string, { color: string; bg: string; border: string }> = {
    default: { color: "#94a3b8", bg: "rgba(148,163,184,0.05)", border: "rgba(148,163,184,0.15)" },
    success: { color: "#22c55e", bg: "rgba(34,197,94,0.08)",   border: "rgba(34,197,94,0.25)" },
    error:   { color: "#ff4d6d", bg: "rgba(255,77,109,0.08)",  border: "rgba(255,77,109,0.25)" },
    warning: { color: "#ff9f43", bg: "rgba(255,159,67,0.08)",  border: "rgba(255,159,67,0.25)" },
  };
  const s = toneStyle[tone] || toneStyle.default;
  return (
    <div className="rounded-xl px-5 py-4" style={{ background: s.bg, border: `1px solid ${s.border}` }}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
        {Icon && <Icon size={14} style={{ color: s.color }} />}
      </div>
      <div className="mt-1.5 text-2xl font-bold" style={{ color: s.color }}>{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: RuleStatus }) {
  const config = {
    pass:   { label: "Pass",   color: "#22c55e", bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.3)",  Icon: CheckCircle2 },
    fail:   { label: "Fail",   color: "#ff4d6d", bg: "rgba(255,77,109,0.12)", border: "rgba(255,77,109,0.3)", Icon: XCircle },
    manual: { label: "Manual", color: "#ff9f43", bg: "rgba(255,159,67,0.12)", border: "rgba(255,159,67,0.3)", Icon: AlertCircle },
  }[status];
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border"
      style={{ color: config.color, background: config.bg, borderColor: config.border }}>
      <config.Icon size={11} /> {config.label}
    </span>
  );
}

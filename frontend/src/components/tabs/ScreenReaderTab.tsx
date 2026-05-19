import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { scanApi } from "../../services/api";
import { motion } from "framer-motion";
import {
  Volume2, Loader2, AlertTriangle, ChevronRight,
  Keyboard, Mic, FileText,
} from "lucide-react";

interface ScreenReaderTabProps {
  scanId: string;
}

interface A11yNode {
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  level?: number;
  pressed?: boolean | string;
  checked?: boolean | string;
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  required?: boolean;
  focused?: boolean;
  valuetext?: string;
  haspopup?: string;
  invalid?: boolean | string;
  children?: A11yNode[];
}

interface Announcement {
  index: number;
  text: string;
  role?: string;
  name?: string;
  problems: string[];
  tabbable: boolean;
}

const INTERACTIVE_ROLES = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "treeitem", "checkbox", "radio", "switch", "textbox", "searchbox",
  "combobox", "listbox", "option", "slider", "spinbutton",
]);
const LANDMARK_ROLES = new Set([
  "banner", "complementary", "contentinfo", "form", "main", "navigation",
  "region", "search",
]);
const SKIP_ROLES = new Set(["none", "presentation"]);

function composeAnnouncement(node: A11yNode): { text: string; problems: string[]; tabbable: boolean } {
  const role = node.role || "";
  const name = (node.name || "").trim();
  const problems: string[] = [];
  let tabbable = false;
  let text = "";

  if (role === "heading") {
    const level = node.level || 1;
    text = name ? `heading level ${level}, ${name}` : `heading level ${level}, (empty)`;
    if (!name) problems.push("Empty heading — screen reader announces 'heading level N, blank'");
  } else if (role === "link") {
    text = name ? `link, ${name}` : `link, (no accessible name)`;
    tabbable = !node.disabled;
    if (!name) problems.push("Link has no accessible name");
    else if (/^(click here|read more|here|learn more|more|leggi di più|clicca qui)$/i.test(name)) {
      problems.push(`Generic link text "${name}" — meaningless out of context`);
    }
  } else if (role === "button") {
    let state = "";
    if (node.disabled) state += ", disabled";
    if (node.pressed === true || node.pressed === "true") state += ", pressed";
    if (node.expanded === true) state += ", expanded";
    else if (node.expanded === false && node.haspopup) state += ", collapsed";
    text = name ? `button, ${name}${state}` : `button, (no accessible name)${state}`;
    tabbable = !node.disabled;
    if (!name) problems.push("Button has no accessible name — screen reader says 'button, blank'");
  } else if (role === "textbox" || role === "searchbox") {
    const value = node.value || node.valuetext || "";
    const req = node.required ? ", required" : "";
    const inv = node.invalid ? ", invalid entry" : "";
    text = name
      ? `edit, ${name}${value ? `, ${value}` : ""}${req}${inv}`
      : `edit, (unlabeled)${value ? `, ${value}` : ""}${req}${inv}`;
    tabbable = !node.disabled;
    if (!name) problems.push("Form field has no label");
  } else if (role === "checkbox") {
    const state = node.checked === true || node.checked === "true" ? "checked"
                : node.checked === "mixed" ? "partially checked"
                : "not checked";
    text = name ? `checkbox, ${name}, ${state}` : `checkbox, (unlabeled), ${state}`;
    tabbable = !node.disabled;
    if (!name) problems.push("Checkbox has no label");
  } else if (role === "radio") {
    const state = node.checked === true ? "selected" : "not selected";
    text = name ? `radio button, ${name}, ${state}` : `radio button, (unlabeled), ${state}`;
    tabbable = !node.disabled;
    if (!name) problems.push("Radio button has no label");
  } else if (role === "combobox") {
    const value = node.value || node.valuetext || "";
    text = name ? `combobox, ${name}${value ? `, ${value}` : ""}` : `combobox, (unlabeled)${value ? `, ${value}` : ""}`;
    tabbable = !node.disabled;
    if (!name) problems.push("Combobox has no label");
  } else if (role === "image" || role === "img" || role === "graphic") {
    text = name ? `image, ${name}` : `unlabeled image`;
    if (!name) problems.push("Image has no alt text");
  } else if (role === "list") {
    const count = (node.children || []).filter(c => c.role === "listitem").length;
    text = `list, ${count} items`;
  } else if (role === "listitem") {
    text = name || (node.children?.[0]?.name) || "list item";
  } else if (role === "table") {
    text = name ? `table, ${name}` : `table`;
  } else if (LANDMARK_ROLES.has(role)) {
    text = name ? `${role}, ${name}` : role;
    if (role === "navigation" && !name) {
      problems.push("Navigation landmark not labeled — multiple navs are indistinguishable");
    }
  } else if (role === "dialog" || role === "alertdialog") {
    text = name ? `dialog, ${name}` : `dialog, (unlabeled)`;
    if (!name) problems.push("Dialog has no accessible name");
  } else if (role === "alert") {
    text = name ? `alert, ${name}` : `alert`;
  } else if (role === "tab") {
    const state = node.selected ? ", selected" : "";
    text = name ? `tab, ${name}${state}` : `tab, (unlabeled)${state}`;
    tabbable = true;
  } else if (INTERACTIVE_ROLES.has(role)) {
    text = name ? `${role}, ${name}` : `${role}, (no accessible name)`;
    tabbable = !node.disabled;
    if (!name) problems.push(`Interactive ${role} has no accessible name`);
  } else if (name && !SKIP_ROLES.has(role) && role !== "generic") {
    text = name;
  }

  return { text, problems, tabbable };
}

function flattenTree(node: A11yNode | undefined, out: Announcement[] = []): Announcement[] {
  if (!node) return out;
  const composed = composeAnnouncement(node);
  if (composed.text) {
    out.push({
      index: out.length + 1,
      text: composed.text,
      role: node.role,
      name: node.name,
      problems: composed.problems,
      tabbable: composed.tabbable,
    });
  }
  for (const child of node.children || []) flattenTree(child, out);
  return out;
}

export default function ScreenReaderTab({ scanId }: ScreenReaderTabProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["dom-snapshots", scanId],
    queryFn: () => scanApi.domSnapshots(scanId),
    enabled: Boolean(scanId),
  });

  const snapshots: any[] = data?.data?.snapshots || [];
  const [selectedIdx, setSelectedIdx] = useState(0);

  const announcements = useMemo(() => {
    const snap = snapshots[selectedIdx];
    const tree = snap?.a11y_tree || snap?.a11yTree;
    return tree ? flattenTree(tree) : [];
  }, [snapshots, selectedIdx]);

  const summary = useMemo(() => ({
    total: announcements.length,
    tabStops: announcements.filter(a => a.tabbable).length,
    problems: announcements.filter(a => a.problems.length > 0).length,
  }), [announcements]);

  const selectedSnap = snapshots[selectedIdx];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={20} className="animate-spin text-accent" />
      </div>
    );
  }

  if (!snapshots.length) {
    return (
      <div className="p-8">
        <div className="rounded-xl px-6 py-8 text-center" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
          <Volume2 size={32} className="mx-auto mb-3 text-slate-700" />
          <h3 className="text-sm font-semibold text-slate-300">No accessibility tree captured</h3>
          <p className="text-xs text-slate-600 mt-1">Run a scan with capture screenshots enabled to see screen reader output.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center gap-3">
        <Volume2 size={20} className="text-accent" />
        <div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-strong)" }}>Screen Reader Simulation</h2>
          <p className="text-xs text-slate-600 mt-0.5">What NVDA, JAWS, and VoiceOver would announce navigating this page.</p>
        </div>
      </div>

      {snapshots.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {snapshots.map((snap, i) => (
            <button key={i} onClick={() => setSelectedIdx(i)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all whitespace-nowrap ${i === selectedIdx ? "selected-tab-solid" : "text-slate-500 hover:text-slate-300"}`}
              style={i === selectedIdx ? {} : { borderColor: "var(--border)" }}>
              {snap.state || snap.phase || `Snapshot ${i + 1}`}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard label="Announcements" value={summary.total} Icon={Mic} />
        <SummaryCard label="Tab Stops" value={summary.tabStops} Icon={Keyboard} />
        <SummaryCard label="Problems Found" value={summary.problems} Icon={AlertTriangle} tone={summary.problems > 0 ? "error" : "success"} />
      </div>

      {selectedSnap && (
        <div className="rounded-xl px-4 py-3 text-xs text-slate-500 flex items-center gap-2" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
          <FileText size={12} className="flex-shrink-0" />
          <span className="truncate">URL: {selectedSnap.url}</span>
        </div>
      )}

      <div className="rounded-xl overflow-hidden" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
        <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid var(--border)" }}>
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>Reading Order Transcript</h3>
          <span className="text-[11px] text-slate-600">{announcements.length} announcements</span>
        </div>
        {announcements.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-slate-600">
            No screen reader announcements derived. Page may be empty or no accessibility tree was captured.
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: "var(--border)" }}>
            {announcements.map(a => (
              <motion.div key={a.index}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(a.index * 0.003, 0.4) }}
                className={`px-5 py-3 flex items-start gap-3 ${a.problems.length > 0 ? "bg-red-500/5" : "hover:bg-white/[0.02]"} transition-colors`}>
                <span className="text-[10px] font-mono text-slate-600 w-8 flex-shrink-0 pt-0.5">{a.index}.</span>
                <div className="flex-shrink-0 mt-0.5">
                  {a.tabbable ? <Keyboard size={12} className="text-accent" />
                              : a.problems.length > 0 ? <AlertTriangle size={12} className="text-red-400" />
                              : <ChevronRight size={12} className="text-slate-700" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-200 leading-relaxed">{a.text}</div>
                  {a.problems.length > 0 && (
                    <div className="mt-1.5 space-y-0.5">
                      {a.problems.map((p, j) => (
                        <div key={j} className="text-[11px] text-red-400 flex items-start gap-1.5">
                          <AlertTriangle size={10} className="flex-shrink-0 mt-0.5" />
                          <span>{p}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {a.role && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)", color: "#94a3b8" }}>
                    {a.role}
                  </span>
                )}
              </motion.div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl px-5 py-4 text-[11px] text-slate-500" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
        <strong className="text-slate-400">Note:</strong> This is a derived simulation of NVDA/JAWS/VoiceOver output built from the page accessibility tree. For full validation, run the real screen reader against the page — but this catches the vast majority of announcement issues without leaving the browser.
      </div>
    </div>
  );
}

function SummaryCard({ label, value, Icon, tone = "default" }: { label: string; value: number; Icon: any; tone?: string }) {
  const toneStyle: Record<string, { color: string; bg: string; border: string }> = {
    default: { color: "#94a3b8", bg: "rgba(148,163,184,0.05)", border: "rgba(148,163,184,0.15)" },
    success: { color: "#22c55e", bg: "rgba(34,197,94,0.08)",   border: "rgba(34,197,94,0.25)" },
    error:   { color: "#ff4d6d", bg: "rgba(255,77,109,0.08)",  border: "rgba(255,77,109,0.25)" },
  };
  const s = toneStyle[tone] || toneStyle.default;
  return (
    <div className="rounded-xl px-5 py-4" style={{ background: s.bg, border: `1px solid ${s.border}` }}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
        <Icon size={14} style={{ color: s.color }} />
      </div>
      <div className="mt-1.5 text-2xl font-bold" style={{ color: s.color }}>{value}</div>
    </div>
  );
}

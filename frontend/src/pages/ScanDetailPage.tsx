import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { scanApi, reportApi, issueApi } from "../services/api";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, LayoutDashboard, AlertTriangle, Code2,
  FlaskConical, Eye, Loader2, RefreshCw,
  Layers, FileText, RotateCcw, ListChecks, ShieldCheck
} from "lucide-react";

import SummaryTab   from "../components/tabs/SummaryTab";
import IssuesTab    from "../components/tabs/IssuesTab";
import FixesTab     from "../components/tabs/FixesTab";
import TestCasesTab from "../components/tabs/TestCasesTab";
import LiveDomTab   from "../components/tabs/LiveDomTab";
import StatesTab    from "../components/tabs/StatesTab";
import WcagTab      from "../components/tabs/WcagTab";

const TABS = [
  { id: "summary",   label: "Summary",     icon: LayoutDashboard },
  { id: "issues",    label: "Issues",      icon: AlertTriangle },
  { id: "wcag",      label: "WCAG",        icon: ShieldCheck },
  { id: "fixes",     label: "AI Fixes",    icon: Code2 },
  { id: "states",    label: "UI States",   icon: Layers },
  { id: "testcases", label: "Test Cases",  icon: FlaskConical },
  { id: "livedom",   label: "Live DOM",    icon: Eye },
];

const STATUS_COLORS: Record<string, string> = {
  queued:    "text-slate-400 bg-slate-400/10",
  running:   "text-accent bg-accent/10",
  completed: "text-green-400 bg-green-400/10",
  failed:    "text-red-400 bg-red-400/10",
  cancelled: "text-slate-500 bg-slate-500/10",
};

export default function ScanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState("summary");
  const [focusedFixIssueId, setFocusedFixIssueId] = useState<string | null>(null);
  const [focusedIssueId, setFocusedIssueId] = useState<string | null>(null);
  const [focusedStateIssueId, setFocusedStateIssueId] = useState<string | null>(null);
  const [focusedStateName, setFocusedStateName] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [scanLogs, setScanLogs] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["scan", id],
    queryFn: () => scanApi.get(id!),
    refetchInterval: (query) => {
      const status = query.state.data?.data?.scan?.status;
      return status === "running" || status === "queued" ? 3000 : false;
    },
  });

  const scan = data?.data?.scan;
  const { data: visibleIssuesData } = useQuery({
    queryKey: ["issues-count", id],
    queryFn: () => issueApi.list({ scan_id: id, limit: 1 }),
    enabled: Boolean(id),
  });
  const visibleIssuesTotal = visibleIssuesData?.data?.total ?? 0;

  // WebSocket for real-time progress
  useEffect(() => {
    if (!id) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const apiUrl = (import.meta as any).env?.VITE_API_URL;
    const host = apiUrl ? new URL(apiUrl).hostname : window.location.hostname;
    const port = apiUrl ? (new URL(apiUrl).port || "4000") : "4000";
    const ws = new WebSocket(`${proto}://${host}:${port}/ws`);
    wsRef.current = ws;
    ws.onopen  = () => ws.send(JSON.stringify({ type: "subscribe", scanId: id }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (["scan:started","scan:completed","scan:failed","scan:progress"].includes(msg.type)) {
        const message = msg.message || (msg.type === "scan:started" ? "Scan started" : msg.type === "scan:completed" ? "Scan completed" : msg.type === "scan:failed" ? `Scan failed: ${msg.error || "Unknown error"}` : "Scan progress updated");
        setScanLogs(prev => [message, ...prev.filter(item => item !== message)].slice(0, 8));
        qc.invalidateQueries({ queryKey: ["scan", id] });
        qc.invalidateQueries({ queryKey: ["issues", id] });
      }
    };
    ws.onerror = () => {};
    return () => ws.close();
  }, [id, qc]);

  // ── PDF Report download ──────────────────────────────────────────────────
  const handleDownloadReport = () => {
    if (!id) return;
    const url = reportApi.getReportUrl(id);
    const token = (() => {
      try {
        const s = JSON.parse(localStorage.getItem("accessibility-auth") || "{}");
        return s?.state?.accessToken || "";
      } catch { return ""; }
    })();
    // Open in new tab → user prints to PDF with Ctrl+P
    const win = window.open("about:blank", "_blank");
    if (win) {
      // Fetch with auth header and write into new window
      setDownloading("report");
      fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.text())
        .then(html => {
          win.document.write(html);
          win.document.close();
          setDownloading(null);
        })
        .catch(() => { win.close(); setDownloading(null); });
    }
  };

  const handleRefresh = async () => {
    if (!id || refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([
        refetch(),
        qc.invalidateQueries({ queryKey: ["issues"] }),
        qc.invalidateQueries({ queryKey: ["scan", id] }),
        qc.invalidateQueries({ queryKey: ["dom-snapshots", id] }),
        qc.invalidateQueries({ queryKey: ["test-cases", id] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };
  const handleRerunScan = async () => {
    if (!id || rerunning) return;
    setRerunning(true);
    try {
      const res = await scanApi.rerun(id);
      navigate(`/scans/${res.data.scan.id}`);
    } finally {
      setRerunning(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    );
  }

  if (!scan) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <p className="text-slate-500">Scan not found.</p>
        <button onClick={() => navigate("/")} className="text-accent text-sm hover:underline">Back to dashboard</button>
      </div>
    );
  }

  const isRunning = scan.status === "running" || scan.status === "queued";
  const isComplete = scan.status === "completed";

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex-shrink-0 px-8 pt-6 pb-0" style={{ borderBottom: "1px solid var(--border)", background: "rgba(255,255,255,0.025)" }}>
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-start gap-4">
            <button onClick={() => navigate("/")}
              className="mt-1 text-slate-600 hover:text-slate-300 transition-colors">
              <ArrowLeft size={16} />
            </button>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-semibold whitespace-normal break-words" style={{ color: "var(--text-strong)" }}>
                  {scan.name || "Untitled Scan"}
                </h1>
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${STATUS_COLORS[scan.status] || "text-slate-500"}`}>
                  {scan.status}
                  {isRunning && <Loader2 size={10} className="inline-block ml-1.5 animate-spin" />}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-600 mt-1">
                <span>{(scan.urls || []).join(", ").slice(0, 100)}</span>
                {isRunning && <span className="text-accent font-medium">Progress: {scan.progress}%</span>}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            {isComplete && (
              <button
                onClick={handleRerunScan}
                disabled={rerunning}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-all hover:bg-white/[0.04]"
                style={{ borderColor: "rgba(15,118,110,0.3)", color: "#0f766e" }}
                title="Create a new scan with the same URL and scan options"
              >
                {rerunning ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                Re-run
              </button>
            )}
            {isComplete && (
              <>
                <button
                  onClick={handleDownloadReport}
                  disabled={downloading === "report"}
                  className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-all hover:bg-white/[0.04]"
                  style={{ borderColor: "rgba(15,118,110,0.3)", color: "#0f766e" }}
                  title="Open report in browser — use Ctrl+P to save as PDF"
                >
                  {downloading === "report"
                    ? <Loader2 size={13} className="animate-spin" />
                    : <FileText size={13} />}
                  PDF Report
                </button>
              </>
            )}
            <button onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 px-3 py-2 rounded-lg hover:bg-white/[0.03] transition-all disabled:opacity-60 disabled:cursor-wait">
              <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} /> {refreshing ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </div>

        {/* Progress bar */}
        {isRunning && (
          <div className="mb-4 space-y-3">
            <div className="w-full h-0.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
              <motion.div className="h-full rounded-full"
                style={{ background: "linear-gradient(90deg,#0f766e,#6e56cf)", boxShadow: "0 0 10px rgba(15,118,110,0.5)" }}
                animate={{ width: `${scan.progress || 0}%` }}
                transition={{ duration: 0.8, ease: "easeOut" }} />
            </div>
            <div className="rounded-xl px-4 py-3" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-300"><ListChecks size={14} className="text-accent" /> Scan activity</div>
                <span className="text-[11px] text-slate-600">Latest checks first</span>
              </div>
              <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                {(scanLogs.length ? scanLogs : [scan.status === "queued" ? "Waiting for an available scan worker" : "Preparing scan modules and browser context"]).map((log, index) => (
                  <div key={`${log}-${index}`} className="flex items-start gap-2 text-xs text-slate-500 leading-relaxed">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: index === 0 ? "var(--accent)" : "var(--muted)" }} />
                    <span className="whitespace-normal break-words">{log}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-0.5 overflow-x-auto">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-all relative whitespace-nowrap flex-shrink-0 ${
                  isActive ? "selected-tab-solid" : "text-slate-500 hover:text-slate-300"
                }`}
                style={isActive ? {} : {}}>
                <tab.icon size={14} />
                {tab.label}
                {tab.id === "issues" && visibleIssuesTotal > 0 && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                    style={{ background: "rgba(255,77,109,0.2)", color: "#ff4d6d" }}>
                    {visibleIssuesTotal}
                  </span>
                )}
                {isActive && (
                  <motion.div layoutId="tab-underline"
                    className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                    style={{ background: "linear-gradient(90deg,#0f766e,#6e56cf)" }} />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div key={activeTab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className="h-full">
            {activeTab === "summary"   && <SummaryTab   scan={scan} />}
            {activeTab === "issues"    && <IssuesTab    scanId={scan.id} focusedIssueId={focusedIssueId} onOpenAiFix={(issueId) => { setFocusedIssueId(null); setFocusedFixIssueId(issueId); setActiveTab("fixes"); }} onOpenState={(issue) => { setFocusedIssueId(null); setFocusedStateIssueId(issue.id); setFocusedStateName(issue.state_label || issue.state || issue.phase || "default"); setActiveTab("states"); }} />}
            {activeTab === "wcag"      && <WcagTab      scanId={scan.id} />}
            {activeTab === "fixes"     && <FixesTab     scanId={scan.id} focusedIssueId={focusedFixIssueId} onBackToIssue={(issueId) => { setFocusedIssueId(issueId); setActiveTab("issues"); }} />}
            {activeTab === "states"    && <StatesTab    scanId={scan.id} focusedIssueId={focusedStateIssueId} preferredState={focusedStateName} onBackToIssue={(issueId) => { setFocusedIssueId(issueId); setActiveTab("issues"); }} />}
            {activeTab === "testcases" && <TestCasesTab scanId={scan.id} />}
            {activeTab === "livedom"   && <LiveDomTab   scanId={scan.id} />}

          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

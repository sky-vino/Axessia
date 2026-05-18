import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { scanApi } from "../services/api";
import { motion } from "framer-motion";
import { Plus, Trash2, ChevronDown, ChevronUp, ArrowLeft, Loader2, Shield } from "lucide-react";

const AUTHENTICATED_PAGE_OPTIONS = [
  "Offerte",
  "Profilo",
  "Impostazioni",
  "Fatture",
  "Scopri l'app My Sky",
];

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <div onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${checked ? "bg-accent" : "bg-white/10"}`}
        style={{ boxShadow: checked ? "0 0 10px rgba(15,118,110,0.3)" : "" }}>
        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </div>
      <span className="text-sm text-slate-400">{label}</span>
    </label>
  );
}

export default function NewScanPage() {
  const navigate = useNavigate();
  const [urls, setUrls] = useState([""]);
  const [name, setName] = useState("");
  const [stateLabel, setStateLabel] = useState("default");
  const [showAuth, setShowAuth] = useState(false);
  const [auth, setAuth] = useState({
    login_url: "",
    username_selector: "js=document.querySelector('sky-login-component#sky-login')?.shadowRoot?.querySelector('login-input.sky-login-input')?.shadowRoot?.querySelector('#sky-login-email')\n//input[@id='sky-login-email']\n#sky-login-email",
    password_selector: "js=document.querySelector('sky-login-component#sky-login')?.shadowRoot?.querySelector('div.sky-login-label-password login-input.sky-login-input')?.shadowRoot?.querySelector('#sky-login-password')\n//input[@id='sky-login-password']\n#sky-login-password",
    submit_selector: "js=document.querySelector('sky-login-component#sky-login button.sky-login-submit[type=\"submit\"]')\n//button[@class='sky-login-submit']\n//button[contains(@class,'sky-login-submit')]\nbutton.sky-login-submit[type='submit']",
    username: "",
    password: "",
    otp_from_page: true,
    otp_selector: "input.otp-input_otp-input__QvpEl\ninput[aria-label^='Please enter OTP character'], input[name*='otp' i], div[role='textbox'], [contenteditable='true']",
    otp_source_selector: "div.otp-verify-sms-content > p",
    otp_code: "",
    otp_submit_selector: "js=document.querySelector(\"button.sky-button-primary[aria-label='Conferma']\")\n//button[normalize-space()='Conferma']\n//button[@aria-label='Conferma' and contains(@class,'sky-button-primary')]\nbutton.sky-button-primary[aria-label='Conferma']",
    auto_accept_cookies: true,
    cookie_accept_selector: "js=document.querySelector('#notice button.accbtn[aria-label=\"Accetta tutto\"]')\n//button[@title='Accetta tutto']\n//*[@id='notice']//button[@aria-label='Accetta tutto' or normalize-space()='Accetta tutto']",
    profile_url: "",
  });
  const [opts, setOpts] = useState({
    run_axe: true, run_heuristics: true, run_focus: true, run_keyboard_nav: true,
    run_zoom: true, run_color: true, run_pointer: true, run_live_dom: true,
    run_states: true, run_dynamic: true, run_motion: true, run_reflow: true,
    capture_screenshots: true,
    crawl_mode: false,
    crawl_depth: 2,
    crawl_same_domain: true,
    crawl_max_pages: 30,
    scan_login_page: true,
    scan_post_login_landing: true,
    post_login_tab_scan: true,
    post_login_tab_limit: 12,
    post_login_pages: AUTHENTICATED_PAGE_OPTIONS,
  });
  const [crawlIncludeText, setCrawlIncludeText] = useState("");
  const [crawlExcludeText, setCrawlExcludeText] = useState("");
  const [selectedPostLoginPages, setSelectedPostLoginPages] = useState<string[]>(AUTHENTICATED_PAGE_OPTIONS);

  const mutation = useMutation({
    mutationFn: (data: any) => scanApi.create(data),
    onSuccess: (res) => navigate(`/scans/${res.data.scan.id}`)
  });

  const addUrl = () => setUrls([...urls, ""]);
  const removeUrl = (i: number) => setUrls(urls.filter((_, j) => j !== i));
  const setUrl = (i: number, v: string) => { const u = [...urls]; u[i] = v; setUrls(u); };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const validUrls = urls.filter(u => u.trim());
    if (!validUrls.length) return;
    const splitPatterns = (s: string) =>
      s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean).slice(0, 30);
    const authPayload = {
      ...auth,
      username_selector: auth.username_selector.trim(),
      password_selector: auth.password_selector.trim(),
      submit_selector: auth.submit_selector.trim(),
      otp_selector: auth.otp_selector?.trim() || undefined,
      otp_source_selector: auth.otp_source_selector?.trim() || undefined,
      otp_submit_selector: auth.otp_submit_selector?.trim() || undefined,
      profile_url: auth.profile_url?.trim() || undefined,
      otp_code: auth.otp_code?.trim() || undefined,
    };
    mutation.mutate({
      name: name || undefined,
      urls: validUrls,
      state_label: stateLabel,
      auth_config: showAuth && auth.login_url ? authPayload : undefined,
      scan_options: {
        ...opts,
        crawl_depth: Math.max(0, Math.min(10, Number(opts.crawl_depth) || 0)),
        crawl_max_pages: Math.max(1, Math.min(200, Number(opts.crawl_max_pages) || 30)),
        crawl_include_patterns: splitPatterns(crawlIncludeText),
        crawl_exclude_patterns: splitPatterns(crawlExcludeText),
        post_login_pages: selectedPostLoginPages,
      }
    });
  };

  const togglePostLoginPage = (label: string) => {
    setSelectedPostLoginPages(current =>
      current.includes(label)
        ? current.filter(item => item !== label)
        : AUTHENTICATED_PAGE_OPTIONS.filter(item => item === label || current.includes(item))
    );
  };

  const inputStyle = {
    background: "var(--input-bg)",
    border: "1px solid var(--border-strong)",
    color: "var(--text)",
    borderRadius: "8px",
    fontSize: "14px",
    padding: "10px 14px",
    width: "100%",
    outline: "none",
    transition: "border-color 0.2s"
  };

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <button onClick={() => navigate("/")} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 mb-6 transition-colors">
        <ArrowLeft size={14} /> Back to Dashboard
      </button>

      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-100">New Accessibility Scan</h1>
        <p className="text-sm text-slate-500 mt-1">Configure and launch a comprehensive WCAG audit</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card p-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Scan Details</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-slate-500 mb-1.5">Scan Name (optional)</label>
              <input style={inputStyle} placeholder="e.g. Homepage Q2 Audit" value={name} onChange={e => setName(e.target.value)}
                onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1.5">State Label</label>
              <input style={inputStyle} placeholder="default / authenticated / expanded" value={stateLabel}
                onChange={e => setStateLabel(e.target.value)}
                onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
            </div>
          </div>
        </motion.div>

        {/* URLs */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="card p-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Target URLs <span className="text-accent text-xs ml-1">*</span></h2>
          <div className="space-y-2">
            {urls.map((url, i) => (
              <div key={i} className="flex gap-2">
                <input type="url" style={inputStyle} required placeholder={`https://example.com${i > 0 ? "/page-" + (i + 1) : ""}`}
                  value={url} onChange={e => setUrl(i, e.target.value)}
                  onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                  onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
                {urls.length > 1 && (
                  <button type="button" onClick={() => removeUrl(i)}
                    className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-400/10 transition-all">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
            {urls.length < 20 && (
              <button type="button" onClick={addUrl}
                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-accent transition-colors mt-2">
                <Plus size={13} /> Add URL
              </button>
            )}
          </div>
        </motion.div>

        {/* Crawl (post-login discovery) */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }} className="card p-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-1">Link crawl</h2>
          <p className="text-xs text-slate-600 mb-4 leading-relaxed">
            After login (if configured), discover same-site links from each target URL and scan additional pages automatically. Depth counts link hops from each seed.
          </p>
          <Toggle checked={opts.crawl_mode} onChange={v => setOpts({ ...opts, crawl_mode: v })} label="Enable crawl mode" />
          {opts.crawl_mode && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Max link hops from seed</label>
                  <input type="number" min={0} max={10} style={inputStyle}
                    value={opts.crawl_depth}
                    onChange={e => setOpts({ ...opts, crawl_depth: Number(e.target.value) })}
                    onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                    onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Max pages per seed</label>
                  <input type="number" min={1} max={200} style={inputStyle}
                    value={opts.crawl_max_pages}
                    onChange={e => setOpts({ ...opts, crawl_max_pages: Number(e.target.value) })}
                    onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                    onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
                </div>
              </div>
              <Toggle checked={opts.crawl_same_domain} onChange={v => setOpts({ ...opts, crawl_same_domain: v })} label="Same hostname only (recommended)" />
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Include URL patterns (optional)</label>
                <textarea rows={2} style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
                  placeholder={"One per line or comma-separated. Substring match, or use * as wildcard.\nExample: https://example.com/app/*"}
                  value={crawlIncludeText} onChange={e => setCrawlIncludeText(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Exclude URL patterns (optional)</label>
                <textarea rows={2} style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
                  placeholder={"e.g. */logout*, */api/*"}
                  value={crawlExcludeText} onChange={e => setCrawlExcludeText(e.target.value)} />
              </div>
            </div>
          )}
        </motion.div>

        {/* Scan Options */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }} className="card p-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Scan Modules</h2>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries({
              run_axe: "axe-core WCAG (recommended)",
              run_heuristics: "Heuristic Checks",
              run_focus: "Focus Visibility & Traps",
              run_keyboard_nav: "Keyboard Navigation",
              run_zoom: "Zoom & Resize Checks",
              run_color: "Color & Contrast",
              run_pointer: "Pointer & Gestures",
              run_live_dom: "Live DOM / A11y Tree",
              run_states: "Multi-State Testing",
              run_dynamic: "Dynamic Interactions",
              run_motion: "Motion / Animation",
              run_reflow: "Reflow (320px / 400% Zoom)"
            }).map(([key, label]) => (
              <Toggle key={key} checked={(opts as any)[key]} onChange={v => setOpts({ ...opts, [key]: v })} label={label} />
            ))}
          </div>
          <div className="mt-3 pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
            <Toggle checked={opts.capture_screenshots} onChange={v => setOpts({ ...opts, capture_screenshots: v })} label="Capture screenshots" />
          </div>
        </motion.div>

        {/* Auth */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="card overflow-hidden">
          <button type="button" onClick={() => setShowAuth(!showAuth)}
            className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-white/[0.02] transition-colors">
            <div className="flex items-center gap-2.5">
              <Shield size={15} className="text-accent" />
              <span className="text-sm font-semibold text-slate-300">Login Authentication</span>
              <span className="text-xs text-slate-600 border border-white/10 px-2 py-0.5 rounded">Optional</span>
            </div>
            {showAuth ? <ChevronUp size={15} className="text-slate-500" /> : <ChevronDown size={15} className="text-slate-500" />}
          </button>
          {showAuth && (
            <div className="px-6 pb-6 space-y-4 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
              <p className="text-xs text-slate-600 mt-4 leading-relaxed">
                Use this when the target pages need a logged-in session. The scanner will log in first, accept cookies if enabled, then scan or crawl with the same browser session.
              </p>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Login URL</label>
                <input style={inputStyle} type="url" placeholder="https://example.com/login"
                  value={auth.login_url} onChange={e => setAuth({ ...auth, login_url: e.target.value })}
                  onFocus={e => (e.target as any).style.borderColor = "rgba(15,118,110,0.4)"}
                  onBlur={e => (e.target as any).style.borderColor = "rgba(255,255,255,0.08)"} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Username / Email</label>
                  <input style={inputStyle} placeholder="user@example.com" value={auth.username}
                    onChange={e => setAuth({ ...auth, username: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Password</label>
                  <input style={inputStyle} type="password" placeholder="Password" value={auth.password}
                    onChange={e => setAuth({ ...auth, password: e.target.value })} />
                </div>
              </div>

              <div className="rounded-xl p-4 space-y-3" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}>
                <Toggle checked={Boolean(auth.auto_accept_cookies)} onChange={v => setAuth({ ...auth, auto_accept_cookies: v })} label="Accept all cookie prompts automatically" />
                <Toggle checked={Boolean(auth.otp_from_page)} onChange={v => setAuth({ ...auth, otp_from_page: v })} label="OTP is shown on the login page and can be read automatically" />
                {!auth.otp_from_page && (
                  <div className="pt-2">
                    <label className="block text-xs text-slate-500 mb-1.5">OTP Code</label>
                    <input style={inputStyle} placeholder="Enter OTP for this scan"
                      value={auth.otp_code} onChange={e => setAuth({ ...auth, otp_code: e.target.value })} />
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Authenticated pages to scan after Gestisci</label>
                <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
                  {AUTHENTICATED_PAGE_OPTIONS.map(label => (
                    <label
                      key={label}
                      className="flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors hover:bg-white/[0.03]"
                      style={{ background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)" }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedPostLoginPages.includes(label)}
                        onChange={() => togglePostLoginPage(label)}
                        className="h-4 w-4"
                      />
                      <span className="text-sm text-slate-300">{label}</span>
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-slate-600 mt-2 leading-relaxed">
                  The scanner logs in, scans Gestisci, checks keyboard tab access between these navigation items, then fully scans each selected page.
                </p>
              </div>
            </div>
          )}
        </motion.div>

        {mutation.isError && (
          <div className="text-sm text-red-400 px-4 py-3 rounded-lg" style={{ background: "rgba(255,77,109,0.1)", border: "1px solid rgba(255,77,109,0.2)" }}>
            {(mutation.error as any)?.response?.data?.error || "Failed to create scan"}
          </div>
        )}

        <button type="submit" disabled={mutation.isPending}
          className="sky-primary w-full py-3.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-60">
          {mutation.isPending ? <><Loader2 size={16} className="animate-spin" />Starting Scan…</> : "Launch Accessibility Scan"}
        </button>
      </form>
    </div>
  );
}

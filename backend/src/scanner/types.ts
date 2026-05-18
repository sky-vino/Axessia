/**
 * types.ts
 * Shared types used across all scanner modules.
 */

export type Severity = "critical" | "serious" | "moderate" | "minor";

export interface ScanIssue {
  ruleId: string;
  severity: Severity;
  priority?: number;
  category?: string;
  message: string;
  url: string;
  selector?: string;
  selectors?: string[];
  depths?: number[];
  wcag?: string[];
  act?: string[];
  tags?: string[];
  helpUrl?: string;
  htmlSnippet?: string;
  fixSuggestion?: string;
  evidenceScreenshot?: string;
  evidenceExplanation?: string;
  componentId?: string;
  componentOwner?: string;
  sourceHint?: string;
  state?: string;
  phase?: string;
  affectedCount?: number;
}

export interface ElemPath {
  selector: string;
  depth: number;
}

export interface DomSnapshot {
  url: string;
  phase: string;
  state?: string;
  a11yTree: any;
  screenshot?: string;
}

export interface TestCase {
  name: string;
  description: string;
  category: string;
  wcagRef: string;
  status: "pass" | "fail" | "pending";
  issueId?: string;
  issueRuleId?: string;
  issueUrl?: string;
  steps?: string[];
  result?: string;
}

export interface StateConfig {
  name: string;
  trigger?: string;         // CSS selector to click/hover to enter state
  triggerType?: "click" | "hover" | "focus" | "keyboard";
  key?: string;             // keyboard key if triggerType=keyboard
  waitMs?: number;
  description?: string;
}

export interface ScanOptions {
  run_axe?: boolean;
  run_heuristics?: boolean;
  run_focus?: boolean;
  run_keyboard_nav?: boolean;
  run_zoom?: boolean;
  run_color?: boolean;
  run_pointer?: boolean;
  run_live_dom?: boolean;
  run_dynamic?: boolean;
  run_states?: boolean;
  run_motion?: boolean;
  run_reflow?: boolean;
  capture_screenshots?: boolean;
  viewport_width?: number;
  viewport_height?: number;
  headful?: boolean;
  extra_states?: StateConfig[];
  /** When true, after login the scanner BFS-discovers links from each seed URL and scans up to crawl_max_pages per seed. */
  crawl_mode?: boolean;
  /** Max link hops from the seed URL (0 = seed only, 1 = seed + direct links, …). Capped at 10. */
  crawl_depth?: number;
  /** If true (default), only enqueue URLs on the same hostname as the seed. */
  crawl_same_domain?: boolean;
  /** If non-empty, a URL must match at least one pattern (substring, or glob with *). */
  crawl_include_patterns?: string[];
  /** URLs matching any of these patterns are skipped. */
  crawl_exclude_patterns?: string[];
  /** Hard cap on distinct pages scanned per seed URL when crawl_mode is on (1–200). */
  crawl_max_pages?: number;
  /** When auth is configured, scan the public login URL before starting the authenticated session. */
  scan_login_page?: boolean;
  /** After OTP/auth completes, scan the page where the browser actually lands. */
  scan_post_login_landing?: boolean;
  /** After landing post-login, scan visible tab/navigation states on that page. */
  post_login_tab_scan?: boolean;
  /** Max tab/navigation states to scan after login. */
  post_login_tab_limit?: number;
  /** Ordered authenticated navigation labels/pages to scan after landing. */
  post_login_pages?: string[];
}

export type ProgressCallback = (progress: number, message: string) => void;

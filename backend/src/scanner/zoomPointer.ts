/**
 * zoomPointer.ts
 * Zoom level checks and pointer/gesture accessibility.
 *
 * Zoom tests:
 *  1. viewport meta prevents zoom (user-scalable=no)
 *  2. Fixed pixel font sizes that won't scale
 *  3. Content reflow at 400% zoom simulation (1280→320px)
 *  4. Horizontal scrolling at 320px (WCAG 1.4.10)
 *
 * Pointer tests:
 *  5. Touch target size < 24px (WCAG 2.5.8) / < 44px (WCAG 2.5.5 AAA)
 *  6. Drag-only interactions without keyboard alternative
 *  7. Path-based gestures (swipe) without alternative
 *  8. Pointer cancellation — down-event only actions
 */

import type { Page } from "playwright";
import type { ScanIssue } from "./types";
import { logger } from "../utils/logger";

export async function runZoomChecks(
  page: Page,
  url: string,
  state: string,
  phase: string
): Promise<ScanIssue[]> {
  const issues: ScanIssue[] = [];

  // ── 1. Viewport meta zoom lock ─────────────────────────────────────────────
  const zoomLocked = await page.evaluate(() => {
    const meta = document.querySelector("meta[name='viewport']") as HTMLMetaElement;
    if (!meta) return false;
    const content = meta.getAttribute("content") || "";
    return content.includes("user-scalable=no") || /maximum-scale=[01]([^0-9]|$)/.test(content);
  });
  if (zoomLocked) {
    issues.push({
      ruleId: "zoom:viewport-locked", severity: "serious", priority: 1, category: "zoom",
      message: "Viewport meta tag prevents users from zooming. This blocks low-vision users.",
      url, selector: "meta[name='viewport']", selectors: ["meta[name='viewport']"], depths: [0],
      wcag: ["wcag1.4.4"],
      fixSuggestion: "Change to: <meta name='viewport' content='width=device-width, initial-scale=1'>. Never set user-scalable=no.",
      state, phase,
    });
  }

  // ── 2. Fixed px fonts ──────────────────────────────────────────────────────
  const fixedFonts = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("p,span,a,li,td,th,h1,h2,h3,h4,h5,h6,button,input,label").forEach((el: any) => {
      const fs = el.style?.fontSize || "";
      if (fs.endsWith("px") && parseFloat(fs) < 16) {
        out.push(el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase());
      }
    });
    return [...new Set(out)].slice(0, 30);
  });
  if (fixedFonts.length) {
    issues.push({
      ruleId: "zoom:fixed-font-size", severity: "moderate", priority: 3, category: "zoom",
      message: `${fixedFonts.length} elements use small fixed px font sizes that won't scale when browser text size is increased.`,
      url, selector: fixedFonts[0], selectors: fixedFonts, depths: fixedFonts.map(() => 0),
      wcag: ["wcag1.4.4"],
      fixSuggestion: "Use rem or em units for font sizes. Base: 1rem = browser default (usually 16px). Avoid font-size < 1rem inline.",
      state, phase,
    });
  }

  // ── 3. 400% zoom simulation (1280 → 320px width) ───────────────────────────
  try {
    const originalVp = page.viewportSize() || { width: 1366, height: 768 };
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(500);

    const overflowEls = await page.evaluate(() => {
      const vw = window.innerWidth;
      const out: string[] = [];
      document.querySelectorAll("*").forEach((el: any) => {
        const r = el.getBoundingClientRect();
        if (r.width > vw + 1 && r.height > 0) {
          out.push(el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase());
        }
      });
      return [...new Set(out)].slice(0, 30);
    });

    const requiresHScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth > window.innerWidth + 5
    );

    await page.setViewportSize(originalVp);
    await page.waitForTimeout(300);

    if (overflowEls.length || requiresHScroll) {
      issues.push({
        ruleId: "zoom:reflow-failure", severity: "serious", priority: 1, category: "zoom",
        message: `Content does not reflow correctly at 320px width (400% zoom equivalent). ${overflowEls.length} elements overflow horizontally.`,
        url, selector: overflowEls[0] || "body",
        selectors: overflowEls.length ? overflowEls : ["body"], depths: overflowEls.map(() => 0),
        wcag: ["wcag1.4.10"],
        fixSuggestion: "Use responsive CSS: flexbox/grid, max-width: 100%, overflow-x: hidden on containers. Avoid fixed widths > 320px. Test at 320px viewport.",
        state, phase,
      });
    }
  } catch (err) {
    logger.debug("Zoom reflow check failed:", err);
  }

  return issues;
}

export async function runPointerChecks(
  page: Page,
  url: string,
  state: string,
  phase: string
): Promise<ScanIssue[]> {
  const issues: ScanIssue[] = [];

  // ── 4. Target size < 24px ──────────────────────────────────────────────────
  const smallTargets = await page.evaluate(() => {
    const MIN = 24;
    const out: { sel: string; w: number; h: number }[] = [];
    document.querySelectorAll("a[href],button,input,select,textarea,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[tabindex]")
      .forEach((el: any) => {
        const r = el.getBoundingClientRect();
        if ((r.width < MIN || r.height < MIN) && r.width > 0 && r.height > 0) {
          out.push({ sel: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) });
        }
      });
    return out.slice(0, 60);
  });
  if (smallTargets.length) {
    issues.push({
      ruleId: "pointer:target-size-minimum",
      severity: "serious", priority: 2, category: "pointer",
      message: `${smallTargets.length} interactive elements are smaller than 24×24 CSS px (WCAG 2.5.8 minimum). Smallest: ${smallTargets[0]?.w}×${smallTargets[0]?.h}px.`,
      url, selector: smallTargets[0].sel,
      selectors: smallTargets.map(t => t.sel), depths: smallTargets.map(() => 0),
      wcag: ["wcag2.5.8"],
      fixSuggestion: "Increase tap target size to at least 24×24px via padding. For best practice (WCAG 2.5.5), aim for 44×44px.",
      state, phase,
      htmlSnippet: smallTargets.slice(0, 5).map(t => `/* ${t.sel}: ${t.w}×${t.h}px */`).join("\n"),
    });
  }

  // ── 5. Drag-only interactions ──────────────────────────────────────────────
  // 5. Target size enhanced < 44px (WCAG 2.5.5 AAA)
  const enhancedTargets = await page.evaluate(() => {
    const MIN = 44;
    const out: { sel: string; w: number; h: number }[] = [];
    document.querySelectorAll("a[href],button,input,select,textarea,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[tabindex]")
      .forEach((el: any) => {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
        if (!visible || disabled) return;
        if (r.width < MIN || r.height < MIN) {
          out.push({
            sel: el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase(),
            w: Math.round(r.width),
            h: Math.round(r.height)
          });
        }
      });
    return out.slice(0, 80);
  });
  if (enhancedTargets.length) {
    issues.push({
      ruleId: "pointer:target-size-enhanced",
      severity: "moderate", priority: 3, category: "pointer",
      message: `${enhancedTargets.length} interactive elements are smaller than 44x44 CSS px (WCAG 2.5.5 Target Size Enhanced, AAA). Smallest: ${enhancedTargets[0]?.w}x${enhancedTargets[0]?.h}px.`,
      url, selector: enhancedTargets[0].sel,
      selectors: enhancedTargets.map(t => t.sel), depths: enhancedTargets.map(() => 0),
      wcag: ["wcag2.5.5"], tags: ["wcag2aaa"],
      fixSuggestion: "Increase enhanced pointer targets to at least 44x44 CSS px, usually by adding padding or increasing the clickable area. Review WCAG 2.5.5 exceptions such as inline text links, equivalent controls, browser-native controls, and essential small targets.",
      state, phase,
      htmlSnippet: enhancedTargets.slice(0, 8).map(t => `/* ${t.sel}: ${t.w}x${t.h}px */`).join("\n"),
    });
  }
  const dragOnly = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("[draggable='true']").forEach((el: any) => {
      const hasBtnAlternative = el.querySelector("button,[role='button']") ||
        el.getAttribute("data-sortable-handle");
      if (!hasBtnAlternative) {
        out.push(el.id ? `${el.tagName.toLowerCase()}[draggable]#${el.id}` : `${el.tagName.toLowerCase()}[draggable]`);
      }
    });
    return out.slice(0, 20);
  });
  if (dragOnly.length) {
    issues.push({
      ruleId: "pointer:drag-no-alternative",
      severity: "serious", priority: 2, category: "pointer",
      message: `${dragOnly.length} draggable elements lack visible keyboard/single-pointer alternatives.`,
      url, selector: dragOnly[0], selectors: dragOnly, depths: dragOnly.map(() => 0),
      wcag: ["wcag2.5.1","wcag2.5.7"],
      fixSuggestion: "Provide button-based alternatives (e.g., move up/down buttons) for all drag-and-drop functionality.",
      state, phase,
    });
  }

  // ── 6. Path-based gestures ─────────────────────────────────────────────────
  const gestureOnly = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("[class*='swipe'],[class*='gesture'],[data-swipe],[data-gesture],[class*='carousel'],[class*='slider']")
      .forEach((el: any) => {
        const hasArrows = el.querySelector("button,[role='button'],[aria-label*='next'],[aria-label*='prev']");
        if (!hasArrows) {
          out.push(el.className ? `.${el.className.split(" ")[0]}` : el.tagName.toLowerCase());
        }
      });
    return out.slice(0, 20);
  });
  if (gestureOnly.length) {
    issues.push({
      ruleId: "pointer:gesture-no-alternative",
      severity: "serious", priority: 2, category: "pointer",
      message: `${gestureOnly.length} swipe/gesture components may lack single-pointer alternatives (prev/next buttons).`,
      url, selector: gestureOnly[0], selectors: gestureOnly, depths: gestureOnly.map(() => 0),
      wcag: ["wcag2.5.1"],
      fixSuggestion: "Add prev/next buttons or keyboard arrow navigation as an alternative to swiping. Never rely solely on swipe gestures.",
      state, phase,
    });
  }

  // ── 7. Pointer-down only actions (cancellation issue) ─────────────────────
  const downOnlyActions = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("[onmousedown],[ontouchstart]").forEach((el: any) => {
      const hasUpHandler = el.onmouseup || el.ontouchend || el.onclick;
      if (!hasUpHandler) {
        out.push(el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase());
      }
    });
    return out.slice(0, 20);
  });
  if (downOnlyActions.length) {
    issues.push({
      ruleId: "pointer:down-event-only",
      severity: "moderate", priority: 3, category: "pointer",
      message: `${downOnlyActions.length} elements trigger actions on pointer-down only, preventing cancellation.`,
      url, selector: downOnlyActions[0], selectors: downOnlyActions, depths: downOnlyActions.map(() => 0),
      wcag: ["wcag2.5.2"],
      fixSuggestion: "Use click (pointer-up) events instead of mousedown/touchstart for action triggers. This allows users to cancel by moving away.",
      state, phase,
    });
  }

  return issues;
}

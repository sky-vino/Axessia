/**
 * scanner.ts
 * ============================================================
 * Main orchestrator for Accessibility scanner.
 * Wires all modules:
 *
 *  navigation.ts      — safe retry-based page navigation
 *  axeScan.ts         — axe-core WCAG 2.0/2.1/2.2 engine
 *  heuristics.ts      — heading structure, landmarks, forms, reflow, motion, lang
 *  focusHeuristics.ts — focus visible/obscured/trap/lock/escape
 *  keyboardNav.ts     — real Tab/Arrow/Escape keyboard simulation
 *  colorContrast.ts   — actual contrast ratio measurement
 *  zoomPointer.ts     — zoom lock, reflow, touch targets, gestures
 *  stateScanner.ts    — hover/focus/expanded/error/tab states + dynamic interactions
 *  ownership.ts       — component/owner attribution
 */

import { chromium } from "playwright";
import type { ScanOptions, ProgressCallback, ScanIssue, DomSnapshot, TestCase, StateConfig } from "./types";
import { navigateSafely } from "./navigation";
import { runAxe } from "./axeScan";
import { runHeuristics } from "./heuristics";
import { runFocusHeuristics } from "./focusHeuristics";
import { runKeyboardNav } from "./keyboardNav";
import { runColorChecks } from "./colorContrast";
import { runZoomChecks, runPointerChecks } from "./zoomPointer";
import { runStateScanning } from "./stateScanner";
import { enrichOwnership } from "./ownership";
import { logger } from "../utils/logger";
import { canonicalUrlKey, discoverOutboundLinks, normalizeHttpUrl, passesCrawlFilters, planCrawlUrls } from "./crawlDiscovery";

export interface ScanResult {
  issues: ScanIssue[];
  testCases: TestCase[];
  domSnapshots: DomSnapshot[];
  navigatedUrls: string[];
  score: number;
}

interface LoginNetworkDiagnostics {
  clientAuthorizeHit: boolean;
  clientAuthorizeStatus?: number;
  clientAuthorizeFailure?: string;
  userLoginHit: boolean;
  userLoginStatus?: number;
  userLoginFailure?: string;
  userLoginPreview?: string;
  importantIncidents: string[];
}

export class AccessibilityScanner {
  private scan: any;
  private onProgress: ProgressCallback;
  private allIssues: ScanIssue[] = [];
  private testCases: TestCase[] = [];
  private domSnapshots: DomSnapshot[] = [];
  private scannedPageKeys = new Set<string>();
  private navigatedUrls: string[] = [];
  private navigatedUrlKeys = new Set<string>();
  private loginNetworkDiagnostics: LoginNetworkDiagnostics = {
    clientAuthorizeHit: false,
    userLoginHit: false,
    importantIncidents: [],
  };
  private importantNetworkPending = new Map<any, { method: string; url: string; startedAt: number }>();

  constructor(scan: any, onProgress: ProgressCallback) {
    this.scan = scan;
    this.onProgress = onProgress;
  }

  async run(): Promise<ScanResult> {
    const opts: ScanOptions = { ...this.scan.scan_options };
    const urls: string[] = this.scan.urls || [];
    const authConfig = this.scan.auth_config;
    const workflowType = opts.workflow_type || authConfig?.workflow_type || "generic";
    const isSkyWorkflow = workflowType === "sky";
    const extraStates = opts.extra_states || [];
    const scannedEntrypoints = new Set<string>();

    const stepsPerUrl = 12;
    const maxPerSeed = opts.crawl_mode
      ? Math.min(Math.max(1, opts.crawl_max_pages ?? 30), 200)
      : 1;
    const totalSteps = Math.max(1, urls.length * maxPerSeed) * stepsPerUrl;
    let stepsDone = 0;

    const progress = (msg: string) => {
      stepsDone++;
      this.onProgress(Math.min(Math.round((stepsDone / totalSteps) * 94) + 1, 94), msg);
    };

    // headless:true is REQUIRED on Azure App Service Linux (no display server).
    // The extra args reduce automation fingerprint so CDN bot detection is less
    // aggressive than against the default Playwright profile.
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--disable-extensions",
        "--no-first-run",
        "--window-size=1366,768",
      ],
    });

    try {
      for (const url of urls) {
        logger.info(`Scanning URL: ${url}`);

        try {
          if (authConfig?.login_url) {
            const loginKey = canonicalUrlKey(authConfig.login_url) || authConfig.login_url;
            if (opts.scan_login_page !== false && !scannedEntrypoints.has(loginKey)) {
              const loginContext = await this.createBrowserContext(browser, opts);
              const loginPage = await loginContext.newPage();
              try {
                progress(`Scanning login page before authentication: ${authConfig.login_url}`);
                  this.trackPageNavigations(loginPage, "login page");
                  const ok = await this.navigateAndRecord(loginPage, authConfig.login_url, "login page");
                if (ok) {
                  await loginPage.waitForTimeout(1200);
                  if (authConfig.auto_accept_cookies !== false) {
                    await this.clearCookieConsentWithProgress(loginPage, this.authSelector(authConfig, "cookie_accept_selector"), progress, "login page");
                  }
                  await this.runFullPageScan(loginPage, authConfig.login_url, opts, extraStates, progress);
                  scannedEntrypoints.add(loginKey);
                }
              } catch (err) {
                logger.warn(`Login page scan failed for ${authConfig.login_url}; continuing with authenticated scan:`, err);
              } finally {
                await loginContext.close();
              }
            }
            //Creates browser context and waits till login authentication is completed
              const context = await this.createBrowserContext(browser, opts);
              const page = await context.newPage();
              this.trackPageNavigations(page, "authenticated session");
              try {
              progress(isSkyWorkflow ? `Authenticating with Sky login and OTP flow for ${url}` : `Authenticating with generic login flow for ${url}`);
              const landedUrl = await this.handleLogin(page, authConfig);
              progress(isSkyWorkflow ? `SUCCESS: Sky login and OTP completed; landed on ${landedUrl}` : `SUCCESS: Login completed; landed on ${landedUrl}`);
              const landedKey = canonicalUrlKey(landedUrl) || landedUrl;
              const landedAuthKey = `auth:${landedKey}`;

              if (opts.scan_post_login_landing !== false && landedUrl && !scannedEntrypoints.has(landedAuthKey)) {
                progress(`Scanning post-login landing page: ${landedUrl}`);
                await this.ensureAuthenticatedPage(page, authConfig, landedUrl);
                await this.runFullPageScan(page, landedUrl, opts, extraStates, progress);
                progress(`SUCCESS: Completed authenticated landing scan`);
                scannedEntrypoints.add(landedAuthKey);
                if (isSkyWorkflow && opts.post_login_tab_scan !== false) {
                  const tabLimit = Math.min(Math.max(1, opts.post_login_tab_limit ?? 12), 30);
                  await this.scanLinkedPageStates(page, landedUrl, opts, extraStates, progress, tabLimit);
                }
              }

              const profileUrl = isSkyWorkflow ? (authConfig.profile_url || url) : url;
              const profileKey = canonicalUrlKey(profileUrl) || profileUrl;
              const profileAuthKey = `auth:${profileKey}`;
              if (profileUrl && !scannedEntrypoints.has(profileAuthKey)) {
                progress(isSkyWorkflow ? `Opening authenticated profile/Gestisci page: ${profileUrl}` : `Opening authenticated target page: ${profileUrl}`);
                const ok = await this.navigateAndRecord(page, profileUrl, "authenticated profile/Gestisci page");
                if (!ok) throw new Error(`Authenticated profile page is unreachable: ${profileUrl}`);
                await page.waitForTimeout(1500);
                await this.ensureAuthenticatedPage(page, authConfig, profileUrl);
                await this.runFullPageScan(page, profileUrl, opts, extraStates, progress);
                progress(isSkyWorkflow ? `SUCCESS: Completed authenticated profile/Gestisci scan` : `SUCCESS: Completed authenticated target scan`);
                scannedEntrypoints.add(profileAuthKey);
                if (isSkyWorkflow && opts.post_login_tab_scan !== false) {
                  const tabLimit = Math.min(Math.max(1, opts.post_login_tab_limit ?? 12), 30);
                  await this.scanLinkedPageStates(page, profileUrl, opts, extraStates, progress, tabLimit);
                }
              }

              if (isSkyWorkflow) {
                await this.scanConfiguredPostLoginPages(page, profileUrl || landedUrl || url, opts, extraStates, progress, scannedEntrypoints, authConfig);
              }

              const targetKey = canonicalUrlKey(url) || url;
              const targetAuthKey = `auth:${targetKey}`;
              if (opts.crawl_mode) {
                await this.runCrawlBfsForSeed(page, url, opts, extraStates, progress);
              } else if (!scannedEntrypoints.has(targetAuthKey)) {
                progress(`Navigating to authenticated target ${url}`);
                const ok = await this.navigateAndRecord(page, url, "authenticated target");
                if (!ok) {
                  logger.warn(`Skipping unreachable URL: ${url}`);
                  continue;
                }
                await page.waitForTimeout(1200);
                await this.ensureAuthenticatedPage(page, authConfig, url);
                await this.runFullPageScan(page, url, opts, extraStates, progress);
                scannedEntrypoints.add(targetAuthKey);
                if (isSkyWorkflow) {
                  await this.scanLinkedPageStates(page, url, opts, extraStates, progress);
                }
              }
            } finally {
              await context.close();
            }

            continue;
          }

          const context = await this.createBrowserContext(browser, opts);
          const page = await context.newPage();
          this.trackPageNavigations(page, "scan page");
          try {
            if (opts.crawl_mode) {
              await this.runCrawlBfsForSeed(page, url, opts, extraStates, progress);
            } else {
              progress(`Navigating to ${url}`);
              const ok = await this.navigateAndRecord(page, url, "scan target");
              if (!ok) {
                logger.warn(`Skipping unreachable URL: ${url}`);
                continue;
              }
              await page.waitForTimeout(1200);
              await this.runFullPageScan(page, url, opts, extraStates, progress);
              if (isSkyWorkflow) {
                await this.scanLinkedPageStates(page, url, opts, extraStates, progress);
              }
            }
          } finally {
            await context.close();
          }

        } catch (err) {
          logger.error(`Error scanning ${url}:`, err);
        }
      }
    } finally {
      await browser.close();
    }

    this.allIssues = this.prioritizeIssues(this.calibrateIssues(this.deduplicateIssues(this.allIssues)));
    this.generateTestCases();
    this.generateManualHybridReviewCases();
    const score = this.computeScore(this.allIssues);
    logger.info(`Scan navigation trail (${this.navigatedUrls.length} URL${this.navigatedUrls.length === 1 ? "" : "s"}): ${this.navigatedUrls.join(" -> ") || "none recorded"}`);
    logger.info(`Scan complete: ${this.allIssues.length} issues, score ${score}`);
    return { issues: this.allIssues, testCases: this.testCases, domSnapshots: this.domSnapshots, navigatedUrls: this.navigatedUrls, score };
  }

  // Browser context configured with Italian locale, Rome timezone, real Chrome
  // user agent, and basic webdriver masking. Without these, Sky's CDN can flag
  // the scanner as automation even when the source IP is allowlisted, because
  // CDN bot detection inspects fingerprint, not just IP.
  private async createBrowserContext(browser: any, opts: ScanOptions): Promise<any> {
    const context = await browser.newContext({
      viewport: { width: opts.viewport_width || 1366, height: opts.viewport_height || 768 },
      ignoreHTTPSErrors: true,
      locale: "it-IT",
      timezoneId: "Europe/Rome",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      colorScheme: "light",
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["it-IT", "it", "en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    });
    return context;
  }

  
  private attachScanDiagnostics(page: Page): void {
    page.on("framenavigated", (frame) => {
      try {
        if (frame === page.mainFrame()) {
          const url = frame.url();
          logger.info(`[SCAN-DIAG][NAV] ${url}`);
          if (/gestisci|profile|account|profilo/i.test(url)) {
            logger.warn(`[SCAN-DIAG][ACCOUNT-PAGE] Browser navigated to account/profile page: ${url}`);
          }
        }
      } catch {
        // ignore
      }
    });
  }

private trackPageNavigations(page: any, context: string): void {
    page.on("request", (request: any) => {
      try {
        if (request.isNavigationRequest?.() && request.resourceType?.() === "document" && request.frame?.() === page.mainFrame()) {
          this.recordNavigatedUrl(request.url(), `${context} document request`);
        }
      } catch { /* ignore navigation observer errors */ }
    });
    page.on("framenavigated", (frame: any) => {
      try {
        if (frame === page.mainFrame()) {
          this.recordNavigatedUrl(frame.url(), context);
        }
      } catch { /* ignore navigation observer errors */ }
    });
  }

  private recordNavigatedUrl(rawUrl: string, context: string): void {
    const url = String(rawUrl || "").trim();
    if (!url || url === "about:blank") return;
    const key = url;
    if (this.navigatedUrlKeys.has(key)) {
      logger.info(`Scan revisited URL (${context}): ${url}`);
      return;
    }
    this.navigatedUrlKeys.add(key);
    this.navigatedUrls.push(url);
    logger.info(`Scan navigated through URL (${context}): ${url}`);
  }

  private async navigateAndRecord(page: any, url: string, context: string): Promise<boolean> {
    this.recordNavigatedUrl(url, `${context} requested`);
    const ok = await navigateSafely(page, url);
    this.recordNavigatedUrl(page.url(), `${context} reached`);
    return ok;
  }

  private async handleLogin(page: any, auth: any): Promise<string> {
    try {
      const isSkyWorkflow = auth?.workflow_type === "sky";
      const usernameSelector = this.authSelector(auth, "username_selector");
      const passwordSelector = this.authSelector(auth, "password_selector");
      const submitSelector = this.authSelector(auth, "submit_selector");
      if (!usernameSelector) throw new Error("Username field selector is required for authenticated scans.");
      if (!passwordSelector) throw new Error("Password field selector is required for authenticated scans.");
      if (!submitSelector) throw new Error("Login submit selector is required for authenticated scans.");

      await this.navigateAndRecord(page, auth.login_url, "login");
      if (isSkyWorkflow) await this.waitForSkyLoginReady(page);
      else await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
      if (auth.auto_accept_cookies !== false) await this.waitAndClearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector"), 12000);
      const loginUrl = page.url();
      logger.info(`[LOGIN-DIAG] Login page loaded. URL: ${loginUrl}`);

      logger.info(`Using configured login selectors: username='${usernameSelector}', password='${passwordSelector}', submit='${submitSelector}'`);

      const usernameFilled = await this.tryFillFirst(page, usernameSelector, auth.username || "", 12000);
      const usernameVerified = usernameFilled && await this.verifyFieldValue(page, usernameSelector, auth.username || "");
      if (!usernameVerified) {
        throw new Error(`Login username field was not found, was not filled, or did not retain the value with selector: ${usernameSelector}`);
      }
      logger.info(`[LOGIN-DIAG] Username field filled and verified.`);
      this.onProgress(12, "SUCCESS: Username entered");

      let passwordFilled = await this.tryFillFirst(page, passwordSelector, auth.password || "", 12000);
      let passwordVerified = passwordFilled && await this.verifyFieldValue(page, passwordSelector, auth.password || "");

      if (!passwordVerified) {
        throw new Error(`Login password field was not found, was not filled, or did not retain the value with selector: ${passwordSelector}`);
      }
      logger.info(`[LOGIN-DIAG] Password field filled and verified.`);
      this.onProgress(16, "SUCCESS: Password entered");

      if (auth.auto_accept_cookies !== false) {
        await this.waitAndClearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector"), 8000);
      }

      const readyToSubmit =
        await this.verifyFieldValue(page, usernameSelector, auth.username || "") &&
        await this.verifyFieldValue(page, passwordSelector, auth.password || "");

      if (!readyToSubmit) {
        throw new Error("Refusing to click Accedi because username/password are not both verified immediately before submit.");
      }

      this.attachLoginNetworkDiagnostics(page);

      logger.info(`[LOGIN-DIAG] Before Accedi click URL: ${page.url()}`);
      const errorBeforeClick = await this.getVisibleLoginError(page);
      logger.info(`[LOGIN-PROOF] Before Accedi click: url=${page.url()}, visibleLoginError=${errorBeforeClick || "none"}`);
      await this.captureLoginProofSnapshot(page, "before-accedi-click", errorBeforeClick);

      logger.info(`[LOGIN-DIAG] Clicking configured Accedi submit control.`);
      const clickStartedAt = Date.now();
      const submitMethod = await this.submitLoginWithFallbacks(page, auth, loginUrl, submitSelector, passwordSelector);
      logger.info(`[LOGIN-DIAG] Accedi activation result: ${submitMethod}`);
      this.logLoginNetworkSummary("after Accedi activation");

      this.onProgress(17, "SUCCESS: Accedi clicked");
      await this.waitForLoginTransition(page, auth, loginUrl, Math.max(12000, Number(auth.post_login_wait_ms || 0)));

      const loginError = await this.getVisibleLoginError(page);
      logger.info(`[LOGIN-PROOF] After Accedi click + ${Date.now() - clickStartedAt}ms: url=${page.url()}, visibleLoginError=${loginError || "none"}`);
      await this.captureLoginProofSnapshot(page, "after-accedi-click", loginError);
      this.logLoginNetworkSummary("after Accedi transition wait");
      if (loginError) {
        throw new Error(`Sky rejected the login after Accedi: ${loginError}`);
      }

      const urlAfterSubmit = page.url();
      logger.info(`[LOGIN-DIAG] After Accedi transition wait. URL: ${urlAfterSubmit} (changed: ${urlAfterSubmit !== loginUrl ? "YES" : "NO"})`);
      if (auth.auto_accept_cookies !== false) await this.clearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector"));

      const otpSelector = this.authSelector(auth, "otp_selector");
      const otpSubmitSelector = this.authSelector(auth, "otp_submit_selector");
      const shouldHandleOtp = isSkyWorkflow || Boolean(auth.otp_code) || Boolean(auth.otp_from_page && this.authSelector(auth, "otp_source_selector")) || Boolean(otpSelector && otpSubmitSelector);
      if (shouldHandleOtp) {
        await this.waitForOtpPage(page, auth, isSkyWorkflow ? 30000 : 10000);
        const otpValue = await this.resolveOtpValue(page, auth, isSkyWorkflow ? 30000 : 10000);
        const otpControlVisible = await this.hasVisibleAuthControl(page, otpSelector);
        if (otpSelector && otpControlVisible && !otpValue) {
          throw new Error("OTP input is visible, but no OTP value could be resolved from the configured page selector or manual OTP code.");
        }
        if (otpSelector && otpValue) {
          try {
            await this.fillOtpInputs(page, otpSelector, otpValue, Math.min(auth.post_login_wait_ms || 8000, 15000));
            const otpVerified = await this.verifyOtpInputs(page, otpSelector, otpValue);
            if (!otpVerified) throw new Error("OTP fields did not retain all expected digits.");
            this.onProgress(18, "SUCCESS: OTP entered");
            if (auth.auto_accept_cookies !== false) await this.clearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector"));
            if (otpSubmitSelector) await this.clickFirst(page, otpSubmitSelector);
            else {
              const submittedOtp = await this.tryClickFirst(page, submitSelector);
              if (!submittedOtp) await page.keyboard.press("Enter").catch(() => undefined);
            }
            this.onProgress(20, "SUCCESS: OTP confirmed");
            await this.waitForLoginTransition(page, auth, loginUrl, 5000);
          } catch (otpErr) {
            throw new Error(`OTP field was configured but could not be completed: ${(otpErr as Error)?.message || otpErr}`);
          }
        }
      }

      await this.waitForPostLoginReady(page, auth, loginUrl);
      if (auth.auto_accept_cookies !== false) await this.clearCookieConsent(page, this.authSelector(auth, "cookie_accept_selector"));
      if (await this.hasVisibleAuthControl(page, passwordSelector) || (shouldHandleOtp && await this.hasVisibleAuthControl(page, otpSelector))) {
        throw new Error("Login did not complete; password or OTP controls are still visible.");
      }
      await this.ensureAuthenticatedPage(page, auth, page.url());
    logger.info(`[SCAN-DIAG][POST-AUTH] Authenticated URL: ${page.url()}`);
    this.attachScanDiagnostics(page);
      return page.url();
    } catch (err) {
      this.logLoginNetworkSummary("login failure catch");
      logger.warn("Login failed; scan will not continue with the login page:", err);
      throw err;
    }
  }

  private async ensureAuthenticatedPage(page: any, auth: any, expectedUrl: string): Promise<void> {
    const currentUrl = page.url();
    const loginUrl = String(auth.login_url || "");
    const successPattern = String(auth.success_url_pattern || "").trim();

    logger.info(`[AUTH-VERIFY] Current URL: ${currentUrl}`);

    const cookies = await page.context().cookies().catch(() => []);
    logger.info(
      `[AUTH-VERIFY] Cookies: ${cookies.map((c: any) => `${c.name}@${c.domain}`).join(", ")}`
    );

    if (await this.hasVisibleAuthControl(page, this.authSelector(auth, "password_selector")) ||
        await this.hasVisibleAuthControl(page, this.authSelector(auth, "otp_selector"))) {
      this.logLoginNetworkSummary("authenticated page validation failed");
      throw new Error(`Authentication failed; login controls are still visible on ${currentUrl}.`);
    }

    if (successPattern) {
      if (!currentUrl.includes(successPattern)) {
        throw new Error(
          `Authentication completed but success URL pattern '${successPattern}' was not reached. Current URL: ${currentUrl}`
        );
      }
      return;
    }

    if (/security|verify-enrollment|mfa/i.test(currentUrl)) {
      throw new Error(
        `Authentication appears incomplete. Browser is still on MFA/Security flow: ${currentUrl}`
      );
    }

    if (/\/login|signin|sign-in|auth/i.test(currentUrl) &&
        !this.sameUrlWithoutHash(currentUrl, expectedUrl) &&
        !this.sameUrlWithoutHash(currentUrl, loginUrl)) {
      throw new Error(
        `Authentication appears incomplete. Current URL still resembles an authentication page: ${currentUrl}`
      );
    }
  }

  private sameUrlWithoutHash(a: string, b: string): boolean {
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      ua.hash = "";
      ub.hash = "";
      return ua.href === ub.href;
    } catch {
      return a.split("#")[0] === b.split("#")[0];
    }
  }

  private async waitForLoginTransition(page: any, auth: any, loginUrl: string, timeout = 5000): Promise<void> {
    await Promise.race([
      page.waitForURL((url: URL) => url.href !== loginUrl, { timeout }).catch(() => undefined),
      page.waitForLoadState("networkidle", { timeout }).catch(() => undefined),
      page.waitForTimeout(timeout)
    ]);
    await page.waitForTimeout(1800).catch(() => undefined);
    await page.waitForLoadState("load", { timeout: 5000 }).catch(() => undefined);
  }

  private async submitLoginWithFallbacks(
    page: any,
    auth: any,
    loginUrl: string,
    submitSelector: string,
    passwordSelector: string
  ): Promise<string> {
    const attempts: Array<{ name: string; run: () => Promise<boolean> }> = [
      {
        name: "selector click",
        run: () => this.tryClickFirst(page, submitSelector),
      },
      {
        name: "visible text click",
        run: () => this.clickByVisibleText(page, "Accedi"),
      },
      {
        name: "DOM form requestSubmit",
        run: () => this.requestSubmitLoginForm(page, submitSelector),
      },
      {
        name: "password Enter key",
        run: async () => {
          const focused = await this.focusFirstAuthControl(page, passwordSelector);
          if (!focused) return false;
          await page.keyboard.press("Enter").catch(() => undefined);
          return true;
        },
      },
    ];

    for (const attempt of attempts) {
      const beforeUrl = page.url();
      logger.info(`[LOGIN-DIAG] Trying Accedi activation via ${attempt.name}.`);
      const activated = await attempt.run().catch((err: any) => {
        logger.info(`[LOGIN-DIAG] ${attempt.name} failed before activation: ${err?.message || err}`);
        return false;
      });
      if (!activated) continue;

      const signalTimeout = attempt.name === "selector click"
        ? Math.max(15000, Number(auth.post_login_wait_ms || 0))
        : 5000;
      await this.waitForLoginAttemptSignal(page, auth, loginUrl, beforeUrl, signalTimeout);
      const signal = await this.describeLoginAttemptSignal(page, auth, loginUrl, beforeUrl);
      logger.info(`[LOGIN-DIAG] ${attempt.name} post-activation signal: ${signal}`);
      if (signal !== "no visible state change") return `${attempt.name}; ${signal}`;
    }

    this.logLoginNetworkSummary("before Accedi fallback failure");
    throw new Error(`Accedi submit control did not produce a login state change after selector, text, DOM submit, and Enter-key attempts. Selector: ${submitSelector}`);
  }

  private async waitForLoginAttemptSignal(page: any, auth: any, loginUrl: string, beforeUrl: string, timeout = 4500): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const signal = await this.describeLoginAttemptSignal(page, auth, loginUrl, beforeUrl);
      if (signal !== "no visible state change") return;
      await page.waitForLoadState("domcontentloaded", { timeout: 500 }).catch(() => undefined);
      await page.waitForTimeout(500).catch(() => undefined);
    }
  }

  private async describeLoginAttemptSignal(page: any, auth: any, loginUrl: string, beforeUrl: string): Promise<string> {
    const currentUrl = page.url();
    const loginError = await this.getVisibleLoginError(page);
    if (loginError) return `login error displayed: ${loginError}`;
    if (currentUrl !== beforeUrl || currentUrl !== loginUrl) return `URL changed to ${currentUrl}`;
    if (await this.hasVisibleAuthControl(page, this.authSelector(auth, "otp_selector")).catch(() => false)) return "OTP control visible";
    if (!await this.hasVisibleAuthControl(page, this.authSelector(auth, "password_selector")).catch(() => true)) return "password control disappeared";
    return "no visible state change";
  }

  private async focusFirstAuthControl(page: any, selectorList?: string): Promise<boolean> {
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        try {
          const locator = root.locator(selector).first();
          if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
            await locator.focus({ timeout: 1000 }).catch(async () => {
              await locator.click({ timeout: 1000 });
            });
            return true;
          }
        } catch { /* try deep focus */ }
        try {
          const focused = await root.evaluate((selector: string) => {
            const find = (container: Document | ShadowRoot | Element): HTMLElement | null => {
              const direct = (container as Document | ShadowRoot | Element).querySelector?.(selector) as HTMLElement | null;
              if (direct) return direct;
              for (const child of Array.from((container as Document | ShadowRoot | Element).querySelectorAll?.("*") || [])) {
                const shadow = (child as HTMLElement).shadowRoot;
                if (!shadow) continue;
                const found = find(shadow);
                if (found) return found;
              }
              return null;
            };
            const el = find(document);
            if (!el) return false;
            el.focus();
            return document.activeElement === el || (el.getRootNode() as ShadowRoot).activeElement === el;
          }, selector).catch(() => false);
          if (focused) return true;
        } catch { /* try next selector */ }
      }
    }
    return false;
  }

  private async requestSubmitLoginForm(page: any, submitSelector?: string): Promise<boolean> {
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(submitSelector)) {
        const submitted = await root.evaluate((selector: string) => {
          const queryDeep = (container: Document | ShadowRoot | Element, selector: string): HTMLElement | null => {
            if (selector.startsWith("js=")) {
              try {
                const el = Function(`"use strict"; return (${selector.slice(3)});`)();
                return el instanceof HTMLElement ? el : null;
              } catch {
                return null;
              }
            }
            try {
              const direct = (container as Document | ShadowRoot | Element).querySelector(selector) as HTMLElement | null;
              if (direct) return direct;
            } catch {
              return null;
            }
            for (const child of Array.from((container as Document | ShadowRoot | Element).querySelectorAll?.("*") || [])) {
              const shadow = (child as HTMLElement).shadowRoot;
              if (!shadow) continue;
              const found = queryDeep(shadow, selector);
              if (found) return found;
            }
            return null;
          };
          const submitter = queryDeep(document, selector);
          const form = submitter?.closest("form") as HTMLFormElement | null;
          if (!form) return false;
          if (typeof form.requestSubmit === "function") form.requestSubmit(submitter as HTMLButtonElement);
          else form.submit();
          return true;
        }, selector).catch(() => false);
        if (submitted) return true;
      }
    }
    return false;
  }

  private attachLoginNetworkDiagnostics(page: any): void {
    this.loginNetworkDiagnostics = {
      clientAuthorizeHit: false,
      userLoginHit: false,
      importantIncidents: [],
    };
    this.importantNetworkPending.clear();

    page.on("request", (request: any) => {
      const url = request.url();
      if (/cronus|login|auth|otp|skyid/i.test(url)) {
        logger.info(`[LOGIN-NET][REQ] ${request.method()} ${url}`);
      }
      if (this.isImportantAuthNetworkUrl(url)) {
        this.importantNetworkPending.set(request, { method: request.method(), url, startedAt: Date.now() });
      }
      if (this.isCronusClientAuthorize(url)) {
        this.loginNetworkDiagnostics.clientAuthorizeHit = true;
        logger.info(`[LOGIN-NET][CLIENT-AUTHORIZE][REQ] method=${request.method()} url=${url}`);
      }
      if (this.isCronusUserLogin(url)) {
        this.loginNetworkDiagnostics.userLoginHit = true;
        logger.info(`[LOGIN-NET][USER-LOGIN][REQ] method=${request.method()} url=${url}`);
      }
    });

    page.on("response", async (response: any) => {
      const url = response.url();
      const status = response.status();
      const request = response.request?.();
      const pending = request ? this.importantNetworkPending.get(request) : undefined;
      if (request) this.importantNetworkPending.delete(request);
      if (/cronus|login|auth|otp|skyid/i.test(url)) {
        logger.info(`[LOGIN-NET][RES] ${status} ${url}`);
      }
      if (this.isImportantAuthNetworkUrl(url) && status >= 400) {
        const preview = await this.safeResponsePreview(response);
        const elapsed = pending ? `${Date.now() - pending.startedAt}ms` : "unknown";
        const incident = `${response.request?.().method?.() || pending?.method || "?"} ${url} -> HTTP ${status} after ${elapsed}${preview ? ` body=${preview}` : ""}`;
        this.rememberImportantNetworkIncident(incident);
        logger.warn(`[LOGIN-NET][IMPORTANT][HTTP-ERROR] ${incident}`);
      }
      if (this.isCronusClientAuthorize(url)) {
        this.loginNetworkDiagnostics.clientAuthorizeHit = true;
        this.loginNetworkDiagnostics.clientAuthorizeStatus = status;
        if (!response.ok()) this.loginNetworkDiagnostics.clientAuthorizeFailure = `HTTP ${status}`;
        logger.info(`[LOGIN-NET][CLIENT-AUTHORIZE][RES] status=${status} ok=${response.ok()} url=${url}`);
      }
      if (this.isCronusUserLogin(url)) {
        this.loginNetworkDiagnostics.userLoginHit = true;
        this.loginNetworkDiagnostics.userLoginStatus = status;
        if (!response.ok()) this.loginNetworkDiagnostics.userLoginFailure = `HTTP ${status}`;
        const preview = !response.ok() ? await this.safeResponsePreview(response) : "";
        if (preview) this.loginNetworkDiagnostics.userLoginPreview = preview;
        logger.info(`[LOGIN-NET][USER-LOGIN][RES] status=${status} ok=${response.ok()}${preview ? ` body=${preview}` : ""} url=${url}`);
      }
    });

    page.on("requestfailed", (request: any) => {
      const url = request.url();
      const failure = request.failure?.()?.errorText || "unknown failure";
      const pending = this.importantNetworkPending.get(request);
      this.importantNetworkPending.delete(request);
      if (/cronus|login|auth|otp|skyid/i.test(url)) {
        logger.warn(`[LOGIN-NET][REQ-FAILED] ${request.method()} ${url} failure=${failure}`);
      }
      if (this.isImportantAuthNetworkUrl(url)) {
        const elapsed = pending ? `${Date.now() - pending.startedAt}ms` : "unknown";
        const incident = `${request.method()} ${url} failed after ${elapsed}: ${failure}`;
        this.rememberImportantNetworkIncident(incident);
        logger.warn(`[LOGIN-NET][IMPORTANT][REQ-FAILED] ${incident}`);
      }
      if (this.isCronusClientAuthorize(url)) {
        this.loginNetworkDiagnostics.clientAuthorizeHit = true;
        this.loginNetworkDiagnostics.clientAuthorizeFailure = failure;
        logger.warn(`[LOGIN-NET][CLIENT-AUTHORIZE][REQ-FAILED] failure=${failure} url=${url}`);
      }
      if (this.isCronusUserLogin(url)) {
        this.loginNetworkDiagnostics.userLoginHit = true;
        this.loginNetworkDiagnostics.userLoginFailure = failure;
        logger.warn(`[LOGIN-NET][USER-LOGIN][REQ-FAILED] failure=${failure} url=${url}`);
      }
    });
  }

  private isImportantAuthNetworkUrl(url: string): boolean {
    return /test\.cerebro-platform\.sky\.it|test-www\.sky\.it|test\.abbonamento\.sky\.it|\/cronus\/|\/otp\b|\/login\b|\/auth\b|\/authorize\b|\/token\b|skyid/i.test(url);
  }

  private isCronusClientAuthorize(url: string): boolean {
    return /\/cronus\/v2\/client\/authorize\b/i.test(url);
  }

  private isCronusUserLogin(url: string): boolean {
    return /\/cronus\/v2\/user\/login\b/i.test(url);
  }

  private async safeResponsePreview(response: any): Promise<string> {
    try {
      const contentType = String(response.headers?.()["content-type"] || "");
      if (!/json|text|html|plain/i.test(contentType)) return `content-type=${contentType || "unknown"}`;
      const text = await response.text();
      return this.sanitizeNetworkBody(text).slice(0, 800);
    } catch (err) {
      return `body unavailable: ${(err as Error)?.message || err}`;
    }
  }

  private sanitizeNetworkBody(value: string): string {
    return String(value || "")
      .replace(/("?(?:access_token|refresh_token|id_token|token|password|authorization)"?\s*[:=]\s*)"[^"]+"/gi, "$1\"[redacted]\"")
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
      .replace(/\s+/g, " ")
      .trim();
  }

  private rememberImportantNetworkIncident(incident: string): void {
    const list = this.loginNetworkDiagnostics.importantIncidents;
    if (list.includes(incident)) return;
    list.push(incident);
    if (list.length > 12) list.shift();
  }

  private logLoginNetworkSummary(context: string): void {
    const diag = this.loginNetworkDiagnostics;
    const pending = [...this.importantNetworkPending.values()]
      .filter(item => this.isImportantAuthNetworkUrl(item.url))
      .slice(-8)
      .map(item => `${item.method} ${item.url} pending ${Date.now() - item.startedAt}ms`);
    logger.info(
      `[LOGIN-NET][SUMMARY] ${context}: ` +
      `clientAuthorizeHit=${diag.clientAuthorizeHit ? "YES" : "NO"}` +
      `${typeof diag.clientAuthorizeStatus === "number" ? ` clientAuthorizeStatus=${diag.clientAuthorizeStatus}` : ""}` +
      `${diag.clientAuthorizeFailure ? ` clientAuthorizeFailure=${diag.clientAuthorizeFailure}` : ""}; ` +
      `userLoginHit=${diag.userLoginHit ? "YES" : "NO"}` +
      `${typeof diag.userLoginStatus === "number" ? ` userLoginStatus=${diag.userLoginStatus}` : ""}` +
      `${diag.userLoginFailure ? ` userLoginFailure=${diag.userLoginFailure}` : ""}` +
      `${diag.userLoginPreview ? ` userLoginBody=${diag.userLoginPreview}` : ""}` +
      `${diag.importantIncidents.length ? `; importantFailures=${diag.importantIncidents.join(" || ")}` : ""}` +
      `${pending.length ? `; pendingImportantRequests=${pending.join(" || ")}` : ""}`
    );
  }

  private async captureLoginProofSnapshot(page: any, phase: string, visibleError?: string | null): Promise<void> {
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 68, fullPage: false });
      this.domSnapshots.push({
        url: page.url(),
        phase,
        state: phase,
        a11yTree: {
          proof: "Accedi click diagnostic",
          visibleLoginError: visibleError || null,
          capturedAt: new Date().toISOString(),
        },
        screenshot: `data:image/jpeg;base64,${buf.toString("base64")}`,
      });
      logger.info(`[LOGIN-PROOF] Screenshot captured for ${phase} (${Math.round(buf.length / 1024)}KB).`);
    } catch (err) {
      logger.warn(`[LOGIN-PROOF] Screenshot capture failed for ${phase}: ${(err as Error)?.message || err}`);
    }
  }

  private async getVisibleLoginError(page: any): Promise<string | null> {
    return page.evaluate(() => {
      const errorPattern = /si e verificato un problema durante l'accesso|si e verificato un problema durante l.accesso|problema durante l.accesso|contatta il servizio clienti sky|password errata|password non corretta|email non valida|credenziali non valide|troppe richieste|account bloccato|account sospeso|servizio non disponibile|sessione scaduta|invalid credentials|wrong password|too many attempts|account locked/i;
      const normalize = (value: string) =>
        String(value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const collectElements = (container: Document | ShadowRoot | Element): Element[] => {
        const direct = Array.from((container as Document | ShadowRoot | Element).querySelectorAll?.("*") || []);
        const nested = direct.flatMap(child => (child as HTMLElement).shadowRoot ? collectElements((child as HTMLElement).shadowRoot!) : []);
        return [...direct, ...nested];
      };

      const candidates = collectElements(document)
        .filter(isVisible)
        .map(el => normalize((el as HTMLElement).innerText || el.textContent || ""))
        .filter(Boolean);

      const match = candidates.find(text => errorPattern.test(text));
      if (!match) return null;
      const found = match.match(errorPattern)?.[0] || match;
      const idx = match.toLowerCase().indexOf(found.toLowerCase());
      return match.substring(Math.max(0, idx - 80), Math.min(match.length, idx + 180));
    }).catch(() => null);
  }

  private async waitForPostLoginReady(page: any, auth: any, loginUrl: string): Promise<void> {
    const requestedWait = Number(auth.post_login_wait_ms || 0);
    const timeout = Math.max(15000, Math.min(requestedWait || 15000, 45000));
    const successPattern = String(auth.success_url_pattern || "").trim();

    if (successPattern) {
      const reached = await page.waitForFunction(
        (pattern: string) => window.location.href.includes(pattern),
        successPattern,
        { timeout }
      ).then(() => true).catch(() => false);
      if (!reached) {
        throw new Error(`Login success URL pattern was not reached within ${timeout}ms: ${successPattern}`);
      }
    } else {
      await Promise.race([
        page.waitForURL((url: URL) => url.href !== loginUrl && !url.href.includes("/login"), { timeout }).catch(() => undefined),
        page.waitForFunction(
          (selectors: { passwordSelector?: string; otpSelector?: string }) => {
            const { passwordSelector, otpSelector } = selectors;
            const visible = (selector?: string) => {
              if (!selector) return false;
              try {
                return Array.from(document.querySelectorAll(selector)).some((el: any) => {
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
                });
              } catch {
                return false;
              }
            };
            return document.readyState === "complete" && !visible(passwordSelector) && !visible(otpSelector);
          },
          { passwordSelector: this.authSelector(auth, "password_selector"), otpSelector: this.authSelector(auth, "otp_selector") },
          { timeout }
        ).catch(() => undefined),
        page.waitForTimeout(timeout)
      ]);
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
    await page.waitForLoadState("load", { timeout: 10000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(Math.max(1500, Math.min(requestedWait || 2000, 5000)));
  }

  private async waitForSkyLoginReady(page: any): Promise<void> {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    await page.waitForFunction(() => {
      const find = (selector: string): Element | null => {
        const direct = document.querySelector(selector);
        if (direct) return direct;
        for (const el of Array.from(document.querySelectorAll("*"))) {
          const shadow = (el as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = shadow.querySelector(selector);
          if (found) return found;
          for (const nested of Array.from(shadow.querySelectorAll("*"))) {
            const nestedShadow = (nested as HTMLElement).shadowRoot;
            const nestedFound = nestedShadow?.querySelector(selector);
            if (nestedFound) return nestedFound;
          }
        }
        return null;
      };
      return Boolean(find("#sky-login-email") || document.querySelector("sky-login-component#sky-login"));
    }, { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }

  // ── DIAGNOSTIC waitForOtpPage ─────────────────────────────────────────────
  // Logs URL changes and page state every 5 polls; on timeout, captures a
  // screenshot and lists visible controls + any Italian/English error message,
  // so Azure failures are debuggable from log stream alone instead of guessing.
  private async waitForOtpPage(page: any, auth: any, timeout = 30000): Promise<void> {
    const otpSelector = this.authSelector(auth, "otp_selector");
    const otpSourceSelector = this.authSelector(auth, "otp_source_selector");
    const passwordSelector = this.authSelector(auth, "password_selector");
    const deadline = Date.now() + timeout;

    const startUrl = page.url();
    logger.info(`[OTP-WAIT] Starting OTP detection. Current URL: ${startUrl}`);
    logger.info(`[OTP-WAIT] OTP source selector: '${(otpSourceSelector || "").slice(0, 120)}'`);
    logger.info(`[OTP-WAIT] OTP input selector:  '${(otpSelector || "").slice(0, 120)}'`);
    logger.info(`[OTP-WAIT] otp_from_page: ${Boolean(auth?.otp_from_page)}, otp_code preset: ${Boolean(auth?.otp_code)}`);

    let pollCount = 0;
    while (Date.now() < deadline) {
      pollCount++;
      const hasOtpText = Boolean(await this.resolveOtpValue(page, auth, 1000).catch(() => ""));
      const hasOtpInput = await this.hasVisibleAuthControl(page, otpSelector).catch(() => false);
      const hasSource = await this.hasVisibleAuthControl(page, otpSourceSelector).catch(() => false);

      if (hasOtpText || hasOtpInput || hasSource) {
        logger.info(`[OTP-WAIT] OTP page detected after ${pollCount} polls (~${Math.round(pollCount * 0.7)}s). otpText=${hasOtpText}, otpInput=${hasOtpInput}, otpSource=${hasSource}`);
        this.onProgress(17, "SUCCESS: OTP page detected");
        return;
      }

      if (pollCount % 5 === 0) {
        const currentUrl = page.url();
        const passwordStillVisible = await this.hasVisibleAuthControl(page, passwordSelector).catch(() => false);
        const cookieStillVisible = await this.hasCookieConsentPrompt(page).catch(() => false);
        logger.info(`[OTP-WAIT] Poll ${pollCount}: URL=${currentUrl}, passwordVisible=${passwordStillVisible}, cookieVisible=${cookieStillVisible}, otpInput=${hasOtpInput}, otpSource=${hasSource}`);
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => undefined);
      await page.waitForTimeout(700);
    }

    const failureUrl = page.url();
    const passwordStillVisible = await this.hasVisibleAuthControl(page, passwordSelector).catch(() => false);
    const cookieStillVisible = await this.hasCookieConsentPrompt(page).catch(() => false);

    const errorMessage: string | null = await page.evaluate(() => {
      const errorPatterns = /password errata|password non corretta|email non valida|account bloccato|account sospeso|credenziali non valide|troppe richieste|too many attempts|account locked|invalid credentials|wrong password|incorrect|errore|riprova|non riusciamo|servizio non disponibile|qualcosa è andato storto|sessione scaduta/i;
      const collectText = (container: Document | ShadowRoot | Element): string => {
        const ownText = container instanceof Document
          ? (container.body?.innerText || container.body?.textContent || "")
          : ((container as HTMLElement).innerText || (container as Element).textContent || "");
        let shadowText = "";
        try {
          const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll?.("*") || []);
          shadowText = children
            .map(child => (child as HTMLElement).shadowRoot ? collectText((child as HTMLElement).shadowRoot!) : "")
            .join(" ");
        } catch { /* ignore */ }
        return `${ownText} ${shadowText}`;
      };
      const allText = collectText(document);
      const match = allText.match(errorPatterns);
      if (!match) return null;
      const idx = allText.toLowerCase().indexOf(match[0].toLowerCase());
      return allText.substring(Math.max(0, idx - 80), Math.min(allText.length, idx + 160)).replace(/\s+/g, " ").trim();
    }).catch(() => null);

    const visibleControls: string[] = await page.evaluate(() => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const collect = (container: Document | ShadowRoot | Element): Element[] => {
        const direct = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("button,[role='button'],input,a[href]"));
        const nested = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"))
          .flatMap(child => (child as HTMLElement).shadowRoot ? collect((child as HTMLElement).shadowRoot!) : []);
        return [...direct, ...nested];
      };
      return collect(document)
        .filter(isVisible)
        .map(el => {
          const tag = el.tagName.toLowerCase();
          const type = (el as HTMLInputElement).type || "";
          const label = ((el as HTMLElement).innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "").replace(/\s+/g, " ").trim().slice(0, 50);
          return `${tag}${type ? `[type=${type}]` : ""}${label ? `: "${label}"` : ""}`;
        })
        .slice(0, 15);
    }).catch(() => []);

    let screenshotInfo = "screenshot capture failed";
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
      screenshotInfo = `screenshot captured (${Math.round(buf.length / 1024)}KB) — visible in Live DOM / UI States tab as 'otp-failure-diagnostic'`;
      this.domSnapshots.push({
        url: failureUrl,
        phase: "otp-failure-diagnostic",
        state: "otp-failure-diagnostic",
        a11yTree: null,
        screenshot: `data:image/jpeg;base64,${buf.toString("base64")}`,
      });
    } catch (err) {
      logger.debug(`Failure screenshot capture failed: ${(err as Error).message}`);
    }

    logger.error(`[OTP-WAIT] ============================================================`);
    logger.error(`[OTP-WAIT] OTP detection FAILED after ${pollCount} polls (${timeout}ms).`);
    logger.error(`[OTP-WAIT]   Start URL:    ${startUrl}`);
    logger.error(`[OTP-WAIT]   Failure URL:  ${failureUrl}`);
    logger.error(`[OTP-WAIT]   URL changed:  ${startUrl !== failureUrl ? "YES" : "NO — login likely never submitted or rejected immediately"}`);
    logger.error(`[OTP-WAIT]   Password field still visible: ${passwordStillVisible ? "YES — login form did not advance" : "NO"}`);
    logger.error(`[OTP-WAIT]   Cookie banner still visible:  ${cookieStillVisible ? "YES — banner may have blocked submission" : "NO"}`);
    logger.error(`[OTP-WAIT]   Error message detected:       ${errorMessage || "none"}`);
    logger.error(`[OTP-WAIT]   Visible controls on page:    ${visibleControls.length ? visibleControls.join(" | ") : "none captured"}`);
    logger.error(`[OTP-WAIT]   ${screenshotInfo}`);
    logger.error(`[OTP-WAIT] ============================================================`);

    let diagnosticHint = "";
    if (errorMessage) {
      diagnosticHint = ` — Page shows error: "${errorMessage}"`;
    } else if (passwordStillVisible) {
      diagnosticHint = " — Password field is STILL visible after submit. Either the Accedi click did not fire OR the credentials were rejected silently by the CDN. Check the diagnostic screenshot.";
    } else if (cookieStillVisible) {
      diagnosticHint = " — Cookie banner is still visible and is likely blocking the OTP page from rendering. Check cookie_accept_selector configuration.";
    } else if (startUrl === failureUrl) {
      diagnosticHint = " — URL did not change after Accedi click. Form submission may have failed silently.";
    } else {
      diagnosticHint = ` — URL changed to ${failureUrl} but no OTP input/source was found. Either OTP selectors are outdated for the current Sky page structure, OR this account is not gated by OTP.`;
    }

    throw new Error(`OTP page did not appear after clicking Accedi.${diagnosticHint}`);
  }

  private selectorCandidates(selectorList?: string): string[] {
    return String(selectorList || "")
      .split(/\n|\|/)
      .flatMap(part => part.includes(",") ? [part] : [part])
      .map(s => s.trim())
      .filter(Boolean);
  }

  private authSelector(auth: any, key: string): string {
    if (auth?.[key]) return String(auth[key]).trim();
    if (auth?.workflow_type !== "sky") return "";
    const defaults: Record<string, string> = {
      cookie_accept_selector: "js=document.querySelector('#notice button.accbtn[aria-label=\"Accetta tutto\"]')\n//button[@title='Accetta tutto']\n//*[@id='notice']//button[@aria-label='Accetta tutto' or normalize-space()='Accetta tutto']",
      username_selector: "js=document.querySelector('sky-login-component#sky-login')?.shadowRoot?.querySelector('login-input.sky-login-input')?.shadowRoot?.querySelector('#sky-login-email')\n//input[@id='sky-login-email']\n#sky-login-email",
      password_selector: "js=document.querySelector('sky-login-component#sky-login')?.shadowRoot?.querySelector('login-input.sky-login-input')?.shadowRoot?.querySelector('#sky-login-password')\n//input[@id='sky-login-password']\n#sky-login-password",
      submit_selector: "js=document.querySelector('sky-login-component#sky-login button.sky-login-submit[type=\"submit\"]')\n//button[@class='sky-login-submit']\n//button[contains(@class,'sky-login-submit')]\nbutton.sky-login-submit[type='submit']",
      otp_source_selector: "div.otp-verify-sms-content > p",
      otp_selector: "input.otp-input_otp-input__QvpEl\ninput[aria-label^='Please enter OTP character'], input[name*='otp' i], div[role='textbox'], [contenteditable='true']",
      otp_submit_selector: "js=document.querySelector(\"button.sky-button-primary[aria-label='Conferma']\")\n//button[normalize-space()='Conferma']\n//button[@aria-label='Conferma' and contains(@class,'sky-button-primary')]\nbutton.sky-button-primary[aria-label='Conferma']",
    };
    return String(defaults[key] || "").trim();
  }

  private locatorRoots(page: any): any[] {
    const frames = typeof page.frames === "function" ? page.frames() : [];
    return [page, ...frames.filter((frame: any) => frame !== page.mainFrame?.())];
  }

  private async fillFirst(page: any, selectorList: string | undefined, value: string, timeout = 5000): Promise<void> {
    const deadline = Date.now() + timeout;
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        const locator = root.locator(selector).first();
        if (await locator.isVisible({ timeout: Math.min(1000, timeout) }).catch(() => false)) {
          await locator.fill(value, { timeout }).catch(async () => {
            await locator.click({ timeout: 1000 });
            await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
            await page.keyboard.type(value, { delay: 20 });
          });
          if (await this.verifyFieldValue(page, selector, value)) return;
        }
      }
    }
    while (Date.now() < deadline) {
      for (const root of this.locatorRoots(page)) {
        for (const selector of this.selectorCandidates(selectorList)) {
          const typed = await this.deepFocusAndTypeInRoot(page, root, selector, value).catch(() => false);
          if (typed && await this.verifyFieldValue(page, selector, value)) return;
          const filled = await this.deepFillInRoot(root, selector, value).catch(() => false);
          if (filled) return;
        }
      }
      await page.waitForTimeout(300);
    }
    throw new Error(`No visible input found for selectors: ${selectorList}`);
  }

  private async clickFirst(page: any, selectorList?: string): Promise<void> {
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        const locator = root.locator(selector).first();
        if (await locator.isVisible({ timeout: 3000 }).catch(() => false)) {
          await locator.click({ timeout: 3000 });
          return;
        }
      }
    }
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        const clicked = await this.deepClickInRoot(root, selector).catch(() => false);
        if (clicked) {
          await page.waitForTimeout(300).catch(() => undefined);
          return;
        }
      }
    }
    for (const root of this.locatorRoots(page)) {
      const fallback = root.getByRole?.("button", { name: /^(accedi|continua|continue|sign in|log in|login)$/i }).first();
      if (fallback && await fallback.isVisible({ timeout: 1500 }).catch(() => false)) {
        await fallback.click({ timeout: 3000 });
        return;
      }
    }
    throw new Error(`No visible button found for selectors: ${selectorList}`);
  }

  private async clickByVisibleText(page: any, label: string): Promise<boolean> {
    const escaped = this.escapeRegExp(label);
    const pattern = new RegExp(`^\\s*${escaped}\\s*$`, "i");
    for (const root of this.locatorRoots(page)) {
      const locators = [
        root.getByRole?.("link", { name: pattern }).first(),
        root.getByRole?.("button", { name: pattern }).first(),
        root.getByText?.(pattern).first(),
      ].filter(Boolean);
      for (const locator of locators) {
        try {
          if (await locator.isVisible({ timeout: 1200 }).catch(() => false)) {
            await locator.click({ timeout: 2500, force: true });
            return true;
          }
        } catch { /* try next text locator */ }
      }
      const clicked = await this.deepActivateByTextInRoot(root, label).catch(() => false);
      if (clicked) return true;
    }
    return false;
  }

  private async tryFillFirst(page: any, selectorList: string | undefined, value: string, timeout = 5000): Promise<boolean> {
    if (!selectorList || !String(value ?? "").length) return false;
    try {
      await this.fillFirst(page, selectorList, value, timeout);
      return true;
    } catch {
      return false;
    }
  }

  private async tryClickFirst(page: any, selectorList?: string): Promise<boolean> {
    if (!selectorList) return false;
    try {
      await this.clickFirst(page, selectorList);
      return true;
    } catch {
      return false;
    }
  }

  private async hasVisibleAuthControl(page: any, selectorList?: string): Promise<boolean> {
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        try {
          if (await root.locator(selector).first().isVisible({ timeout: 300 }).catch(() => false)) return true;
        } catch { /* try next selector/root */ }
        try {
          if (await this.deepIsVisibleInRoot(root, selector)) return true;
        } catch { /* try next selector/root */ }
      }
    }
    return false;
  }

  private async verifyFieldValue(page: any, selectorList: string | undefined, expected: string): Promise<boolean> {
    if (!selectorList || !String(expected ?? "").length) return false;
    const expectedValue = String(expected);
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        try {
          const value = await root.locator(selector).first().inputValue({ timeout: 500 }).catch(() => "");
          if (value === expectedValue) return true;
        } catch { /* try deep read */ }
        try {
          const value = await this.deepReadValueInRoot(root, selector);
          if (value === expectedValue) return true;
        } catch { /* try next selector/root */ }
      }
    }
    return false;
  }

  private async deepFillInRoot(root: any, selector: string, value: string): Promise<boolean> {
    return root.evaluate((payload: { selector: string; value: string }) => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const queryDeep = (container: Document | ShadowRoot | Element, selector: string): Element | null => {
        const isJs = selector.startsWith("js=");
        const isXPath = selector.startsWith("/") || selector.startsWith("xpath=");
        if (isJs) {
          try {
            const el = Function(`"use strict"; return (${selector.slice(3)});`)();
            if (el instanceof Element) return el;
          } catch {
            return null;
          }
          return null;
        }
        if (isXPath) {
          const expression = selector.replace(/^xpath=/, "").replace(/^\/\//, ".//");
          try {
            const doc = container instanceof Document ? container : container.ownerDocument!;
            const result = doc.evaluate(expression, container, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue instanceof Element) return result.singleNodeValue;
          } catch {
            return null;
          }
        }
        try {
          const direct = (container as Document | ShadowRoot | Element).querySelector(selector);
          if (direct) return direct;
        } catch {
          if (isXPath) {
            // XPath was already evaluated above.
          } else {
            return null;
          }
        }
        if (!isXPath) {
          const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
          for (const child of children) {
            const shadow = (child as HTMLElement).shadowRoot;
            if (!shadow) continue;
            const found = queryDeep(shadow, selector);
            if (found) return found;
          }
          return null;
        }
        const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
        for (const child of children) {
          const shadow = (child as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = queryDeep(shadow, selector);
          if (found) return found;
        }
        return null;
      };
      const el = queryDeep(document, payload.selector) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el || !isVisible(el)) return false;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, "");
      else el.value = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      if (setter) setter.call(el, payload.value);
      else el.value = payload.value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: payload.value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return el.value === payload.value;
    }, { selector, value });
  }

  private async deepFocusAndTypeInRoot(page: any, root: any, selector: string, value: string): Promise<boolean> {
    const focused = await root.evaluate((selector: string) => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const queryDeep = (container: Document | ShadowRoot | Element, selector: string): Element | null => {
        const isJs = selector.startsWith("js=");
        const isXPath = selector.startsWith("/") || selector.startsWith("xpath=");
        if (isJs) {
          try {
            const el = Function(`"use strict"; return (${selector.slice(3)});`)();
            if (el instanceof Element) return el;
          } catch {
            return null;
          }
          return null;
        }
        if (isXPath) {
          const expression = selector.replace(/^xpath=/, "").replace(/^\/\//, ".//");
          try {
            const doc = container instanceof Document ? container : container.ownerDocument!;
            const result = doc.evaluate(expression, container, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue instanceof Element) return result.singleNodeValue;
          } catch {
            return null;
          }
        }
        if (!isXPath) {
          try {
            const direct = (container as Document | ShadowRoot | Element).querySelector(selector);
            if (direct) return direct;
          } catch {
            return null;
          }
        }
        const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
        for (const child of children) {
          const shadow = (child as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = queryDeep(shadow, selector);
          if (found) return found;
        }
        return null;
      };
      const el = queryDeep(document, selector) as HTMLElement | null;
      if (!el || !isVisible(el)) return false;
      el.focus();
      return document.activeElement === el || (el.getRootNode() as ShadowRoot).activeElement === el;
    }, selector).catch(() => false);
    if (!focused) return false;
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
    await page.keyboard.type(value, { delay: 20 });
    return true;
  }

  private async deepReadValueInRoot(root: any, selector: string): Promise<string> {
    return root.evaluate((selector: string) => {
      const queryDeep = (container: Document | ShadowRoot | Element, selector: string): Element | null => {
        const isJs = selector.startsWith("js=");
        const isXPath = selector.startsWith("/") || selector.startsWith("xpath=");
        if (isJs) {
          try {
            const el = Function(`"use strict"; return (${selector.slice(3)});`)();
            if (el instanceof Element) return el;
          } catch {
            return null;
          }
          return null;
        }
        if (isXPath) {
          const expression = selector.replace(/^xpath=/, "").replace(/^\/\//, ".//");
          try {
            const doc = container instanceof Document ? container : container.ownerDocument!;
            const result = doc.evaluate(expression, container, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue instanceof Element) return result.singleNodeValue;
          } catch {
            return null;
          }
        }
        if (!isXPath) {
          try {
            const direct = (container as Document | ShadowRoot | Element).querySelector(selector);
            if (direct) return direct;
          } catch {
            return null;
          }
        }
        const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
        for (const child of children) {
          const shadow = (child as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = queryDeep(shadow, selector);
          if (found) return found;
        }
        return null;
      };
      const el = queryDeep(document, selector) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
      if (!el) return "";
      return "value" in el ? String((el as HTMLInputElement | HTMLTextAreaElement).value || "") : String(el.textContent || "");
    }, selector);
  }

  private async deepClickInRoot(root: any, selector: string): Promise<boolean> {
    return root.evaluate((selector: string) => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const queryDeep = (container: Document | ShadowRoot | Element, selector: string): Element | null => {
        const isJs = selector.startsWith("js=");
        const isXPath = selector.startsWith("/") || selector.startsWith("xpath=");
        if (isJs) {
          try {
            const el = Function(`"use strict"; return (${selector.slice(3)});`)();
            if (el instanceof Element) return el;
          } catch {
            return null;
          }
          return null;
        }
        if (isXPath) {
          const expression = selector.replace(/^xpath=/, "").replace(/^\/\//, ".//");
          try {
            const doc = container instanceof Document ? container : container.ownerDocument!;
            const result = doc.evaluate(expression, container, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue instanceof Element) return result.singleNodeValue;
          } catch {
            return null;
          }
        }
        try {
          const direct = (container as Document | ShadowRoot | Element).querySelector(selector);
          if (direct) return direct;
        } catch {
          if (isXPath) {
            // XPath was already evaluated above.
          } else {
            return null;
          }
        }
        if (!isXPath) {
          const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
          for (const child of children) {
            const shadow = (child as HTMLElement).shadowRoot;
            if (!shadow) continue;
            const found = queryDeep(shadow, selector);
            if (found) return found;
          }
          return null;
        }
        const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
        for (const child of children) {
          const shadow = (child as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = queryDeep(shadow, selector);
          if (found) return found;
        }
        return null;
      };
      const el = queryDeep(document, selector) as HTMLElement | null;
      if (!el || !isVisible(el)) return false;
      const target = (el.closest("button,[role='button'],input[type='button'],input[type='submit'],a") || el) as HTMLElement;
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      target.click();
      return true;
    }, selector);
  }

  private async deepActivateByTextInRoot(root: any, label: string): Promise<boolean> {
    return root.evaluate((label: string) => {
      const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
      const wanted = normalize(label);
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const collect = (container: Document | ShadowRoot | Element): Element[] => {
        const direct = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("a[href],button,[role='button'],[role='link'],div,span,li"));
        const nested = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"))
          .flatMap(child => (child as HTMLElement).shadowRoot ? collect((child as HTMLElement).shadowRoot!) : []);
        return [...direct, ...nested];
      };
      const match = collect(document).find((el: any) => {
        const text = normalize([el.innerText, el.textContent, el.getAttribute?.("aria-label"), el.getAttribute?.("title")]
          .filter(Boolean).join(" "));
        return isVisible(el) && (text === wanted || text.includes(wanted));
      }) as HTMLElement | undefined;
      if (!match) return false;
      const target = (match.closest("a[href],button,[role='button'],[role='link']") || match) as HTMLElement;
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      target.click();
      return true;
    }, label);
  }

  private async deepIsVisibleInRoot(root: any, selector: string): Promise<boolean> {
    return root.evaluate((selector: string) => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const queryDeep = (container: Document | ShadowRoot | Element, selector: string): Element | null => {
        const isJs = selector.startsWith("js=");
        const isXPath = selector.startsWith("/") || selector.startsWith("xpath=");
        if (isJs) {
          try {
            const el = Function(`"use strict"; return (${selector.slice(3)});`)();
            if (el instanceof Element) return el;
          } catch {
            return null;
          }
          return null;
        }
        if (isXPath) {
          const expression = selector.replace(/^xpath=/, "").replace(/^\/\//, ".//");
          try {
            const doc = container instanceof Document ? container : container.ownerDocument!;
            const result = doc.evaluate(expression, container, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue instanceof Element) return result.singleNodeValue;
          } catch {
            return null;
          }
        }
        try {
          const direct = (container as Document | ShadowRoot | Element).querySelector(selector);
          if (direct) return direct;
        } catch {
          if (isXPath) {
            // XPath was already evaluated above.
          } else {
            return null;
          }
        }
        if (!isXPath) {
          const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
          for (const child of children) {
            const shadow = (child as HTMLElement).shadowRoot;
            if (!shadow) continue;
            const found = queryDeep(shadow, selector);
            if (found) return found;
          }
          return null;
        }
        const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"));
        for (const child of children) {
          const shadow = (child as HTMLElement).shadowRoot;
          if (!shadow) continue;
          const found = queryDeep(shadow, selector);
          if (found) return found;
        }
        return null;
      };
      const el = queryDeep(document, selector);
      return Boolean(el && isVisible(el));
    }, selector);
  }

  private async fillOtpInputs(page: any, selectorList: string | undefined, value: string, timeout = 5000): Promise<void> {
    const digits = String(value || "").replace(/\D/g, "").split("");
    if (!digits.length) throw new Error("OTP value did not contain digits.");

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const root of this.locatorRoots(page)) {
        for (const selector of this.selectorCandidates(selectorList)) {
          try {
            const locator = root.locator(selector);
            const count = await locator.count().catch(() => 0);
            const visibleIndexes: number[] = [];
            for (let i = 0; i < count; i++) {
              if (await locator.nth(i).isVisible({ timeout: 250 }).catch(() => false)) {
                visibleIndexes.push(i);
              }
            }
            if (visibleIndexes.length > 1) {
              for (let i = 0; i < Math.min(visibleIndexes.length, digits.length); i++) {
                const input = locator.nth(visibleIndexes[i]);
                await input.click({ timeout: 1000 }).catch(() => undefined);
                await input.fill(digits[i], { timeout: 1000 }).catch(async () => {
                  await input.type(digits[i], { timeout: 1000, delay: 25 }).catch(async () => {
                    await page.keyboard.type(digits[i], { delay: 25 });
                  });
                });
              }
              return;
            }
            if (visibleIndexes.length === 1) {
              const input = locator.nth(visibleIndexes[0]);
              await input.click({ timeout: 1000 }).catch(() => undefined);
              await input.fill(digits.join(""), { timeout: 1500 }).catch(async () => {
                await input.type(digits.join(""), { timeout: 1500, delay: 25 }).catch(async () => {
                  await page.keyboard.type(digits.join(""), { delay: 25 });
                });
              });
              return;
            }
          } catch { /* try next OTP selector/root */ }
          try {
            const filled = await this.deepFillOtpInRoot(root, selector, digits);
            if (filled) return;
          } catch { /* try next OTP selector/root through shadow DOM */ }
        }
      }
      await page.waitForTimeout(500);
    }

    await this.fillFirst(page, selectorList, digits.join(""), timeout);
  }

  private async deepFillOtpInRoot(root: any, selector: string, digits: string[]): Promise<boolean> {
    return root.evaluate((payload: { selector: string; digits: string[] }) => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const queryAllDeep = (container: Document | ShadowRoot | Element, selector: string): Element[] => {
        let direct: Element[] = [];
        try {
          direct = Array.from((container as Document | ShadowRoot | Element).querySelectorAll(selector));
        } catch {
          direct = [];
        }
        const nested = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"))
          .flatMap(child => (child as HTMLElement).shadowRoot ? queryAllDeep((child as HTMLElement).shadowRoot!, selector) : []);
        return [...direct, ...nested];
      };
      const setElementValue = (el: Element, value: string) => {
        const target = el as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
        target.focus();
        if ("value" in target) {
          const input = target as HTMLInputElement | HTMLTextAreaElement;
          const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(input, value);
          else input.value = value;
        } else {
          target.textContent = value;
        }
        target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
        target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true }));
      };
      const elements = queryAllDeep(document, payload.selector).filter(isVisible);
      if (!elements.length) return false;
      if (elements.length > 1) {
        elements.slice(0, payload.digits.length).forEach((el, index) => setElementValue(el, payload.digits[index]));
      } else {
        setElementValue(elements[0], payload.digits.join(""));
      }
      return true;
    }, { selector, digits });
  }

  private async verifyOtpInputs(page: any, selectorList: string | undefined, value: string): Promise<boolean> {
    const digits = String(value || "").replace(/\D/g, "").split("");
    if (!digits.length) return false;
    for (const root of this.locatorRoots(page)) {
      for (const selector of this.selectorCandidates(selectorList)) {
        try {
          const locator = root.locator(selector);
          const count = await locator.count().catch(() => 0);
          const values: string[] = [];
          for (let i = 0; i < count; i++) {
            if (await locator.nth(i).isVisible({ timeout: 200 }).catch(() => false)) {
              values.push(await locator.nth(i).inputValue({ timeout: 300 }).catch(() => ""));
            }
          }
          if (values.length > 1 && values.slice(0, digits.length).join("") === digits.join("")) return true;
          if (values.length === 1 && values[0] === digits.join("")) return true;
        } catch { /* try deep read */ }
        try {
          const joined = await root.evaluate((selector: string) => {
            const elements = Array.from(document.querySelectorAll(selector)) as Element[];
            return elements.map(el => "value" in el ? String((el as HTMLInputElement).value || "") : String(el.textContent || "")).join("");
          }, selector).catch(() => "");
          if (String(joined || "").replace(/\D/g, "") === digits.join("")) return true;
        } catch { /* try next */ }
      }
    }
    return false;
  }

  private async resolveOtpValue(page: any, auth: any, timeout = 15000): Promise<string> {
    if (auth.otp_code) return String(auth.otp_code).trim();
    const otpSourceSelector = this.authSelector(auth, "otp_source_selector");
    if (!auth.otp_from_page || !otpSourceSelector) return "";
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const root of this.locatorRoots(page)) {
        for (const selector of this.selectorCandidates(otpSourceSelector)) {
          try {
            const source = root.locator(selector).first();
            if (!await source.isVisible({ timeout: 500 }).catch(() => false)) continue;
            const text = await source.innerText({ timeout: 1000 });
            const match = String(text || "").match(/\b(\d{4,8})\b/);
            if (match) return match[1];
          } catch { /* try next selector */ }
        }
      }
      await page.waitForTimeout(500);
    }
    return "";
  }

  private async clearCookieConsent(page: any, explicitSelector?: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const clicked = await this.acceptCookieConsent(page, explicitSelector);
      await page.waitForTimeout(clicked ? 900 : 400);
      const stillVisible = await this.hasCookieConsentPrompt(page);
      if (!stillVisible) return clicked;
    }
    logger.warn("Cookie consent prompt still appears visible after accept attempts.");
    return false;
  }

  private async waitAndClearCookieConsent(page: any, explicitSelector?: string, timeout = 12000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    let clicked = false;
    while (Date.now() < deadline) {
      clicked = await this.clearCookieConsent(page, explicitSelector) || clicked;
      if (clicked) return true;
      await page.waitForTimeout(700);
    }
    return clicked;
  }

  private async clearCookieConsentWithProgress(
    page: any,
    explicitSelector: string | undefined,
    progress: (msg: string) => void,
    context: string
  ): Promise<boolean> {
    const clicked = await this.clearCookieConsent(page, explicitSelector);
    if (clicked) progress(`SUCCESS: Cookies accepted on ${context}`);
    else if (await this.hasCookieConsentPrompt(page)) progress(`WARN: Cookie banner still visible on ${context}`);
    else progress(`SUCCESS: No cookie banner blocking ${context}`);
    return clicked;
  }

  private async hasCookieConsentPrompt(page: any): Promise<boolean> {
    const pattern = /apprezziamo la tua privacy|accetta tutto|accetta tutti|accept all|accept cookies/i;
    for (const root of this.locatorRoots(page)) {
      try {
        const visible = await root.evaluate((patternSource: string) => {
          const pattern = new RegExp(patternSource, "i");
          const collectText = (container: Document | ShadowRoot | Element): string => {
            const ownText = container instanceof Document
              ? (container.body?.innerText || container.body?.textContent || "")
              : ((container as HTMLElement).innerText || (container as Element).textContent || "");
            const children = Array.from((container as Document | ShadowRoot | Element).querySelectorAll?.("*") || []);
            const shadowText = children
              .map(child => (child as HTMLElement).shadowRoot ? collectText((child as HTMLElement).shadowRoot!) : "")
              .join(" ");
            return `${ownText} ${shadowText}`;
          };
          const text = collectText(document);
          if (!pattern.test(text)) return false;
          const collectCandidates = (container: Document | ShadowRoot | Element): Element[] => {
            const direct = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("button,[role='button'],a,input[type='button'],input[type='submit']"));
            const nested = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"))
              .flatMap(child => (child as HTMLElement).shadowRoot ? collectCandidates((child as HTMLElement).shadowRoot!) : []);
            return [...direct, ...nested];
          };
          return collectCandidates(document)
            .some((el: any) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              const label = [el.innerText, el.textContent, el.value, el.getAttribute?.("aria-label"), el.getAttribute?.("title")]
                .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && pattern.test(label);
            });
        }, pattern.source).catch(() => false);
        if (visible) return true;
      } catch { /* inspect next frame */ }
    }
    return false;
  }

  private async acceptCookieConsent(page: any, explicitSelector?: string): Promise<boolean> {
    const selectors = [
      explicitSelector,
      "#onetrust-accept-btn-handler",
      "#onetrust-accept-btn-handler button",
      "[data-testid*='accept' i]",
      "[id*='accept' i]",
      "button#acceptCookie",
      "input[type='button'][value*='Accetta' i]",
      "input[type='submit'][value*='Accetta' i]",
      "input[type='button'][value*='Accept' i]",
      "input[type='submit'][value*='Accept' i]",
      "button[aria-label*='Accept' i]",
      "button[aria-label*='Accetta' i]",
      "button:has-text('Accept all')",
      "button:has-text('Accept All')",
      "button:has-text('Accept cookies')",
      "button:has-text('Accetta tutto')",
      "button:has-text('Accetta tutti')",
      "button:has-text('Accetto')",
      "button:has-text('Accetta')",
      "[role='button']:has-text('Accetta tutto')",
      "[role='button']:has-text('Accetta tutti')",
      "[role='button']:has-text('Accetto')",
      "[role='button']:has-text('Accetta')",
      "a:has-text('Accetta tutto')",
      "a:has-text('Accetta tutti')",
      "a:has-text('Accept all')",
      "button:has-text('I accept')",
      "button:has-text('Agree')",
      "button:has-text('Allow all')",
      "[role='button']:has-text('Accept')",
    ].filter(Boolean) as string[];
    const consentText = /accept all|accept cookies|i accept|agree|allow all|accetta tutto|accetta tutti|accetto|accetta/i;

    for (let attempt = 0; attempt < 3; attempt++) {
      for (const root of this.locatorRoots(page)) {
        for (const selector of selectors) {
          try {
            const locator = root.locator(selector).first();
            if (await locator.isVisible({ timeout: 900 }).catch(() => false)) {
              await locator.click({ timeout: 1500, force: true }).catch(async () => {
                await locator.evaluate((el: HTMLElement) => el.click()).catch(() => undefined);
              });
              await page.waitForTimeout(700);
              return true;
            }
          } catch { /* try next known consent selector */ }
          try {
            const clicked = await this.deepClickInRoot(root, selector);
            if (clicked) {
              await page.waitForTimeout(700);
              return true;
            }
          } catch { /* try next known consent selector through shadow DOM */ }
        }

        try {
          const roleButton = root.getByRole?.("button", { name: consentText }).first();
          if (roleButton && await roleButton.isVisible({ timeout: 900 }).catch(() => false)) {
            await roleButton.click({ timeout: 1500, force: true });
            await page.waitForTimeout(700);
            return true;
          }
        } catch { /* no role-based consent button found */ }

        try {
          const textButton = root.getByText?.(consentText).first();
          if (textButton && await textButton.isVisible({ timeout: 900 }).catch(() => false)) {
            await textButton.click({ timeout: 1500, force: true });
            await page.waitForTimeout(700);
            return true;
          }
        } catch { /* no generic consent text found */ }

        try {
          const clicked = await root.evaluate((patternSource: string) => {
            const pattern = new RegExp(patternSource, "i");
            const collectCandidates = (container: Document | ShadowRoot | Element): Element[] => {
              const direct = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("button,[role='button'],input[type='button'],input[type='submit'],a,div,span"));
              const nested = Array.from((container as Document | ShadowRoot | Element).querySelectorAll("*"))
                .flatMap(child => (child as HTMLElement).shadowRoot ? collectCandidates((child as HTMLElement).shadowRoot!) : []);
              return [...direct, ...nested];
            };
            const candidates = collectCandidates(document);
            const isVisible = (el: Element) => {
              const rect = (el as HTMLElement).getBoundingClientRect();
              const style = window.getComputedStyle(el as HTMLElement);
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
            };
            const match = candidates.find((el: any) => {
              const label = [
                el.innerText,
                el.textContent,
                el.value,
                el.getAttribute?.("aria-label"),
                el.getAttribute?.("title")
              ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
              return isVisible(el) && pattern.test(label);
            }) as HTMLElement | undefined;
            if (!match) return false;
            const clickable = match.closest("button,[role='button'],input[type='button'],input[type='submit'],a") as HTMLElement | null;
            const target = clickable || match;
            target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
            target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
            target.click();
            return true;
          }, consentText.source).catch(() => false);
          if (clicked) {
            await page.waitForTimeout(700);
            return true;
          }
        } catch { /* DOM click fallback failed */ }
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  /** Full accessibility pass for a single loaded page at `targetUrl`. */
  private async runFullPageScan(
    page: any,
    targetUrl: string,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void
  ): Promise<void> {
    const pageKey = this.scanPageKey(targetUrl);
    if (this.scannedPageKeys.has(pageKey)) {
      progress(`Skipping duplicate page scan: ${targetUrl}`);
      return;
    }
    this.scannedPageKeys.add(pageKey);

    if (this.scan.auth_config?.auto_accept_cookies !== false) await this.clearCookieConsent(page, this.authSelector(this.scan.auth_config, "cookie_accept_selector"));
    if (await this.hasCookieConsentPrompt(page)) {
      throw new Error(`Cookie consent prompt is still blocking ${targetUrl}; scan aborted for this page to avoid reporting the login/privacy overlay.`);
    }
    await this.waitForMeaningfulPageContent(page, targetUrl);
    await this.prepareFullPageForScan(page, targetUrl, progress);

    if (opts.run_axe !== false) {
      progress(`Running axe-core WCAG scan on ${targetUrl}`);
      this.allIssues.push(...await runAxe(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_heuristics !== false) {
      progress(`Running heuristic checks on ${targetUrl}`);
      this.allIssues.push(...await runHeuristics(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_focus !== false) {
      progress(`Running focus checks on ${targetUrl}`);
      this.allIssues.push(...await runFocusHeuristics(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_color !== false) {
      progress(`Measuring color contrast on ${targetUrl}`);
      this.allIssues.push(...await runColorChecks(page, targetUrl, this.scan.state_label, "initial"));
    }

    if (opts.run_zoom !== false) {
      progress(`Running zoom and reflow checks on ${targetUrl}`);
      this.allIssues.push(...await runZoomChecks(page, targetUrl, this.scan.state_label, "zoom"));
    }

    if (opts.run_pointer !== false) {
      progress(`Running pointer and gesture checks on ${targetUrl}`);
      this.allIssues.push(...await runPointerChecks(page, targetUrl, this.scan.state_label, "pointer"));
    }

    if (opts.run_keyboard_nav !== false) {
      progress(`Simulating keyboard navigation on ${targetUrl}`);
      this.allIssues.push(...await runKeyboardNav(page, targetUrl, this.scan.state_label));
    }

    if (opts.run_states !== false) {
      progress(`Testing UI states (hover/focus/expanded/error) on ${targetUrl}`);
      const stateResults = await runStateScanning(page, targetUrl, extraStates, async () => {
        if (this.scan.auth_config?.auto_accept_cookies !== false) {
          await this.clearCookieConsent(page, this.authSelector(this.scan.auth_config, "cookie_accept_selector"));
          if (await this.hasCookieConsentPrompt(page)) {
            throw new Error(`Cookie banner is still visible before capturing a state screenshot for ${targetUrl}`);
          }
        }
      });
      for (const sr of stateResults) {
        this.allIssues.push(...this.deduplicateIssues(sr.issues));
        if (sr.screenshot || sr.a11yTree) {
          this.domSnapshots.push({
            url: targetUrl,
            phase: sr.stateName,
            state: sr.stateName,
            a11yTree: sr.a11yTree || null,
            screenshot: sr.screenshot,
          });
        }
      }
    }

    if (opts.run_live_dom !== false) {
      progress(`Capturing accessibility tree for ${targetUrl}`);
      this.domSnapshots.push(await this.captureSnapshot(page, targetUrl, "initial", opts.capture_screenshots !== false));
    }

    const urlIssues = this.allIssues.filter(i => i.url === targetUrl);
    await enrichOwnership(page, urlIssues, { dsPrefix: "" });
    if (opts.capture_screenshots !== false) {
      await this.attachIssueEvidence(page, urlIssues);
    }
  }

  private scanPageKey(targetUrl: string): string {
    try {
      const parsed = new URL(targetUrl);
      const hash = parsed.hash ? `#${decodeURIComponent(parsed.hash.slice(1)).trim().toLowerCase()}` : "";
      parsed.hash = "";
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      return `${host}${path}${parsed.search}${hash}`;
    } catch {
      return targetUrl;
    }
  }

  private async prepareFullPageForScan(page: any, targetUrl: string, progress: (msg: string) => void): Promise<void> {
    try {
      const heightInfo = await page.evaluate(() => ({
        viewportHeight: window.innerHeight || document.documentElement.clientHeight || 800,
        scrollHeight: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0),
      })).catch(() => ({ viewportHeight: 800, scrollHeight: 0 }));

      if (!heightInfo.scrollHeight || heightInfo.scrollHeight <= heightInfo.viewportHeight * 1.25) return;

      progress(`Expanding lazy content by scrolling through full page: ${targetUrl}`);
      const step = Math.max(320, Math.floor(heightInfo.viewportHeight * 0.75));
      for (let y = 0; y < heightInfo.scrollHeight; y += step) {
        await page.evaluate((scrollY: number) => window.scrollTo({ top: scrollY, left: 0, behavior: "instant" as ScrollBehavior }), y).catch(() => undefined);
        await page.waitForTimeout(250).catch(() => undefined);
        if (this.scan.auth_config?.auto_accept_cookies !== false) {
          await this.clearCookieConsent(page, this.authSelector(this.scan.auth_config, "cookie_accept_selector")).catch(() => undefined);
        }
      }
      await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior })).catch(() => undefined);
      await page.waitForTimeout(350).catch(() => undefined);
    } catch (err) {
      logger.debug(`Full-page scroll preparation failed for ${targetUrl}:`, err);
    }
  }

  private async waitForMeaningfulPageContent(page: any, targetUrl: string): Promise<void> {
    const deadline = Date.now() + 30000;
    let lastState: any = null;
    while (Date.now() < deadline) {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
      lastState = await page.evaluate(() => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const visible = (el: Element) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          const style = window.getComputedStyle(el as HTMLElement);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };
        const spinnerCount = Array.from(document.querySelectorAll(
          "[role='progressbar'],[aria-busy='true'],.spinner,.loader,.loading,[class*='spinner' i],[class*='loader' i],[class*='loading' i]"
        )).filter(visible).length;
        const interactiveCount = Array.from(document.querySelectorAll("a[href],button,input,select,textarea,[role='button'],[role='link'],[tabindex]"))
          .filter(visible).length;
        const mainLike = Boolean(document.querySelector("main,[role='main'],h1,h2,nav"));
        return { textLength: text.length, spinnerCount, interactiveCount, mainLike, readyState: document.readyState };
      }).catch(() => null);

      if (lastState && lastState.textLength >= 80 && lastState.interactiveCount >= 1 && (lastState.mainLike || lastState.spinnerCount === 0)) {
        return;
      }
      await page.waitForTimeout(1000);
    }

    throw new Error(`Page did not become scan-ready for ${targetUrl}; last state: ${JSON.stringify(lastState)}`);
  }

  /**
   * Breadth-first crawl from seed URL (same browser session; login should already have run).
   * Stops after `crawl_max_pages` distinct pages per seed.
   */
  private async runCrawlBfsForSeed(
    page: any,
    seedUrl: string,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void
  ): Promise<void> {
    const { maxPages, maxLinkHops } = planCrawlUrls(opts);
    const scannedKeys = new Set<string>();
    const queue: { url: string; depth: number }[] = [{ url: seedUrl, depth: 0 }];

    while (queue.length > 0 && scannedKeys.size < maxPages) {
      const { url, depth } = queue.shift()!;
      const ck = canonicalUrlKey(url);
      if (!ck || scannedKeys.has(ck)) continue;
      if (!passesCrawlFilters(url, seedUrl, opts)) continue;

      progress(`Crawl (${scannedKeys.size + 1}/${maxPages}, depth ${depth}): ${url}`);
      const ok = await this.navigateAndRecord(page, url, `crawl depth ${depth}`);
      if (!ok) {
        logger.warn(`Crawl: skipping unreachable URL: ${url}`);
        continue;
      }
      scannedKeys.add(ck);
      await page.waitForTimeout(1200);
      await this.runFullPageScan(page, url, opts, extraStates, progress);
      await this.scanLinkedPageStates(page, url, opts, extraStates, progress);

      if (depth >= maxLinkHops) continue;

      let baseForLinks = url;
      try {
        baseForLinks = page.url();
      } catch { /* keep url */ }

      const links = await discoverOutboundLinks(page, baseForLinks);
      for (const link of links) {
        const lk = canonicalUrlKey(link);
        if (!lk || scannedKeys.has(lk)) continue;
        if (!passesCrawlFilters(link, seedUrl, opts)) continue;
        queue.push({ url: link, depth: depth + 1 });
      }
    }
  }

  private async scanConfiguredPostLoginPages(
    page: any,
    baseUrl: string,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void,
    scannedKeys: Set<string>,
    authConfig: any
  ): Promise<void> {
    if (opts.post_login_tab_scan === false) return;
    const labels = (Array.isArray(opts.post_login_pages) ? opts.post_login_pages : [
      "Offerte",
      "Profilo",
      "Impostazioni",
      "Fatture",
      "Scopri l'app My Sky"
    ]).map(label => String(label).trim()).filter(Boolean);
    let scannedCount = 0;

    await this.checkConfiguredPostLoginTabKeyboard(page, labels, baseUrl, progress);

    for (const label of labels) {
      const previousUrl = page.url();
      try {
        progress(`Opening authenticated section: ${label}`);
        const clicked = await this.clickByVisibleText(page, label);
        if (!clicked) {
          progress(`WARN: Authenticated section not found: ${label}`);
          logger.warn(`Authenticated section not found by visible text: ${label}`);
          continue;
        }
        await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(1500);
        if (authConfig?.auto_accept_cookies !== false) {
          await this.clearCookieConsentWithProgress(page, this.authSelector(authConfig, "cookie_accept_selector"), progress, label);
        }
        await this.ensureAuthenticatedPage(page, authConfig, label);
        const currentUrl = page.url();
        const pageBaseUrl = currentUrl && currentUrl !== previousUrl
          ? currentUrl
          : `${baseUrl}#${encodeURIComponent(label)}`;
        const scanUrl = pageBaseUrl.includes("#")
          ? pageBaseUrl
          : `${pageBaseUrl}#${encodeURIComponent(label)}`;
        const key = this.scanPageKey(scanUrl);
        if (scannedKeys.has(key)) continue;
        await this.runFullPageScan(page, scanUrl, opts, extraStates, progress);
        progress(`SUCCESS: Completed authenticated section scan: ${label}`);
        scannedKeys.add(key);
        scannedCount++;
      } catch (err) {
        progress(`ERROR: Authenticated section scan failed for ${label}: ${(err as Error)?.message || err}`);
        logger.warn(`Authenticated section scan failed for ${label}:`, err);
      }
    }
    if (labels.length && scannedCount === 0) {
      throw new Error(`None of the configured authenticated sections were scanned: ${labels.join(", ")}`);
    }
  }

  private async checkConfiguredPostLoginTabKeyboard(
    page: any,
    labels: string[],
    baseUrl: string,
    progress: (msg: string) => void
  ): Promise<void> {
    if (!labels.length) return;
    try {
      progress(`Checking keyboard access for selected authenticated sections: ${labels.join(", ")}`);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => undefined);
      const reachedSet = new Set<string>();
      for (let i = 0; i < 90; i += 1) {
        await page.keyboard.press("Tab").catch(() => undefined);
        await page.waitForTimeout(40).catch(() => undefined);
        const reachedNow = await page.evaluate((expectedLabels: string[]) => {
        const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
        const expected = expectedLabels.map(label => ({ label, key: normalize(label) }));
        const found = new Set<string>();
        const textFor = (el: Element | null) => {
          if (!el) return "";
          const target = el as HTMLElement;
          const nearest = target.closest("a,button,[role='tab'],[role='menuitem'],[role='link'],[tabindex]");
          return [
            target.innerText,
            target.textContent,
            target.getAttribute("aria-label"),
            target.getAttribute("title"),
            nearest?.textContent,
            nearest?.getAttribute("aria-label"),
            nearest?.getAttribute("title"),
          ].filter(Boolean).join(" ");
        };

        const focusText = normalize(textFor(document.activeElement));
        for (const item of expected) {
          if (focusText.includes(item.key)) found.add(item.label);
        }
        return Array.from(found);
      }, labels).catch(() => []);
        reachedNow.forEach((label: string) => reachedSet.add(label));
      }
      const reached = Array.from(reachedSet);

      const missing = labels.filter(label => !reached.includes(label));
      if (!missing.length) {
        progress(`SUCCESS: Selected authenticated sections are reachable by keyboard tab navigation`);
        return;
      }
      progress(`WARN: Selected authenticated sections not reached by keyboard tabbing: ${missing.join(", ")}`);
      this.allIssues.push({
        ruleId: "keyboard:configured-nav-tab-reachable",
        severity: "serious",
        priority: 2,
        category: "keyboard",
        message: `Selected authenticated navigation items were not reached with keyboard Tab navigation: ${missing.join(", ")}`,
        url: `${baseUrl}#${encodeURIComponent("Gestisci navigation")}`,
        selector: "nav, aside, [role='navigation']",
        selectors: ["nav, aside, [role='navigation']"],
        wcag: ["wcag2.1.1", "wcag2.4.3", "wcag2.4.7"],
        phase: "keyboard",
        state: "configured-nav",
        affectedCount: missing.length,
        fixSuggestion: "Ensure every selected authenticated navigation item can receive keyboard focus in a logical order and exposes a clear visible focus indicator.",
      });
    } catch (err) {
      progress(`WARN: Could not verify keyboard access for authenticated navigation: ${(err as Error)?.message || err}`);
    }
  }

  private async scanLinkedPageStates(
    page: any,
    seedUrl: string,
    opts: ScanOptions,
    extraStates: StateConfig[],
    progress: (msg: string) => void,
    limit = 8
  ): Promise<void> {
    if (opts.run_states === false) return;

    const candidates = await this.discoverPageStateTargets(page, seedUrl);
    const scanned = new Set<string>([canonicalUrlKey(seedUrl) || seedUrl]);
    for (const target of candidates.slice(0, limit)) {
      try {
        progress(`Scanning linked offerte state: ${target.label}`);
        if (target.href) {
          const key = canonicalUrlKey(target.href) || target.href;
          if (scanned.has(key)) continue;
          const ok = await this.navigateAndRecord(page, target.href, `linked page state ${target.label}`);
          if (!ok) continue;
          scanned.add(key);
          await page.waitForTimeout(1200);
          if (this.scan.auth_config?.auto_accept_cookies !== false) {
            await this.clearCookieConsent(page, this.authSelector(this.scan.auth_config, "cookie_accept_selector"));
          }
          await this.runFullPageScan(page, target.href, opts, extraStates, progress);
          continue;
        }

        const locator = page.locator(target.selector).first();
        if (!await locator.isVisible({ timeout: 1000 }).catch(() => false)) continue;
        await locator.click({ timeout: 2500, force: true });
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(1200);
        if (this.scan.auth_config?.auto_accept_cookies !== false) {
          await this.clearCookieConsent(page, this.authSelector(this.scan.auth_config, "cookie_accept_selector"));
        }
        const currentUrl = page.url();
        const labelUrl = currentUrl === seedUrl ? `${seedUrl}#${encodeURIComponent(target.label)}` : currentUrl;
        await this.runFullPageScan(page, labelUrl, opts, extraStates, progress);
      } catch (err) {
        logger.debug(`Linked page state scan failed for ${target.label}:`, err);
      } finally {
        if (page.url() !== seedUrl) {
          await this.navigateAndRecord(page, seedUrl, "return to seed page").catch(() => undefined);
          await page.waitForTimeout(800).catch(() => undefined);
        }
      }
    }
  }

  private async discoverPageStateTargets(page: any, seedUrl: string): Promise<{ label: string; selector: string; href?: string }[]> {
    const rawTargets = await page.evaluate(() => {
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const selectorFor = (el: Element, index: number) => {
        const id = el.getAttribute("id");
        if (id) return `#${CSS.escape(id)}`;
        const role = el.getAttribute("role");
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        const tag = el.tagName.toLowerCase();
        if (role === "tab") return `[role='tab']:nth-of-type(${index + 1})`;
        if (tag === "button") return `button:nth-of-type(${index + 1})`;
        if (tag === "a") return `a:nth-of-type(${index + 1})`;
        return text ? `${tag}:nth-of-type(${index + 1})` : tag;
      };
      const tabLikeText = /offerte|mobile|internet|tv|calcio|sport|cinema|intrattenimento|fibra|wifi|sky|now|business|casa|extra/i;
      return Array.from(document.querySelectorAll("a[href],[role='tab'],nav a,button[role='tab']"))
        .map((el, index) => {
          const text = (el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
          const role = el.getAttribute("role") || "";
          const href = el.getAttribute("href") || "";
          return { label: text || href || `state ${index + 1}`, role, href, selector: selectorFor(el, index), visible: visible(el), text };
        })
        .filter(item => item.visible && item.label.length > 1 && (item.role === "tab" || tabLikeText.test(item.text) || /offerte|offer|promo|promo/i.test(item.href)))
        .slice(0, 20);
    }).catch(() => []);

    const seen = new Set<string>();
    const targets: { label: string; selector: string; href?: string }[] = [];
    for (const target of rawTargets) {
      const href = target.href ? normalizeHttpUrl(target.href, seedUrl) : null;
      const key = href || target.selector || target.label;
      if (seen.has(key)) continue;
      seen.add(key);
      if (href && !passesCrawlFilters(href, seedUrl, { crawl_same_domain: true, crawl_include_patterns: [], crawl_exclude_patterns: [] })) continue;
      targets.push({ label: target.label.slice(0, 80), selector: target.selector, href: href || undefined });
    }
    return targets;
  }

  private async captureSnapshot(page: any, url: string, phase: string, screenshot = true): Promise<DomSnapshot> {
    let a11yTree: any = null;
    let screenshotData: string | undefined;
    try { a11yTree = await page.accessibility.snapshot({ interestingOnly: false }); } catch {}
    if (screenshot) {
      try {
        const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
        screenshotData = `data:image/jpeg;base64,${buf.toString("base64")}`;
      } catch {}
    }
    return { url, phase, state: this.scan.state_label, a11yTree, screenshot: screenshotData };
  }

  private async attachIssueEvidence(page: any, issues: ScanIssue[]): Promise<void> {
    const candidates = issues
      .filter(issue => !issue.evidenceScreenshot && (issue.selector || issue.selectors?.[0]))
      .slice(0, 80);

    for (const issue of candidates) {
      const selectors = Array.from(new Set([issue.selector, ...(issue.selectors || [])].filter(Boolean))) as string[];
      if (!selectors.length) continue;

      try {
        const captured = await page.evaluate(async (payload: { selectors: string[]; ruleId: string }) => {
          const { selectors, ruleId } = payload;
          let element: HTMLElement | null = null;
          let selectedSelector = "";
          for (const selector of selectors) {
            try {
              const candidate = document.querySelector(selector) as HTMLElement | null;
              if (!candidate) continue;
              const rect = candidate.getBoundingClientRect();
              const style = getComputedStyle(candidate);
              const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
              if (visible) {
                element = candidate;
                selectedSelector = selector;
                break;
              }
              if (!element) {
                element = candidate;
                selectedSelector = selector;
              }
            } catch { /* try the next selector */ }
          }
          if (!element) return { found: false, visible: false };

          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          if (visible) {
            element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
            if (/focus/i.test(ruleId || "") && typeof element.focus === "function") {
              element.focus({ preventScroll: true });
            }
            const previousOutline = element.style.outline;
            const previousBoxShadow = element.style.boxShadow;
            const previousScrollMargin = element.style.scrollMargin;
            element.setAttribute("data-accessibility-evidence", "true");
            element.style.outline = "4px solid #ff4d6d";
            element.style.boxShadow = "0 0 0 6px rgba(255, 77, 109, 0.28)";
            element.style.scrollMargin = "80px";
            (window as any).__accessibilityEvidenceCleanup = () => {
              element!.style.outline = previousOutline;
              element!.style.boxShadow = previousBoxShadow;
              element!.style.scrollMargin = previousScrollMargin;
              element!.removeAttribute("data-accessibility-evidence");
            };
          }
          return { found: true, visible, selector: selectedSelector };
        }, { selectors, ruleId: issue.ruleId });

        if (!captured?.found) continue;
        if (captured.selector) issue.selector = captured.selector;
        await page.waitForTimeout(150);
        const buf = await page.screenshot({ type: "jpeg", quality: 68, fullPage: false });
        issue.evidenceScreenshot = `data:image/jpeg;base64,${buf.toString("base64")}`;
        issue.evidenceExplanation = this.buildEvidenceExplanation(issue, captured.visible);
      } catch (err) {
        logger.debug(`Issue evidence capture failed for ${issue.ruleId}:`, err);
      } finally {
        try {
          await page.evaluate(() => {
            const cleanup = (window as any).__accessibilityEvidenceCleanup;
            if (typeof cleanup === "function") cleanup();
            delete (window as any).__accessibilityEvidenceCleanup;
          });
        } catch {}
      }
    }
  }

  private buildEvidenceExplanation(issue: ScanIssue, highlighted: boolean): string {
    const prefix = highlighted
      ? "The screenshot highlights the first affected element found for this issue. "
      : "This issue points to a non-visible DOM or metadata element, so the screenshot shows the page context without a visible highlight. ";

    if (/focus:invisible/i.test(issue.ruleId)) {
      return `${prefix}The control receives keyboard focus, but the visual focus indicator is missing or too weak. Keyboard users may not know where they are on the page.`;
    }
    if (/focus:obscured/i.test(issue.ruleId)) {
      return `${prefix}The focused control is covered by another layer such as a sticky header, modal overlay, or fixed container. Users may tab to content they cannot see.`;
    }
    if (/text-truncation/i.test(issue.ruleId)) {
      return `${prefix}The text is clipped, ellipsized, or line-clamped. Important visible content may be hidden unless a full accessible name, title, or expansion path is provided.`;
    }
    if (/reflow/i.test(issue.ruleId)) {
      return `${prefix}The region contributes to horizontal overflow or layout breakage in the narrow viewport reflow check. Users at high zoom may need two-dimensional scrolling.`;
    }
    if (/target-size/i.test(issue.ruleId)) {
      return `${prefix}The interactive target is smaller than the minimum recommended touch/click area, which can make activation difficult for users with motor impairments.`;
    }
    if (/contrast|complex-background/i.test(issue.ruleId)) {
      return `${prefix}The area has a visual contrast risk. Verify that text and meaningful graphics remain readable against the actual rendered background.`;
    }
    if (/meta-viewport/i.test(issue.ruleId)) {
      return `${prefix}The viewport rule is controlled by a <meta name="viewport"> tag in the document head. It may not appear visually, but it can block mobile zooming or responsive scaling.`;
    }
    if (/aria|landmark|role/i.test(issue.ruleId)) {
      return `${prefix}This is a semantic accessibility issue. The visual appearance may look correct, but assistive technologies need the affected element to expose the correct role, label, landmark name, or state.`;
    }
    return `${prefix}Use this evidence together with the selector, HTML snippet, issue message, and recommended fix.`;
  }


  private calibrateIssues(issues: ScanIssue[]): ScanIssue[] {
    return issues
      .filter(issue => !this.isLikelyFalsePositive(issue))
      .map(issue => {
        const advisoryRules = /target-size-enhanced|fixed-font-size|text-truncation|complex-background|motion|gesture-no-alternative/i;
        if (advisoryRules.test(issue.ruleId)) {
          return { ...issue, category: "advisory", tags: this.unique([...(issue.tags || []), issue.wcag?.length ? "wcag-mapped" : "best-practice"]) };
        }
        return issue;
      });
  }

  private isLikelyFalsePositive(issue: ScanIssue): boolean {
    const selectorText = [issue.selector, ...(issue.selectors || [])].join(" ").toLowerCase();
    const snippet = String(issue.htmlSnippet || "").toLowerCase();
    if (/skip-link|skiplink/.test(selectorText) && /display:\s*none|hidden/.test(snippet)) return true;
    if (/target-size/i.test(issue.ruleId) && /meta\[|script|style|link\[rel/.test(selectorText)) return true;
    if (/focus:invisible/i.test(issue.ruleId) && /tabindex=['"]?-1/.test(selectorText)) return true;
    if ((issue.affectedCount || 1) <= 0) return true;
    return false;
  }

  private deduplicateIssues(issues: ScanIssue[]): ScanIssue[] {
    const map = new Map<string, ScanIssue>();
    for (const issue of issues) {
      const selectors = [issue.selector, ...(issue.selectors || [])].filter(Boolean) as string[];
      const normalizedSelector = this.normalizeSelector(selectors[0] || "");
      const groupingSelector = this.groupingKeyForIssue(issue, normalizedSelector);
      const key = [
        issue.ruleId,
        issue.url,
        issue.state || "default",
        issue.phase || "initial",
        groupingSelector,      ].join("|");

      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          ...issue,
          selector: selectors[0] || issue.selector,
          selectors: selectors.length ? selectors : issue.selectors,
          depths: issue.depths,
          affectedCount: Math.max(issue.affectedCount || 0, selectors.length || 1),
        });
        continue;
      }

      const mergedSelectors = this.unique([
        ...(existing.selectors || (existing.selector ? [existing.selector] : [])),
        ...selectors,
      ]).slice(0, 100);
      existing.selectors = mergedSelectors;
      existing.selector = existing.selector || mergedSelectors[0];
      existing.depths = this.uniqueNumbers([...(existing.depths || []), ...(issue.depths || [])]).slice(0, 100);
      existing.wcag = this.unique([...(existing.wcag || []), ...(issue.wcag || [])]);
      existing.act = this.unique([...(existing.act || []), ...(issue.act || [])]);
      existing.tags = this.unique([...(existing.tags || []), ...(issue.tags || [])]);
      existing.affectedCount = Math.max(existing.affectedCount || 1, mergedSelectors.length, issue.affectedCount || 1);
      existing.evidenceScreenshot = existing.evidenceScreenshot || issue.evidenceScreenshot;
      existing.evidenceExplanation = existing.evidenceExplanation || issue.evidenceExplanation;
    }
    return [...map.values()].map(issue => {
      if ((issue.affectedCount || 1) > 1 && !/affected elements/i.test(issue.message)) {
        return { ...issue, message: `${issue.message} (${issue.affectedCount} affected elements grouped)` };
      }
      return issue;
    });
  }

  private prioritizeIssues(issues: ScanIssue[]): ScanIssue[] {
    return issues
      .map(issue => ({ ...issue, priority: this.computeFixPriority(issue) }))
      .sort((a, b) =>
        (a.priority || 5) - (b.priority || 5) ||
        this.severityRank(a.severity) - this.severityRank(b.severity) ||
        (b.affectedCount || 1) - (a.affectedCount || 1)
      );
  }

  private generateTestCases(): void {
    const seen = new Set<string>();
    for (const issue of this.allIssues) {
      const key = `${issue.ruleId}|${issue.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.testCases.push({
        name: `[${issue.severity?.toUpperCase()}] ${issue.ruleId}: ${issue.message.slice(0, 70)}`,
        description: `Verify ${issue.ruleId} is resolved on ${issue.url}`,
        category: issue.category || "wcag",
        wcagRef: (issue.wcag || [])[0] || "",
        status: "fail",
        issueRuleId: issue.ruleId,
        issueUrl: issue.url,
        steps: [],
        result: `FAIL — ${issue.message}`,
      });
    }
  }

  private generateManualHybridReviewCases(): void {
    const seedUrls: string[] = this.scan.urls || [];
    const urls = [...new Set([...seedUrls, ...this.allIssues.map(i => i.url).filter(Boolean)])];
    if (!urls.length) return;

    const allIssueText = this.allIssues.map(i => `${i.category || ""} ${i.message} ${i.selector || ""} ${i.state || ""} ${i.phase || ""}`).join(" ");
    const categories = new Set(this.allIssues.map(i => i.category).filter(Boolean));
    const hasKeyboardRisk = categories.has("keyboard") || categories.has("focus");
    const hasFormRisk = /label|error|input|form/i.test(allIssueText);
    const hasDynamicRisk = /expanded|hover|focus|error|tab-active|interaction|modal|menu|accordion|tab/i.test(allIssueText);
    const hasMediaRisk = /video|audio|caption|transcript|media/i.test(allIssueText);
    const pageList = urls.map(url => `- ${url}`).join("\n");
    const pagesSummary = `${urls.length} scanned page${urls.length === 1 ? "" : "s"}`;

    const reviews: TestCase[] = [
        {
          name: `Screen reader reading order and announcements`,
          description: `Manual review still required for screen reader experience across ${pagesSummary}:\n${pageList}`,
          category: "manual-review",
          wcagRef: "WCAG 1.3.2 / 4.1.2",
          status: "pending",
          steps: [
            "Open each scanned page listed in this test case with NVDA, JAWS, or VoiceOver.",
            "Navigate by headings, landmarks, links, buttons, and form controls.",
            "Confirm the announced names, roles, states, and reading order match the visual interface.",
            "Verify dynamic updates are announced without forcing users to rediscover the page."
          ],
          result: "Manual review required - automated DOM and axe checks cannot fully validate real assistive technology behavior."
        },
        {
          name: `Content meaning, labels, and instructions`,
          description: `Human judgment required for labels, instructions, link purpose, alt text quality, and content clarity across ${pagesSummary}:\n${pageList}`,
          category: "manual-review",
          wcagRef: "WCAG 1.1.1 / 2.4.4 / 3.3.2",
          status: "pending",
          steps: [
            "Review link text, button names, headings, instructions, and image alternatives in context.",
            "Confirm names are not only present but meaningful for the task.",
            "Check that errors, help text, prices, product details, and legal or transactional content are understandable."
          ],
          result: "Manual review required - automation can detect missing attributes, not whether the language is correct or useful."
        },
        {
          name: `Keyboard-only task flow`,
          description: `Hybrid keyboard validation for realistic user tasks across ${pagesSummary}:\n${pageList}`,
          category: "hybrid-review",
          wcagRef: "WCAG 2.1.1 / 2.4.3 / 2.1.2",
          status: "pending",
          steps: [
            "Use only keyboard to complete the main page task from start to finish.",
            "Verify Tab, Shift+Tab, Enter, Space, Escape, and arrow-key behavior where applicable.",
            "Confirm focus order is logical, visible, and does not skip or trap important controls.",
            hasKeyboardRisk
              ? "Pay special attention to keyboard/focus issues already flagged by the automated scan."
              : "Confirm no task-critical keyboard issue exists beyond the sampled automated checks."
          ],
          result: "Hybrid review required - automated keyboard simulation is sampled and cannot prove every business flow."
        },
        {
          name: `Dynamic interaction state coverage`,
          description: `Hybrid review for menus, modals, filters, accordions, tabs, validation, and route changes across ${pagesSummary}:\n${pageList}`,
          category: "hybrid-review",
          wcagRef: "WCAG 4.1.2 / 2.4.3 / 3.3.1",
          status: "pending",
          steps: [
            "Open all task-critical menus, dialogs, popovers, filters, accordions, tabs, carts, and validation states.",
            "Confirm focus moves correctly into and out of overlays.",
            "Verify expanded/collapsed state, selected state, error state, and disabled state are exposed to assistive tech.",
            hasDynamicRisk
              ? "Review the states where the automated scan already found issues first."
              : "Use this as a coverage pass because the automated scan samples representative states, not a full state graph."
          ],
          result: "Hybrid review required - this version samples states but does not exhaustively build a full UI state graph."
        },
        {
          name: `Responsive zoom and touch usability`,
          description: `Manual review for mobile, 200-400% zoom, touch target usability, and orientation behavior across ${pagesSummary}:\n${pageList}`,
          category: "manual-review",
          wcagRef: "WCAG 1.4.10 / 1.4.4 / 2.5.8",
          status: "pending",
          steps: [
            "Test at 200% and 400% browser zoom and common mobile viewport sizes.",
            "Check that content is not hidden, overlapping, or requiring two-dimensional scrolling except where allowed.",
            "Use touch or device emulation to verify target spacing and gesture alternatives.",
            "Confirm sticky headers, cookie banners, chat widgets, and overlays do not obscure content."
          ],
          result: "Manual review required - automated reflow/target checks need visual and device confirmation."
        }
      ];

      if (hasFormRisk) {
        reviews.push({
          name: `Form completion and error recovery`,
          description: `Hybrid form validation review across ${pagesSummary}:\n${pageList}`,
          category: "hybrid-review",
          wcagRef: "WCAG 3.3.1 / 3.3.2 / 3.3.3",
          status: "pending",
          steps: [
            "Submit forms with empty, invalid, and corrected values.",
            "Confirm errors are visible, announced, associated with fields, and easy to recover from.",
            "Verify required fields, formatting rules, autocomplete, and success messages are clear."
          ],
          result: "Hybrid review required - automated checks can trigger some errors but cannot validate the full recovery experience."
        });
      }

      if (hasMediaRisk) {
        reviews.push({
          name: `Media alternatives and player accessibility`,
          description: `Manual captions, transcript, audio description, and player control review across ${pagesSummary}:\n${pageList}`,
          category: "manual-review",
          wcagRef: "WCAG 1.2.x",
          status: "pending",
          steps: [
            "Verify captions, transcripts, and audio descriptions for all meaningful media.",
            "Confirm media controls are keyboard accessible and screen-reader announced.",
            "Check autoplay, pause, stop, volume, and motion behavior."
          ],
          result: "Manual review required - media quality and synchronization cannot be reliably proven by the scanner."
        });
      }

      this.testCases.push(...reviews);
  }

  private computeScore(issues: ScanIssue[]): number {
    if (!issues.length) return 100;
    const weights: Record<string, number> = { critical: 14, serious: 8, moderate: 3.5, minor: 1 };
    const urls = new Set(issues.map(i => i.url)).size || 1;
    const impact = issues.reduce((acc, issue) => {
      const affected = Math.max(issue.affectedCount || issue.selectors?.length || 1, 1);
      const scale = 1 + Math.min(Math.log2(affected), 6) * 0.18;
      return acc + (weights[issue.severity] || 1) * scale;
    }, 0);

    const capacity = 95 * Math.sqrt(urls);
    const score = 100 / (1 + impact / capacity);
    const rounded = Math.round(score);
    return Math.max(1, Math.min(100, rounded));
  }

  private computeFixPriority(issue: ScanIssue): number {
    let priority = ({ critical: 1, serious: 2, moderate: 3, minor: 4 } as Record<string, number>)[issue.severity] || 4;
    const highImpactCategories = new Set(["keyboard", "focus", "forms", "aria", "structure"]);
    if (highImpactCategories.has(issue.category || "")) priority -= 1;
    if ((issue.affectedCount || issue.selectors?.length || 1) >= 10) priority -= 1;
    if (issue.severity === "minor" && (issue.affectedCount || 1) <= 1) priority += 1;
    return Math.max(1, Math.min(5, priority));
  }

  private severityRank(severity: string): number {
    return ({ critical: 1, serious: 2, moderate: 3, minor: 4 } as Record<string, number>)[severity] || 5;
  }



  private groupingKeyForIssue(issue: ScanIssue, normalizedSelector: string): string {
    if (/target-size|contrast|focus:invisible|label|aria|landmark|heading|reflow|keyboard/i.test(issue.ruleId)) {
      return issue.componentId || issue.sourceHint || this.selectorFamily(normalizedSelector) || "page";
    }
    return issue.componentId || issue.sourceHint || this.selectorFamily(normalizedSelector);
  }

  private normalizeSelector(selector: string): string {
    return selector
      .toLowerCase()
      .replace(/:nth-(?:of-type|child)\(\d+\)/g, ":nth")
      .replace(/#[a-z0-9_-]*\d+[a-z0-9_-]*/g, "#id")
      .replace(/\[[^\]]*(?:id|data-[^\]=]+)=["'][^"']+["'][^\]]*\]/g, "[attr]")
      .replace(/\s+/g, " ")
      .trim();
  }

  private selectorFamily(selector: string): string {
    if (!selector) return "page";
    return selector
      .split(/\s*>\s*|\s+/)
      .slice(0, 3)
      .join(" ");
  }

  private normalizeMessage(message: string): string {
    return message
      .toLowerCase()
      .replace(/\d+/g, "#")
      .replace(/\([^)]*affected elements grouped\)/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
  }

  private uniqueNumbers(values: number[]): number[] {
    return [...new Set(values.filter(v => Number.isFinite(v)))];
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

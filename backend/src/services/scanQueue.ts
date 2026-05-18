import Queue, { Job } from "bull";
import { db } from "../utils/db";
import { logger } from "../utils/logger";
import { wsManager } from "../utils/wsManager";
import { AccessibilityScanner } from "../scanner/scanner";

interface QueueItem {
  scanId: string;
  addedAt: number;
}

class ScanQueue {
  private queue: QueueItem[] = [];
  private running = false;
  private maxConcurrent = Number(process.env.SCAN_QUEUE_CONCURRENCY || 2);
  private activeScans = 0;
  private bullQueue?: Queue.Queue<QueueItem>;

  init() {
    const useRedisQueue = process.env.SCAN_QUEUE_DRIVER !== "memory" && Boolean(process.env.REDIS_URL);

    if (useRedisQueue) {
      this.bullQueue = new Queue<QueueItem>("accessibility-scans", process.env.REDIS_URL!, {
        defaultJobOptions: {
          attempts: Number(process.env.SCAN_QUEUE_ATTEMPTS || 2),
          backoff: {
            type: "exponential",
            delay: Number(process.env.SCAN_QUEUE_BACKOFF_MS || 10000)
          },
          removeOnComplete: Number(process.env.SCAN_QUEUE_REMOVE_COMPLETE || 100),
          removeOnFail: Number(process.env.SCAN_QUEUE_REMOVE_FAILED || 250)
        }
      });

      this.bullQueue.process(this.maxConcurrent, async (job: Job<QueueItem>) => {
        await this.runScan(job.data.scanId);
      });

      this.bullQueue.on("failed", (job, err) => {
        logger.error(`Scan queue job ${job?.id} failed:`, err);
      });

      this.bullQueue.on("error", (err) => {
        logger.error("Redis scan queue error:", err);
      });

      logger.info(`Redis scan queue processor started with concurrency ${this.maxConcurrent}`);
      return;
    }

    setInterval(() => this.processQueue(), 2000);
    logger.info(`In-memory scan queue processor started with concurrency ${this.maxConcurrent}`);
  }

  async add(scanId: string): Promise<void> {
    if (this.bullQueue) {
      await this.bullQueue.add({ scanId, addedAt: Date.now() }, { jobId: scanId });
      logger.info(`Scan ${scanId} added to Redis queue`);
      return;
    }

    this.queue.push({ scanId, addedAt: Date.now() });
    logger.info(`Scan ${scanId} added to queue`);
    this.processQueue();
  }

  private async processQueue() {
    while (this.activeScans < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.activeScans++;
      this.runScan(item.scanId).finally(() => {
        this.activeScans--;
        this.processQueue();
      });
    }
  }

  private async runScan(scanId: string): Promise<void> {
    logger.info(`Starting scan ${scanId}`);

    try {
      await db.query(
        "UPDATE scans SET status = 'running', started_at = NOW(), progress = 0 WHERE id = $1",
        [scanId]
      );

      wsManager.broadcast(scanId, { type: "scan:started", scanId });

      const scanResult = await db.query("SELECT * FROM scans WHERE id = $1", [scanId]);
      const scan = scanResult.rows[0];
      if (!scan) throw new Error("Scan not found");

      const scanner = new AccessibilityScanner(scan, (progress, message) => {
        db.query("UPDATE scans SET progress = $1 WHERE id = $2", [progress, scanId]);
        wsManager.broadcast(scanId, { type: "scan:progress", scanId, progress, message });
      });

      const { issues, testCases, domSnapshots, score } = await scanner.run();
      const issueIdsByRuleUrl = new Map<string, string>();
      const issueLinkKey = (ruleId: string, url: string) => `${ruleId}|${url}`;

      // Persist issues
      for (const issue of issues) {
        const insertedIssue = await db.query(
          `INSERT INTO issues (scan_id, rule_id, severity, priority, category, message, url,
            selector, selectors, depths, wcag_criteria, act_rules, tags, help_url, html_snippet,
            fix_suggestion, evidence_screenshot, evidence_explanation, component_id, component_owner, source_hint, state_label, phase)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
          [
            scanId, issue.ruleId, issue.severity, issue.priority || 3,
            issue.category || "wcag", issue.message, issue.url,
            issue.selector || null,
            issue.selectors?.length ? issue.selectors : null,
            issue.depths?.length ? issue.depths : null,
            issue.wcag?.length ? issue.wcag : null,
            issue.act?.length ? issue.act : null,
            issue.tags?.length ? issue.tags : null,
            issue.helpUrl || null,
            issue.htmlSnippet || null,
            issue.fixSuggestion || null,
            issue.evidenceScreenshot || null,
            issue.evidenceExplanation || null,
            issue.componentId || null,
            issue.componentOwner || null,
            issue.sourceHint || null,
            issue.state || "default",
            issue.phase || "initial"
          ]
        );
              const linkKey = issueLinkKey(issue.ruleId, issue.url);
        if (!issueIdsByRuleUrl.has(linkKey) && insertedIssue.rows[0]?.id) {
          issueIdsByRuleUrl.set(linkKey, insertedIssue.rows[0].id);
        }
      }

      // Persist test cases
      for (const tc of testCases) {
        const linkedIssueId = tc.issueId || (tc.issueRuleId && tc.issueUrl ? issueIdsByRuleUrl.get(issueLinkKey(tc.issueRuleId, tc.issueUrl)) : null);
        await db.query(
          `INSERT INTO test_cases (scan_id, issue_id, name, description, category, wcag_ref, status, steps, result)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [scanId, linkedIssueId || null, tc.name, tc.description, tc.category, tc.wcagRef, tc.status, JSON.stringify(tc.steps || []), tc.result]
        );
      }

      // Persist DOM snapshots
      for (const snap of domSnapshots) {
        await db.query(
          "INSERT INTO dom_snapshots (scan_id, url, phase, a11y_tree, screenshot) VALUES ($1,$2,$3,$4,$5)",
          [scanId, snap.url, snap.phase, JSON.stringify(snap.a11yTree), snap.screenshot]
        );
      }

      // Counts
      const counts = issues.reduce((acc: any, i) => {
        acc[i.severity] = (acc[i.severity] || 0) + 1;
        return acc;
      }, {});

      await db.query(
        `UPDATE scans SET status = 'completed', completed_at = NOW(), progress = 100,
          total_issues = $2, critical_count = $3, serious_count = $4,
          moderate_count = $5, minor_count = $6, score = $7
         WHERE id = $1`,
        [scanId, issues.length,
          counts.critical || 0, counts.serious || 0,
          counts.moderate || 0, counts.minor || 0,
          score
        ]
      );

      wsManager.broadcast(scanId, { type: "scan:completed", scanId, totalIssues: issues.length, score, message: `SUCCESS: Scan completed with ${issues.length} issues and score ${score}` });
      logger.info(`Scan ${scanId} completed with ${issues.length} issues`);

    } catch (err: any) {
      logger.error(`Scan ${scanId} failed:`, err);
      await db.query(
        "UPDATE scans SET status = 'failed', completed_at = NOW(), error_message = $2 WHERE id = $1",
        [scanId, err.message]
      );
      wsManager.broadcast(scanId, { type: "scan:failed", scanId, error: err.message });
    }
  }
}

export const scanQueue = new ScanQueue();

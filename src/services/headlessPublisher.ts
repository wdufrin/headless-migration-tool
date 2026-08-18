import puppeteer, { Browser } from "puppeteer-core";
import { logger } from "../utils/logger.js";

export interface HeadlessPublishOptions {
  executablePath?: string;
  configId?: string;
  apiKey?: string;
  agentIds?: string[];
  headless?: boolean;
}

export class HeadlessPublisher {
  private executablePath: string;
  private configId: string;
  private apiKey: string;

  constructor(options: HeadlessPublishOptions = {}) {
    this.executablePath = options.executablePath || process.env.CHROME_BIN || "/usr/bin/google-chrome";
    this.configId = options.configId || "85240219-d6ee-415c-9242-d270267fa247";
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || "";
  }

  /**
   * Automatically deploys a list of migrated agent IDs through the Gemini Enterprise WidgetService.
   */
  async deployAgents(agentIds: string[]): Promise<{ success: number; failed: number }> {
    if (!agentIds || agentIds.length === 0) {
      return { success: 0, failed: 0 };
    }

    logger.info(`[HeadlessPublisher] Starting automated deployment for ${agentIds.length} agents via headless worker...`);

    let browser: Browser | null = null;
    let success = 0;
    let failed = 0;

    try {
      browser = await puppeteer.launch({
        executablePath: this.executablePath,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });

      const page = await browser.newPage();
      await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36");

      await page.goto("https://vertexaisearch.cloud.google.com/", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      }).catch(() => {});

      for (const agentId of agentIds) {
        try {
          const result = await page.evaluate(
            async (id: string, cid: string, key: string) => {
              const url = `https://discoveryengine.clients6.google.com/v1alpha/locations/global/widgetDeployLowCodeAgent?key=${key}`;
              const payload = {
                configId: cid,
                additionalParams: { token: "-", origin: "LOW_CODE_AGENT" },
                deployLowCodeAgentRequest: { name: id, deployMode: "DEPLOY" },
                location: "global",
              };

              const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });

              return { ok: res.ok, status: res.status, text: res.ok ? "" : await res.text() };
            },
            agentId,
            this.configId,
            this.apiKey
          );

          if (result.ok) {
            success++;
            logger.info(`[HeadlessPublisher] ✅ Deployed agent: ${agentId}`);
          } else {
            failed++;
            logger.warn(`[HeadlessPublisher] ⚠️ Deploy notice for ${agentId}: ${result.status} ${result.text}`);
          }
        } catch (e: any) {
          failed++;
          logger.warn(`[HeadlessPublisher] ⚠️ Failed to deploy agent ${agentId}: ${e.message}`);
        }
      }
    } catch (err: any) {
      logger.error(`[HeadlessPublisher] Error during headless worker deployment: ${err.message}`);
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }

    logger.info(`[HeadlessPublisher] Deployment completed. Success: ${success}, Failed: ${failed}`);
    return { success, failed };
  }
}

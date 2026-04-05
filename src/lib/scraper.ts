import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type HTTPResponse, type Page } from "puppeteer";
import type {
  ProgressEvent,
  ScrapeError,
  SearchResult,
  StoryblocksCookie,
  VideoInfo,
} from "./types";
import { classifyDownloadError, computeBackoffMs, type DownloadErrorClass } from "./download-queue";

const STORYBLOCKS_ORIGIN = "https://www.storyblocks.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const OPERATION_DELAY_MS = 500;
const DEFAULT_CAPTURE_TIMEOUT_MS = 15000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 25000;
const HARD_DOWNLOAD_TIMEOUT_MS = 60000;
const DOWNLOAD_POLL_MS = 250;
const SCRAPE_CONCURRENCY = 6;
const SCRAPE_MAX_ATTEMPTS = 3;
const SCRAPE_RETRY_BASE_MS = 2000;
const SCRAPE_RETRY_MAX_MS = 12000;
const SCRAPE_CHALLENGE_COOLDOWN_MS = 8000;
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const DOWNLOAD_CACHE_ROOT = path.join(os.tmpdir(), "automatic-cosmos-storyblocks");
const SCRAPER_BROWSER_ARGS = ["--no-sandbox", "--disable-setuid-sandbox"];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runStepWithRetry<T>(
  stepName: string,
  operation: () => Promise<T>,
  attempts = 2,
  baseDelayMs = 700
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const jitter = Math.floor(Math.random() * 300);
        await delay(baseDelayMs * attempt + jitter);
      }
    }
  }
  throw new Error(`${stepName} failed after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export function launchScraperBrowser() {
  return puppeteer.launch({
    headless: true,
    args: SCRAPER_BROWSER_ARGS,
  });
}

export async function verifyLogin(
  browser: Browser,
  cookies: StoryblocksCookie[]
): Promise<{ loggedIn: boolean; error?: string }> {
  const page = await browser.newPage();
  try {
    await configurePage(page, cookies);
    await page.goto(STORYBLOCKS_ORIGIN, { waitUntil: "domcontentloaded", timeout: 15000 });
    await delay(300);
    const state = await inspectAccountState(page, 5000);
    if (state.challengeLikely) {
      return { loggedIn: false, error: `Challenge/rate-limit: ${state.challengeSignals.join(", ")}` };
    }
    if (state.explicitLoggedOut) {
      return { loggedIn: false, error: "Not logged in — cookies may be expired or invalid" };
    }
    // If not explicitly logged out and no challenge, assume cookies are valid.
    // Detail page downloads will catch real auth issues.
    return { loggedIn: true };
  } catch (err) {
    return { loggedIn: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await page.close().catch(() => {});
  }
}

function normalizeStoryblocksUrl(url: string) {
  return url.startsWith("http") ? url : `${STORYBLOCKS_ORIGIN}${url}`;
}

function sanitizeFilename(filename: string) {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim() || "video.mp4";
}

function isPreviewUrl(url: string) {
  const lower = url.toLowerCase();
  return (
    lower.includes("/watermarks/") ||
    lower.includes("preview") ||
    /__p\d+\.mp4(\?|$)/i.test(lower)
  );
}

function isLikelyMediaDownloadUrl(url: string) {
  if (!url.startsWith("http") || isPreviewUrl(url)) return false;

  const lower = url.toLowerCase();
  return (
    lower.includes("/content/video/") ||
    lower.includes("/video/download") ||
    lower.includes("/download/video") ||
    lower.includes("/api/download") ||
    lower.includes("response-content-disposition=attachment") ||
    /\.(mp4|mov|m4v)(\?|$)/i.test(lower)
  );
}

function isBlockedTrackingUrl(url: string) {
  if (!url.startsWith("http")) return true;
  const lower = url.toLowerCase();
  return (
    lower.includes("googleads.g.doubleclick.net") ||
    lower.includes("doubleclick.net") ||
    lower.includes("googlesyndication.com") ||
    lower.includes("google-analytics.com") ||
    lower.includes("/pagead/") ||
    lower.includes("intercom.io") ||
    lower.includes("zoominfo.com") ||
    lower.includes("hubspot.com") ||
    lower.includes("analytics.google.com")
  );
}

function isTrustedMediaCandidate(url: string) {
  if (!url.startsWith("http")) return false;
  if (isPreviewUrl(url)) return false;
  if (isBlockedTrackingUrl(url)) return false;
  return isLikelyMediaDownloadUrl(url);
}

function extractCandidateUrls(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];

  if (typeof value === "string") {
    return isLikelyMediaDownloadUrl(value) ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractCandidateUrls(item, depth + 1));
  }

  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      extractCandidateUrls(item, depth + 1)
    );
  }

  return [];
}

async function detectChallengeSignals(page: Page) {
  return page
    .evaluate(() => {
      const pageText = (document.body?.innerText || "").toLowerCase();
      const signals = [
        "too many requests",
        "verify you are human",
        "captcha",
        "unusual traffic",
        "temporarily blocked",
        "access denied",
        "rate limit",
      ];
      return signals.filter((signal) => pageText.includes(signal));
    })
    .catch(() => [] as string[]);
}

function toPuppeteerCookies(cookies: StoryblocksCookie[]) {
  return cookies
    .filter((c) => c.name && c.value)
    .map((c) => {
      const sameSiteMap: Record<string, "Strict" | "Lax" | "None"> = {
        strict: "Strict",
        lax: "Lax",
        no_restriction: "None",
      };
      return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
        sameSite: sameSiteMap[c.sameSite || ""] || ("Lax" as const),
        expires: c.expirationDate || -1,
      };
    });
}

async function configurePage(page: Page, cookies: StoryblocksCookie[]) {
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent(USER_AGENT);
  await page.setCookie(...toPuppeteerCookies(cookies));
}

async function inspectAccountState(page: Page, timeoutMs = 12000) {
  await page
    .waitForFunction(() => {
      const textOf = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const getRank = (value: string) => {
        const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (normalized.includes("4k")) return -1;
        if (normalized.includes("hdmp4") || normalized.includes("mp4hd")) return 2;
        if (normalized.includes("hdmov") || normalized.includes("movhd")) return 1;
        return 0;
      };
      const clickables = Array.from(document.querySelectorAll("a, button, [role='button'], summary"));
      const labels = Array.from(document.querySelectorAll("label, [role='radio']"));
      const pageText = (document.body?.innerText || "").toLowerCase();
      const hasChallenge =
        pageText.includes("too many requests") ||
        pageText.includes("verify you are human") ||
        pageText.includes("captcha") ||
        pageText.includes("unusual traffic") ||
        pageText.includes("temporarily blocked");

      const hasMyAccount = clickables.some((el) => textOf(el).includes("my account"));
      const hasDownloadButton = clickables.some((el) => textOf(el).includes("download"));
      const hasHdMp4 = labels.some((el) => {
        return getRank(textOf(el)) > 0;
      });

      return hasMyAccount || hasHdMp4 || hasDownloadButton || hasChallenge;
    }, { timeout: timeoutMs })
    .catch(() => {});

  return page.evaluate(() => {
    const textOf = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    const getRank = (value: string) => {
      const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalized.includes("4k")) return -1;
      if (normalized.includes("hdmp4") || normalized.includes("mp4hd")) return 2;
      if (normalized.includes("hdmov") || normalized.includes("movhd")) return 1;
      return 0;
    };
    const clickables = Array.from(document.querySelectorAll("a, button, [role='button'], summary"));
    const labels = Array.from(document.querySelectorAll("label, [role='radio']"));
    const pageUrl = window.location.href.toLowerCase();
    const pageText = (document.body?.innerText || "").toLowerCase();

    const hasMyAccount = clickables.some((el) => textOf(el).includes("my account"));
    const hasSignIn = clickables.some((el) => {
      const text = textOf(el);
      return (
        text === "sign in" ||
        text === "log in" ||
        text.includes("login") ||
        text.includes("sign in") ||
        text.includes("log in")
      );
    });
    const hasHdMp4 = labels.some((el) => {
      return getRank(textOf(el)) > 0;
    });
    const hasDownloadButton = clickables.some((el) => textOf(el).includes("download"));
    const challengeSignals = [
      "too many requests",
      "verify you are human",
      "captcha",
      "unusual traffic",
      "temporarily blocked",
      "access denied",
      "rate limit",
    ].filter((signal) => pageText.includes(signal));
    const challengeLikely = challengeSignals.length > 0;
    const explicitLoggedOut =
      pageUrl.includes("/login") ||
      pageUrl.includes("/sign-in") ||
      pageUrl.includes("/signin") ||
      (hasSignIn && !hasMyAccount && !hasHdMp4 && !hasDownloadButton);
    const loggedInLikely = hasMyAccount || hasHdMp4 || (hasDownloadButton && !hasSignIn);

    return {
      pageUrl,
      hasMyAccount,
      hasSignIn,
      hasDownloadButton,
      hasHdMp4,
      explicitLoggedOut,
      loggedInLikely,
      challengeLikely,
      challengeSignals,
      loggedIn: loggedInLikely && !explicitLoggedOut,
    };
  });
}

async function waitForPreferredFormatUi(page: Page, timeoutMs: number) {
  return page
    .waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll(".formatSelector-row, [id='HDMP4'], [id='HDMOV'], [id='4KMP4']"));
      return rows.some((row) => {
        const id = (row.id || "").toUpperCase();
        return id === "HDMP4" || id === "HDMOV";
      });
    }, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

async function getSelectedDownloadFormat(page: Page) {
  return page.evaluate(() => {
    const normalizeFormatName = (value: string) => {
      const upper = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (upper.includes("4KMP4") || upper === "4K") return "4K";
      if (upper.includes("HDMP4") || upper.includes("MP4HD")) return "HDMP4";
      if (upper.includes("HDMOV") || upper.includes("MOVHD")) return "HDMOV";
      return "";
    };
    const findRow = (el: Element) => {
      return (
        el.closest(".formatSelector-row") ||
        el.closest("[id='HDMP4']") ||
        el.closest("[id='HDMOV']") ||
        el.closest("[id='4KMP4']") ||
        el.parentElement
      );
    };

    const checkedRadio = Array.from(document.querySelectorAll("input[type='radio']")).find(
      (radio) => (radio as HTMLInputElement).checked
    );
    if (checkedRadio) {
      const row = findRow(checkedRadio);
      return normalizeFormatName(`${row?.id || ""} ${row?.textContent || ""}`);
    }

    const checkedRoleRadio = Array.from(document.querySelectorAll("[role='radio'][aria-checked='true']")).find(
      (el) => normalizeFormatName(`${findRow(el)?.id || ""} ${findRow(el)?.textContent || ""}`) !== ""
    );
    if (checkedRoleRadio) {
      const row = findRow(checkedRoleRadio);
      return normalizeFormatName(`${row?.id || ""} ${row?.textContent || ""}`);
    }

    return "";
  });
}

async function runDownloadFlow(
  page: Page,
  accountState: Awaited<ReturnType<typeof inspectAccountState>> | undefined,
  maxBytes: number
) {
  const ensureFormatUi = async (timeoutMs: number) => {
    return runStepWithRetry(
      "Find format options",
      async () => {
        const hasFormatUi = await waitForPreferredFormatUi(page, timeoutMs);
        if (!hasFormatUi) {
          throw new Error("Could not find format options");
        }
        return true;
      },
      2,
      700
    );
  };

  const selectAndValidatePreferredFormat = async () => {
    return runStepWithRetry(
      "Select preferred format",
      async () => {
        const selectedFormat = await selectPreferredDownloadFormat(page, maxBytes);
        if (!selectedFormat) {
          throw new Error("No supported HD format under 100 MB (HDMP4 or HDMOV)");
        }
        await delay(OPERATION_DELAY_MS);
        const activeFormat = await getSelectedDownloadFormat(page);
        if (activeFormat !== "HDMP4" && activeFormat !== "HDMOV") {
          throw new Error(`Failed to switch away from ${activeFormat || "default"} format`);
        }
        return selectedFormat;
      },
      2,
      700
    );
  };

  const clickDownloadWithRetry = async (
    messageWhenMissing: string,
    options?: { preferOverlay?: boolean }
  ) => {
    return runStepWithRetry(
      "Find/click download button",
      async () => {
        let clicked = await clickDownloadButton(page, options);
        if (!clicked && options?.preferOverlay) {
          // Some pages expose the actionable button outside overlay roots.
          clicked = await clickDownloadButton(page, { preferOverlay: false });
        }
        if (!clicked) {
          throw new Error(
            accountState?.explicitLoggedOut
              ? "Not logged in — cookies may be expired or invalid"
              : messageWhenMissing
          );
        }
        return true;
      },
      2,
      700
    );
  };

  const hasInitialHdOption = await waitForPreferredFormatUi(page, 1500);
  if (hasInitialHdOption) {
    await selectAndValidatePreferredFormat();
    await delay(OPERATION_DELAY_MS);
    await clickDownloadWithRetry("Could not find the Download button on the page", { preferOverlay: true });
    return;
  }

  await clickDownloadWithRetry("Could not find the Download button on the page");
  await delay(OPERATION_DELAY_MS);
  await ensureFormatUi(2500);
  await selectAndValidatePreferredFormat();
  await clickDownloadWithRetry("Could not confirm the HD download", { preferOverlay: true });
}

async function selectPreferredDownloadFormat(page: Page, maxBytes: number) {
  return page.evaluate((sizeLimitBytes: number) => {
    const parseBytes = (value: string) => {
      // Supports labels like "HD MP4 (hevc) 1.4 MB", "HD MOV - 84 MB", and "1.4MB".
      const match = value.match(/([\d]+(?:[.,]\d+)?)\s*(KB|MB|GB)\b/i);
      if (!match) return Number.POSITIVE_INFINITY;
      const amount = Number(match[1].replace(",", "."));
      const unit = match[2].toUpperCase();
      if (unit === "KB") return amount * 1024;
      if (unit === "MB") return amount * 1024 * 1024;
      if (unit === "GB") return amount * 1024 * 1024 * 1024;
      return Number.POSITIVE_INFINITY;
    };
    const getRankFromText = (value: string) => {
      const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (normalized.includes("4KMP4") || normalized === "4K") return -1;
      if (normalized.includes("HDMP4") || normalized.includes("MP4HD")) return 2;
      if (normalized.includes("HDMOV") || normalized.includes("MOVHD")) return 1;
      return 0;
    };
    const getFormatName = (rank: number) => (rank === 2 ? "HDMP4" : rank === 1 ? "HDMOV" : "");
    const findRow = (el: Element) => {
      return (
        el.closest(".formatSelector-row") ||
        el.closest("[id='HDMP4']") ||
        el.closest("[id='HDMOV']") ||
        el.closest("[id='4KMP4']") ||
        el.parentElement
      );
    };
    const getRankFromRow = (row: Element | null) => {
      if (!row) return 0;
      const text = `${row.id || ""} ${row.textContent || ""}`;
      const bytes = parseBytes(text);
      if (bytes > sizeLimitBytes) return 0;
      return getRankFromText(text);
    };

    const clickElement = (el: Element | null) => {
      if (!(el instanceof HTMLElement)) return;
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.click();
    };

    const commitSelection = (input: HTMLInputElement, clickTarget: Element | null) => {
      input.checked = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      clickElement(clickTarget);
    };

    let bestRadio: { input: HTMLInputElement; clickTarget: Element | null; rank: number } | null = null;
    let bestRank = 0;

    const radios = Array.from(document.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
    for (const input of radios) {
      const row = findRow(input);
      const rank = getRankFromRow(row);
      if (rank > bestRank) {
        bestRank = rank;
        bestRadio = { input, clickTarget: row, rank };
      }
    }

    if (bestRadio && bestRank > 0) {
      commitSelection(bestRadio.input, bestRadio.clickTarget);

      const selectedRadio = radios.find((radio) => radio.checked) ?? bestRadio.input;
      const selectedRow = findRow(selectedRadio);
      const selectedRank = getRankFromRow(selectedRow);
      return getFormatName(selectedRank);
    }

    const rows = Array.from(document.querySelectorAll(".formatSelector-row, [id='HDMP4'], [id='HDMOV'], [id='4KMP4']"));
    let bestRow: Element | null = null;
    bestRank = 0;

    for (const row of rows) {
      const rank = getRankFromRow(row);
      if (rank > bestRank) {
        bestRank = rank;
        bestRow = row;
      }
    }

    if (!bestRow || bestRank <= 0) return "";
    clickElement(bestRow);

    const checkedRoleRadio = Array.from(document.querySelectorAll("[role='radio'][aria-checked='true']")).find(
      (el) => getRankFromRow(findRow(el)) > 0
    );
    if (checkedRoleRadio) {
      return getFormatName(getRankFromRow(findRow(checkedRoleRadio)));
    }

    const selectedRadio = radios.find((radio) => radio.checked);
    if (selectedRadio) {
      return getFormatName(getRankFromRow(findRow(selectedRadio)));
    }

    return getFormatName(bestRank);
  }, maxBytes);
}

async function clickDownloadButton(page: Page, options?: { preferOverlay?: boolean }) {
  return page.evaluate((preferOverlay: boolean) => {
    const textOf = (el: Element) =>
      (el.textContent || (el instanceof HTMLInputElement ? el.value : ""))
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const modalRoots = Array.from(
      document.querySelectorAll(
        "[role='dialog'], [aria-modal='true'], [data-state='open'], [role='menu'], [role='listbox']"
      )
    );

    const collect = (root: ParentNode) =>
      Array.from(root.querySelectorAll("button, input[type='submit'], a, [role='button']"));

    const buttons = preferOverlay && modalRoots.length > 0
      ? [...modalRoots.flatMap((root) => collect(root)), ...collect(document)]
      : collect(document);

    for (const el of buttons) {
      if (el.closest("nav") || el.closest("header")) continue;
      if (el instanceof HTMLButtonElement && el.disabled) continue;

      const text = textOf(el);
      if (text === "download" || text === "download file") {
        if (el instanceof HTMLElement) el.click();
        return true;
      }
    }

    for (const el of buttons) {
      if (el.closest("nav") || el.closest("header")) continue;
      if (el instanceof HTMLButtonElement && el.disabled) continue;

      const text = textOf(el);
      if (
        text.includes("download") &&
        !text.includes("preview") &&
        !text.includes("app") &&
        !text.includes("extension")
      ) {
        if (el instanceof HTMLElement) el.click();
        return true;
      }
    }

    return false;
  }, options?.preferOverlay ?? false);
}

async function createDownloadDirectory(context: import("puppeteer").BrowserContext) {
  await mkdir(DOWNLOAD_CACHE_ROOT, { recursive: true });
  const downloadDir = await mkdtemp(path.join(DOWNLOAD_CACHE_ROOT, "job-"));

  const typedContext = context as typeof context & {
    setDownloadBehavior: (downloadBehavior: {
      policy: "allow";
      downloadPath: string;
    }) => Promise<void>;
  };

  await typedContext.setDownloadBehavior({
    policy: "allow",
    downloadPath: downloadDir,
  });
  return downloadDir;
}

async function waitForDownloadedFile(downloadDir: string, existingFiles: Set<string>, timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const files = await readdir(downloadDir).catch(() => []);
    const newFiles = files.filter((file) => !existingFiles.has(file));
    const completedFile = newFiles.find(
      (file) => !file.endsWith(".crdownload") && !file.endsWith(".tmp") && !file.startsWith(".")
    );

    if (completedFile) {
      const filePath = path.join(downloadDir, completedFile);
      const firstStat = await stat(filePath).catch(() => null);
      if (firstStat && firstStat.size > 0) {
        if (firstStat.size > MAX_DOWNLOAD_BYTES) {
          await cleanupDownloadArtifacts(downloadDir);
          throw new Error("File exceeds 100 MB limit");
        }
        await delay(350);
        const secondStat = await stat(filePath).catch(() => null);
        if (secondStat && secondStat.size === firstStat.size) {
          if (secondStat.size > MAX_DOWNLOAD_BYTES) {
            await cleanupDownloadArtifacts(downloadDir);
            throw new Error("File exceeds 100 MB limit");
          }
          return {
            filePath,
            filename: sanitizeFilename(completedFile),
          };
        }
      }
    }

    await delay(DOWNLOAD_POLL_MS);
  }

  return null;
}

async function cleanupDownloadArtifacts(targetPath?: string) {
  if (!targetPath) return;
  await rm(targetPath, { recursive: true, force: true }).catch(() => {});
}

async function scrapeSingleSearchUrl(
  browser: Browser,
  url: string,
  cookies: StoryblocksCookie[],
  position: number,
  total: number,
  onProgress?: (event: ProgressEvent) => void
) {
  const page = await browser.newPage();

  try {
    await configurePage(page, cookies);
    onProgress?.({ type: "progress", message: `Opening URL ${position}/${total}: ${url}` });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    await page.waitForSelector('[class*="image-link"], [data-testid*="video"], a[href*="/video/"]', {
      timeout: 10000,
    });

    const videoCards = await page.evaluate(() => {
      let cards = Array.from(document.querySelectorAll("a.image-link"));
      if (cards.length === 0) cards = Array.from(document.querySelectorAll('a[href*="/video/stock/"]'));
      if (cards.length === 0) cards = Array.from(document.querySelectorAll('[data-testid*="video"] a'));

      return cards.slice(0, 12).map((card) => {
        const anchor = card.closest("a") || card;
        const videoEl = card.querySelector("video");
        const sourceEl = videoEl?.querySelector("source");
        return {
          title: (anchor.getAttribute("aria-label") || anchor.textContent || "")
            .replace(/^Go to video details for\s*/i, "")
            .trim()
            .slice(0, 100),
          detailUrl: anchor.getAttribute("href") || "",
          thumbnail:
            videoEl?.getAttribute("poster") || card.querySelector("img")?.getAttribute("src") || "",
          previewVideoUrl:
            videoEl?.getAttribute("src") ||
            sourceEl?.getAttribute("src") ||
            videoEl?.getAttribute("data-src") ||
            sourceEl?.getAttribute("data-src") ||
            "",
        };
      });
    });

    onProgress?.({
      type: "progress",
      message: `Found ${videoCards.length} cards on URL ${position}, extracting video previews...`,
    });

    const videos: VideoInfo[] = [...videoCards];
    const needsHover = videos.some((video) => !video.previewVideoUrl);

    if (needsHover) {
      const previewUrls: string[] = await page.evaluate(async () => {
        const getVideoSrc = (el: Element) => {
          const v = el.querySelector("video");
          if (!v) return "";
          return v.getAttribute("src") || v.querySelector("source")?.getAttribute("src") || (v as HTMLVideoElement).currentSrc || "";
        };

        const cards = Array.from(document.querySelectorAll("a.image-link, a[href*='/video/stock/']")).slice(0, 12);

        for (const card of cards) {
          card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        }

        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const results = new Array<string>(cards.length).fill("");

        for (let tick = 0; tick < 8; tick++) {
          await wait(150);
          let allResolved = true;
          for (let i = 0; i < cards.length; i++) {
            if (results[i]) continue;
            const src = getVideoSrc(cards[i]);
            if (src) results[i] = src;
            else allResolved = false;
          }
          if (allResolved) break;
        }
        return results;
      });

      for (let j = 0; j < Math.min(videos.length, previewUrls.length); j++) {
        if (!videos[j].previewVideoUrl && previewUrls[j]) {
          videos[j].previewVideoUrl = previewUrls[j];
        }
      }
    }

    return { ok: true as const, result: { searchUrl: url, videos } };
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    if (/waiting for selector|timeout|timed out/i.test(message)) {
      const signals = await detectChallengeSignals(page);
      if (signals.length > 0) {
        message = `Challenge/rate-limit page detected: ${signals.join(", ")}`;
      }
    }
    return { ok: false as const, error: { url, error: `Failed to scrape: ${message}` } };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeSingleSearchUrlWithRetry(
  browser: Browser,
  url: string,
  cookies: StoryblocksCookie[],
  position: number,
  total: number,
  onProgress?: (event: ProgressEvent) => void
) {
  type ScrapeOutcome = Awaited<ReturnType<typeof scrapeSingleSearchUrl>>;
  let lastOutcome: ScrapeOutcome | undefined;

  for (let attempt = 1; attempt <= SCRAPE_MAX_ATTEMPTS; attempt++) {
    const outcome = await scrapeSingleSearchUrl(browser, url, cookies, position, total, onProgress);
    lastOutcome = outcome;
    if (outcome.ok) return outcome;

    const message = outcome.error.error;
    const retryable = /challenge|too many requests|captcha|unusual traffic|temporarily blocked|rate limit|waiting for selector|timeout|timed out|net::|navigation/i.test(
      message
    );
    if (!retryable || attempt >= SCRAPE_MAX_ATTEMPTS) {
      return outcome;
    }

    const isChallenge = /challenge|too many requests|captcha|unusual traffic|temporarily blocked|rate limit/i.test(
      message
    );
    const backoffMs = computeBackoffMs(attempt, SCRAPE_RETRY_BASE_MS, SCRAPE_RETRY_MAX_MS, 0.35);
    const extraCooldown = isChallenge ? SCRAPE_CHALLENGE_COOLDOWN_MS : 0;
    const jitterMs = Math.floor(Math.random() * 700);
    const waitMs = backoffMs + extraCooldown + jitterMs;
    onProgress?.({
      type: "progress",
      message: `Retrying scrape URL ${position}/${total} (attempt ${attempt + 1}/${SCRAPE_MAX_ATTEMPTS}) in ${Math.ceil(
        waitMs / 1000
      )}s: ${url}`,
    });
    await delay(waitMs);
  }

  return (
    lastOutcome ?? {
      ok: false as const,
      error: { url, error: "Failed to scrape: unknown retry state" },
    }
  );
}

export async function scrapeSearchUrls(
  urls: string[],
  cookies: StoryblocksCookie[],
  onProgress?: (event: ProgressEvent) => void
) {
  const results: SearchResult[] = [];
  const errors: ScrapeError[] = [];

  const browser = await launchScraperBrowser();

  try {
    const orderedOutcomes = new Array<Awaited<ReturnType<typeof scrapeSingleSearchUrl>>>(urls.length);

    for (let start = 0; start < urls.length; start += SCRAPE_CONCURRENCY) {
      const batch = urls.slice(start, start + SCRAPE_CONCURRENCY);
      const batchOutcomes = await Promise.all(
        batch.map((url, offset) =>
          scrapeSingleSearchUrlWithRetry(browser, url, cookies, start + offset + 1, urls.length, onProgress)
        )
      );

      for (let offset = 0; offset < batchOutcomes.length; offset++) {
        orderedOutcomes[start + offset] = batchOutcomes[offset];
      }

      for (let offset = 0; offset < batchOutcomes.length; offset++) {
        const absoluteIndex = start + offset;
        const outcome = batchOutcomes[offset];

        if (outcome.ok) {
          onProgress?.({
            type: "result",
            message: `Completed URL ${absoluteIndex + 1}: ${outcome.result.videos.length} videos found`,
            data: outcome.result,
          });
        } else {
          onProgress?.({
            type: "error",
            message: `Failed URL ${absoluteIndex + 1}: ${outcome.error.error.replace(/^Failed to scrape:\s*/, "")}`,
            data: outcome.error,
          });
        }
      }
    }

    for (const outcome of orderedOutcomes) {
      if (!outcome) continue;
      if (outcome.ok) results.push(outcome.result);
      else errors.push(outcome.error);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  onProgress?.({ type: "done", data: { results, errors } });
  return { results, errors };
}

export async function getDownloadUrl(
  detailUrl: string,
  cookies: StoryblocksCookie[],
  options: {
    sharedBrowser?: Browser;
    captureTimeoutMs?: number;
    downloadTimeoutMs?: number;
    loginVerified?: boolean;
  } = {}
): Promise<{ downloadUrl: string; filename?: string; loggedIn?: boolean; error?: string; localFilePath?: string }> {
  const ownsBrowser = !options.sharedBrowser;
  const browser = options.sharedBrowser ?? (await launchScraperBrowser());
  const captureTimeoutMs = options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  let page: Page | undefined;
  let downloadDir: string | undefined;
  let keepLocalFilePath: string | undefined;
  let isolatedContext: import("puppeteer").BrowserContext | undefined;
  const observedPages: Page[] = [];
  let requestHandler: ((request: { url(): string }) => void) | undefined;
  let responseHandler: ((response: HTTPResponse) => Promise<void>) | undefined;
  let targetCreatedHandler: ((target: import("puppeteer").Target) => void) | undefined;
  const recentNetworkHints: string[] = [];
  let accountState:
    | Awaited<ReturnType<typeof inspectAccountState>>
    | undefined;

  try {
    isolatedContext = await browser.createBrowserContext();
    page = await isolatedContext.newPage();
    await configurePage(page, cookies);

    const fullUrl = normalizeStoryblocksUrl(detailUrl);
    try {
      await runStepWithRetry(
        "Open page",
        async () => {
          await page!.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          await delay(OPERATION_DELAY_MS);
        },
        2,
        900
      );
    } catch (error) {
      return {
        downloadUrl: "",
        loggedIn: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (options.loginVerified) {
      const signals = await detectChallengeSignals(page);
      if (signals.length > 0) {
        return {
          downloadUrl: "",
          loggedIn: false,
          error: `Challenge/rate-limit page detected: ${signals.join(", ")}`,
        };
      }
    } else {
      accountState = await inspectAccountState(page, 4000);

      if (accountState.challengeLikely) {
        return {
          downloadUrl: "",
          loggedIn: false,
          error: `Challenge/rate-limit page detected: ${accountState.challengeSignals.join(", ") || "unknown signal"}`,
        };
      }
    }

    downloadDir = await createDownloadDirectory(isolatedContext);
    const existingFiles = new Set(await readdir(downloadDir).catch(() => []));

    let captureResolved = false;
    let capturedUrl: string | undefined;
    let resolveCapture!: (url: string) => void;
    let resolveCapturePromise!: (url: string) => void;
    const capturePromise = new Promise<string>((resolve) => {
      resolveCapturePromise = resolve;
      resolveCapture = (url: string) => {
        if (captureResolved || !isTrustedMediaCandidate(url)) return;
        captureResolved = true;
        capturedUrl = url;
        resolveCapturePromise(url);
      };
    });
    const resolveCaptureDirect = (url: string) => {
      if (captureResolved || !isTrustedMediaCandidate(url)) return;
      captureResolved = true;
      capturedUrl = url;
      resolveCapturePromise(url);
    };

    requestHandler = (request) => {
      resolveCapture(request.url());
    };

    responseHandler = async (response) => {
      const responseUrl = response.url();
      const status = response.status();
      const location = response.headers()["location"] ?? "";
      resolveCapture(responseUrl);
      resolveCapture(location);
      const contentType = response.headers()["content-type"] ?? "";
      recentNetworkHints.push(`${status} ${contentType.split(";")[0] || "unknown"} ${responseUrl.slice(0, 180)}`);
      if (recentNetworkHints.length > 10) recentNetworkHints.shift();
      if (contentType.toLowerCase().startsWith("video/") && !isBlockedTrackingUrl(responseUrl)) {
        resolveCaptureDirect(responseUrl);
      }

      const contentDisposition = response.headers()["content-disposition"] ?? "";
      if (contentDisposition.toLowerCase().includes("attachment")) {
        resolveCapture(responseUrl);
        resolveCapture(location);
      }

      if (!contentType.includes("json")) return;

      try {
        const body = await response.json();
        const candidates = extractCandidateUrls(body);
        for (const candidate of candidates) {
          resolveCapture(candidate);
        }
      } catch {
        // Ignore JSON parsing issues from non-download responses.
      }
    };

    const observePage = (targetPage: Page) => {
      if (observedPages.includes(targetPage)) return;
      targetPage.on("request", requestHandler!);
      targetPage.on("response", responseHandler!);
      observedPages.push(targetPage);
      resolveCapture(targetPage.url());
    };

    observePage(page);
    targetCreatedHandler = (target) => {
      if (target.type() !== "page") return;
      void target.page().then((targetPage) => {
        if (!targetPage) return;
        observePage(targetPage);
      }).catch(() => {});
    };
    browser.on("targetcreated", targetCreatedHandler);

    try {
      try {
        await runDownloadFlow(page, accountState, MAX_DOWNLOAD_BYTES);
      } catch (primaryError) {
        // Recovery pass for flaky UI states: reload and replay once.
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(OPERATION_DELAY_MS);
        await runDownloadFlow(page, accountState, MAX_DOWNLOAD_BYTES);
        recentNetworkHints.push(
          `recovered_after_reload=${primaryError instanceof Error ? primaryError.message.slice(0, 120) : String(primaryError).slice(0, 120)}`
        );
      }
    } catch (error) {
      return {
        downloadUrl: "",
        loggedIn: accountState?.loggedInLikely ?? true,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const effectiveDownloadDir = downloadDir!;
    const captureResult = await Promise.race([
      capturePromise.then(async (url) => {
        const localFileWaitMs = captureTimeoutMs;
        const localFile = await waitForDownloadedFile(effectiveDownloadDir, existingFiles, localFileWaitMs);
        if (localFile) {
          keepLocalFilePath = localFile.filePath;
          return {
            downloadUrl: "",
            localFilePath: localFile.filePath,
            filename: localFile.filename,
            loggedIn: true,
          };
        }
        void delay(2000).then(() => cleanupDownloadArtifacts(effectiveDownloadDir));
        return { downloadUrl: url, loggedIn: true };
      }),
      waitForDownloadedFile(effectiveDownloadDir, existingFiles, captureTimeoutMs).then((file) => {
        if (!file) return null;
        keepLocalFilePath = file.filePath;
        return {
          downloadUrl: "",
          localFilePath: file.filePath,
          filename: file.filename,
          loggedIn: true,
        };
      }),
      delay(captureTimeoutMs).then(() => null),
    ]);

    if (captureResult) {
      return captureResult;
    }

    return {
      downloadUrl: "",
      loggedIn: accountState?.loggedInLikely ?? true,
      error: accountState?.explicitLoggedOut
        ? "Not logged in — cookies may be expired or invalid"
        : `Download flow ran, but no HD MP4 URL or file was captured within ${Math.ceil(captureTimeoutMs / 1000)}s`,
    };
  } finally {
    if (targetCreatedHandler) {
      browser.off("targetcreated", targetCreatedHandler);
    }
    if (requestHandler || responseHandler) {
      for (const observedPage of observedPages) {
        if (requestHandler) observedPage.off("request", requestHandler);
        if (responseHandler) observedPage.off("response", responseHandler);
      }
    }
    if (isolatedContext) {
      await isolatedContext.close().catch(() => {});
    } else {
      await page?.close().catch(() => {});
    }

    if (downloadDir && keepLocalFilePath && !keepLocalFilePath.startsWith(downloadDir)) {
      await cleanupDownloadArtifacts(downloadDir);
    }

    if (downloadDir && !keepLocalFilePath) {
      await cleanupDownloadArtifacts(downloadDir);
    }

    if (ownsBrowser) {
      await browser.close().catch(() => {});
    }
  }
}

export interface DownloadRetryContext {
  attempt: number;
  maxAttempts: number;
  error: string;
  errorClass: DownloadErrorClass;
  backoffMs: number;
}

export interface DownloadRetryOptions {
  sharedBrowser?: Browser;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  captureTimeoutMs?: number;
  downloadTimeoutMs?: number;
  loginVerified?: boolean;
  onRetry?: (context: DownloadRetryContext) => void;
}

type DownloadResult = Awaited<ReturnType<typeof getDownloadUrl>>;

export async function getDownloadUrlWithRetry(
  detailUrl: string,
  cookies: StoryblocksCookie[],
  options: DownloadRetryOptions = {}
): Promise<DownloadResult & { attemptsUsed: number; retriesUsed: number; errorClass?: DownloadErrorClass }> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = Math.max(100, options.baseDelayMs ?? 700);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 6_000);

  let attempt = 0;
  let retriesUsed = 0;
  let lastResult: DownloadResult | undefined;

  while (attempt < maxAttempts) {
    attempt += 1;
    const result = await getDownloadUrl(detailUrl, cookies, {
      sharedBrowser: options.sharedBrowser,
      captureTimeoutMs: options.captureTimeoutMs,
      downloadTimeoutMs: options.downloadTimeoutMs,
      loginVerified: options.loginVerified,
    });
    lastResult = result;

    if (!result.error) {
      return {
        ...result,
        attemptsUsed: attempt,
        retriesUsed,
      };
    }

    const errorClass = classifyDownloadError(result.error);
    if (errorClass === "terminal" || attempt >= maxAttempts) {
      return {
        ...result,
        attemptsUsed: attempt,
        retriesUsed,
        errorClass,
      };
    }

    const backoffMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
    retriesUsed += 1;
    options.onRetry?.({
      attempt,
      maxAttempts,
      error: result.error,
      errorClass,
      backoffMs,
    });
    await delay(backoffMs);
  }

  return {
    ...(lastResult ?? { downloadUrl: "", error: "Unknown retry failure" }),
    attemptsUsed: attempt,
    retriesUsed,
    errorClass: "terminal",
  };
}

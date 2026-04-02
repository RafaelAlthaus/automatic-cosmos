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

const STORYBLOCKS_ORIGIN = "https://www.storyblocks.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const OPERATION_DELAY_MS = 500;
const CAPTURE_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 25000;
const DOWNLOAD_POLL_MS = 250;
const SCRAPE_CONCURRENCY = 6;
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const DOWNLOAD_CACHE_ROOT = path.join(os.tmpdir(), "automatic-cosmos-storyblocks");

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    lower.includes("response-content-disposition=attachment") ||
    /\.(mp4|mov)(\?|$)/i.test(lower)
  );
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
        const normalized = value.toLowerCase().replace(/\s+/g, "");
        if (normalized.includes("4k")) return -1;
        if (normalized.includes("hdmp4") || normalized.includes("mp4hd")) return 2;
        if (normalized.includes("hdmov") || normalized.includes("movhd")) return 1;
        return 0;
      };
      const clickables = Array.from(document.querySelectorAll("a, button, [role='button'], summary"));
      const labels = Array.from(document.querySelectorAll("label, [role='radio']"));

      const hasMyAccount = clickables.some((el) => textOf(el).includes("my account"));
      const hasDownloadButton = clickables.some((el) => textOf(el).includes("download"));
      const hasHdMp4 = labels.some((el) => {
        return getRank(textOf(el)) > 0;
      });

      return hasMyAccount || hasHdMp4 || hasDownloadButton;
    }, { timeout: timeoutMs })
    .catch(() => {});

  return page.evaluate(() => {
    const textOf = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    const getRank = (value: string) => {
      const normalized = value.toLowerCase().replace(/\s+/g, "");
      if (normalized.includes("4k")) return -1;
      if (normalized.includes("hdmp4") || normalized.includes("mp4hd")) return 2;
      if (normalized.includes("hdmov") || normalized.includes("movhd")) return 1;
      return 0;
    };
    const clickables = Array.from(document.querySelectorAll("a, button, [role='button'], summary"));
    const labels = Array.from(document.querySelectorAll("label, [role='radio']"));
    const pageUrl = window.location.href.toLowerCase();

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
      const upper = value.toUpperCase().replace(/\s+/g, "");
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

async function selectPreferredDownloadFormat(page: Page, maxBytes: number) {
  return page.evaluate((sizeLimitBytes: number) => {
    const parseBytes = (value: string) => {
      const match = value.match(/-\s*([\d.]+)\s*(KB|MB|GB)\b/i);
      if (!match) return Number.POSITIVE_INFINITY;
      const amount = Number(match[1]);
      const unit = match[2].toUpperCase();
      if (unit === "KB") return amount * 1024;
      if (unit === "MB") return amount * 1024 * 1024;
      if (unit === "GB") return amount * 1024 * 1024 * 1024;
      return Number.POSITIVE_INFINITY;
    };
    const getRankFromText = (value: string) => {
      const normalized = value.toUpperCase().replace(/\s+/g, "");
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

async function createDownloadDirectory(browser: Browser) {
  await mkdir(DOWNLOAD_CACHE_ROOT, { recursive: true });
  const downloadDir = await mkdtemp(path.join(DOWNLOAD_CACHE_ROOT, "job-"));

  // Puppeteer exposes this on the concrete Chromium context even though the
  // public BrowserContext type doesn't currently declare it.
  const browserContext = browser.defaultBrowserContext() as Browser["defaultBrowserContext"] extends () => infer T
    ? T & {
        setDownloadBehavior: (downloadBehavior: {
          policy: "allow";
          downloadPath: string;
        }) => Promise<void>;
      }
    : never;

  await browserContext.setDownloadBehavior({
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
    await delay(OPERATION_DELAY_MS);

    await page.waitForSelector('[class*="image-link"], [data-testid*="video"], a[href*="/video/"]', {
      timeout: 15000,
    });

    const videoCards = await page.evaluate(() => {
      let cards = Array.from(document.querySelectorAll("a.image-link"));
      if (cards.length === 0) cards = Array.from(document.querySelectorAll('a[href*="/video/stock/"]'));
      if (cards.length === 0) cards = Array.from(document.querySelectorAll('[data-testid*="video"] a'));

      return cards.slice(0, 6).map((card) => {
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
    const cardElements = await page.$$("a.image-link, a[href*='/video/stock/']");
    const needsHover = videos.some((video) => !video.previewVideoUrl);

    if (needsHover) {
      for (let j = 0; j < Math.min(6, cardElements.length, videos.length); j++) {
        if (videos[j].previewVideoUrl) continue;
        try {
          await cardElements[j].hover();
          for (let t = 0; t < 10; t++) {
            await delay(100);
            const src = await cardElements[j].evaluate((el) => {
              const video = el.querySelector("video");
              if (!video) return "";
              return (
                video.getAttribute("src") ||
                video.querySelector("source")?.getAttribute("src") ||
                (video as HTMLVideoElement).currentSrc ||
                ""
              );
            });
            if (src) {
              videos[j].previewVideoUrl = src;
              break;
            }
          }
        } catch {
          // Keep empty preview if hover extraction fails.
        }
      }
    }

    const needsDetailScrape = videos.some((video) => !video.previewVideoUrl && video.detailUrl);
    if (needsDetailScrape) {
      onProgress?.({ type: "progress", message: `Loading detail pages for URL ${position}...` });
      for (let j = 0; j < videos.length; j++) {
        if (videos[j].previewVideoUrl || !videos[j].detailUrl) continue;
        try {
          await page.goto(normalizeStoryblocksUrl(videos[j].detailUrl), {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });
          await delay(OPERATION_DELAY_MS);
          const previewUrl = await page.evaluate(() => {
            const video = document.querySelector("video");
            if (!video) return "";
            return (
              video.getAttribute("src") ||
              video.querySelector("source")?.getAttribute("src") ||
              (video as HTMLVideoElement).currentSrc ||
              ""
            );
          });
          videos[j].previewVideoUrl = previewUrl || "";
        } catch {
          // Leave preview empty.
        }
      }
    }

    return { ok: true as const, result: { searchUrl: url, videos } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false as const, error: { url, error: `Failed to scrape: ${message}` } };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrapeSearchUrls(
  urls: string[],
  cookies: StoryblocksCookie[],
  onProgress?: (event: ProgressEvent) => void
) {
  const results: SearchResult[] = [];
  const errors: ScrapeError[] = [];

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const orderedOutcomes = new Array<Awaited<ReturnType<typeof scrapeSingleSearchUrl>>>(urls.length);

    for (let start = 0; start < urls.length; start += SCRAPE_CONCURRENCY) {
      const batch = urls.slice(start, start + SCRAPE_CONCURRENCY);
      const batchOutcomes = await Promise.all(
        batch.map((url, offset) =>
          scrapeSingleSearchUrl(browser, url, cookies, start + offset + 1, urls.length, onProgress)
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
    await browser.close();
  }

  onProgress?.({ type: "done", data: { results, errors } });
  return { results, errors };
}

export async function getDownloadUrl(
  detailUrl: string,
  cookies: StoryblocksCookie[],
  sharedBrowser?: Browser
): Promise<{ downloadUrl: string; filename?: string; loggedIn?: boolean; error?: string; localFilePath?: string }> {
  const ownsBrowser = !sharedBrowser;
  const browser =
    sharedBrowser ??
    (await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    }));

  let page: Page | undefined;
  let downloadDir: string | undefined;
  let keepLocalFilePath: string | undefined;
  let requestHandler: ((request: { url(): string }) => void) | undefined;
  let responseHandler: ((response: HTTPResponse) => Promise<void>) | undefined;
  let accountState:
    | Awaited<ReturnType<typeof inspectAccountState>>
    | undefined;

  try {
    page = await browser.newPage();
    await configurePage(page, cookies);

    const fullUrl = normalizeStoryblocksUrl(detailUrl);
    await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(OPERATION_DELAY_MS);

    accountState = await inspectAccountState(page, 6000);

    if (!accountState.loggedInLikely && !accountState.explicitLoggedOut) {
      await delay(2500);
      accountState = await inspectAccountState(page, 8000);
    }

    if (!accountState.loggedInLikely && !accountState.explicitLoggedOut) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      await delay(OPERATION_DELAY_MS);
      accountState = await inspectAccountState(page, 8000);
    }

    downloadDir = await createDownloadDirectory(browser);
    const existingFiles = new Set(await readdir(downloadDir).catch(() => []));

    let captureResolved = false;
    let resolveCapture!: (url: string) => void;
    const capturePromise = new Promise<string>((resolve) => {
      resolveCapture = (url: string) => {
        if (captureResolved || !isLikelyMediaDownloadUrl(url)) return;
        captureResolved = true;
        resolve(url);
      };
    });

    requestHandler = (request) => {
      resolveCapture(request.url());
    };

    responseHandler = async (response) => {
      const responseUrl = response.url();
      const location = response.headers()["location"] ?? "";
      resolveCapture(responseUrl);
      resolveCapture(location);

      const contentDisposition = response.headers()["content-disposition"] ?? "";
      if (contentDisposition.toLowerCase().includes("attachment") && isLikelyMediaDownloadUrl(responseUrl)) {
        resolveCapture(responseUrl);
      }

      const contentType = response.headers()["content-type"] ?? "";
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

    page.on("request", requestHandler);
    page.on("response", responseHandler);

    const hasInitialHdOption = await waitForPreferredFormatUi(page, 1500);
    if (hasInitialHdOption) {
      const selectedFormat = await selectPreferredDownloadFormat(page, MAX_DOWNLOAD_BYTES);
      if (!selectedFormat) {
        return {
          downloadUrl: "",
          loggedIn: accountState.loggedInLikely,
          error: "No supported HD format under 100 MB (HDMP4 or HDMOV)",
        };
      }
      await delay(OPERATION_DELAY_MS);
      const activeFormat = await getSelectedDownloadFormat(page);
      if (activeFormat !== "HDMP4" && activeFormat !== "HDMOV") {
        return {
          downloadUrl: "",
          loggedIn: accountState.loggedInLikely,
          error: `Failed to switch away from ${activeFormat || "default"} format`,
        };
      }
      await delay(OPERATION_DELAY_MS);

      const startedDownload = await clickDownloadButton(page, { preferOverlay: true });
      if (!startedDownload) {
        return {
          downloadUrl: "",
          loggedIn: accountState.loggedInLikely,
          error: accountState.explicitLoggedOut
            ? "Not logged in — cookies may be expired or invalid"
            : "Could not find the Download button on the page",
        };
      }
    } else {
      const openedDownloadFlow = await clickDownloadButton(page);
      if (!openedDownloadFlow) {
        return {
          downloadUrl: "",
          loggedIn: accountState.loggedInLikely,
          error: accountState.explicitLoggedOut
            ? "Not logged in — cookies may be expired or invalid"
            : "Could not find the Download button on the page",
        };
      }

      await delay(OPERATION_DELAY_MS);

      const chooserHasFormat = await waitForPreferredFormatUi(page, 2500);
      if (!chooserHasFormat) {
        return {
          downloadUrl: "",
          loggedIn: accountState.loggedInLikely,
          error: "No supported HD format under 100 MB (HDMP4 or HDMOV)",
        };
      }

      const selectedFormat = await selectPreferredDownloadFormat(page, MAX_DOWNLOAD_BYTES);
      if (!selectedFormat) {
        return {
          downloadUrl: "",
          loggedIn: accountState.loggedInLikely,
          error: "No supported HD format under 100 MB (HDMP4 or HDMOV)",
        };
      }
      await delay(OPERATION_DELAY_MS);

      const activeFormat = await getSelectedDownloadFormat(page);
      if (activeFormat !== "HDMP4" && activeFormat !== "HDMOV") {
        return {
          downloadUrl: "",
          loggedIn: accountState.loggedInLikely,
          error: `Failed to switch away from ${activeFormat || "default"} format`,
        };
      }

      const confirmedDownload = await clickDownloadButton(page, { preferOverlay: true });
      if (!confirmedDownload) {
        return {
          downloadUrl: "",
          loggedIn: accountState.loggedInLikely,
          error: accountState.explicitLoggedOut
            ? "Not logged in — cookies may be expired or invalid"
            : "Could not confirm the HD download",
        };
      }
    }

    const outcome = await Promise.race([
      capturePromise.then((url) => ({ kind: "url" as const, url })),
      waitForDownloadedFile(downloadDir, existingFiles, DOWNLOAD_TIMEOUT_MS).then((file) =>
        file ? { kind: "file" as const, ...file } : { kind: "file-timeout" as const }
      ),
      delay(CAPTURE_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
    ]);

    if (outcome.kind === "url") {
      const downloadedFile = await waitForDownloadedFile(downloadDir, existingFiles, 4000);
      if (downloadedFile) {
        keepLocalFilePath = downloadedFile.filePath;
        return {
          downloadUrl: "",
          localFilePath: downloadedFile.filePath,
          filename: downloadedFile.filename,
          loggedIn: true,
        };
      }

      if (downloadDir) {
        void delay(4000).then(() => cleanupDownloadArtifacts(downloadDir));
      }
      return {
        downloadUrl: outcome.url,
        loggedIn: true,
      };
    }

    if (outcome.kind === "file") {
      keepLocalFilePath = outcome.filePath;
      return {
        downloadUrl: "",
        localFilePath: outcome.filePath,
        filename: outcome.filename,
        loggedIn: true,
      };
    }

    const fallbackFile = await waitForDownloadedFile(downloadDir, existingFiles, DOWNLOAD_TIMEOUT_MS);
    if (fallbackFile) {
      keepLocalFilePath = fallbackFile.filePath;
      return {
        downloadUrl: "",
        localFilePath: fallbackFile.filePath,
        filename: fallbackFile.filename,
        loggedIn: true,
      };
    }

    return {
      downloadUrl: "",
      loggedIn: accountState?.loggedInLikely ?? true,
      error: accountState?.explicitLoggedOut
        ? "Not logged in — cookies may be expired or invalid"
        : "Download flow ran, but no HD MP4 URL or file was captured",
    };
  } finally {
    if (page && requestHandler) {
      page.off("request", requestHandler);
    }
    if (page && responseHandler) {
      page.off("response", responseHandler);
    }
    await page?.close().catch(() => {});

    if (downloadDir && keepLocalFilePath && !keepLocalFilePath.startsWith(downloadDir)) {
      await cleanupDownloadArtifacts(downloadDir);
    }

    if (downloadDir && !keepLocalFilePath) {
      await cleanupDownloadArtifacts(downloadDir);
    }

    if (ownsBrowser) {
      await browser.close();
    }
  }
}

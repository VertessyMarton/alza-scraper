const STORAGE_KEY = "alzaArukeresoJob";
const PAGE_LOAD_TIMEOUT = 20000;
const CONTENT_SCRIPT_TIMEOUT = 5000;
const LOOKUP_DELAY = 500;

let activeJobPromise = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isPriceAtMost(price, limit) {
  return Number.isFinite(price) && Number.isFinite(limit) && price <= limit;
}

function getDealOutcome(alza, arukereso, dbLowestPriceSince2023 = null) {
  if (arukereso?.status !== "matched") return null;

  const alzaPrice = alza?.price;
  const currentLowestPrice = arukereso.lowestPrice;
  const historicalLowestPrice =
    arukereso.lowestHistoricalPriceSince2023;
  const hasRelevantDbRecord = Number.isFinite(dbLowestPriceSince2023);

  if (hasRelevantDbRecord) {
    if (isPriceAtMost(alzaPrice, dbLowestPriceSince2023)) {
      return "BEST SOS";
    }

    if (isPriceAtMost(alzaPrice, historicalLowestPrice)) {
      return "BEST DIAGRAM";
    }

    if (isPriceAtMost(alzaPrice, currentLowestPrice)) {
      return "BEST ÁRUKERESŐ";
    }

    return null;
  }

  const isRecentOrTop =
    arukereso.isTopProduct === true ||
    arukereso.hasRecentReview === true;

  if (isRecentOrTop && isPriceAtMost(alzaPrice, currentLowestPrice)) {
    return "NEW TOP";
  }

  if (isPriceAtMost(alzaPrice, historicalLowestPrice)) {
    return "NEW DIAGRAM";
  }

  return null;
}

function applyDecision(result) {
  const dbLowestPriceSince2023 = null;

  result.database = {
    lowestPriceSince2023: dbLowestPriceSince2023,
  };
  result.outcome = getDealOutcome(
    result.alza,
    result.arukereso,
    dbLowestPriceSince2023
  );
}

function getLocalDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildExcelRows(job) {
  return job.results
    .filter(result => result.outcome)
    .map(result => ({
      date: getLocalDate(),
      type: result.outcome,
      alzaLink: result.alza.productUrl,
      alzaPrice: result.alza.price,
      workerName: job.workerName,
      arukeresoLowestPrice: result.arukereso.lowestPrice,
      dbLowestPrice: result.database.lowestPriceSince2023 ?? "NINCS",
    }));
}

function createSearchUrl(productName) {
  const url = new URL("https://www.arukereso.hu/CategorySearch.php");
  url.searchParams.set("st", productName);
  return url.href;
}

function normalizeSearchQuery(productName) {
  return productName
    .replace(
      /\s+-\s+(?:\d+\s*)?(?:év|éves)\s+garancia.*$/iu,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function isCategorySearchUrl(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith("/categorysearch.php");
  } catch {
    return false;
  }
}

function isArukeresoUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "arukereso.hu" || hostname.endsWith(".arukereso.hu");
  } catch {
    return false;
  }
}

async function loadJob() {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || null;
}

async function saveJob(job) {
  await browser.storage.local.set({ [STORAGE_KEY]: job });
}

function waitForTabToLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Árukereső page load timed out."));
    }, PAGE_LOAD_TIMEOUT);

    function cleanup() {
      clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    }

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      if (!isArukeresoUrl(tab.url)) return;

      cleanup();
      resolve(tab);
    }

    function onRemoved(removedTabId) {
      if (removedTabId !== tabId) return;

      cleanup();
      reject(new Error("Árukereső lookup tab was closed."));
    }

    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
  });
}

async function sendScrapeMessage(tabId) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < CONTENT_SCRIPT_TIMEOUT) {
    try {
      return await browser.tabs.sendMessage(tabId, {
        type: "SCRAPE_ARUKERESO_PAGE",
      });
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError || new Error("Árukereső content script did not respond.");
}

async function navigateAndScrapeQuery(tabId, product, searchQuery) {
  const searchUrl = createSearchUrl(searchQuery);
  const loaded = waitForTabToLoad(tabId);

  await browser.tabs.update(tabId, { url: searchUrl });
  const loadedTab = await loaded;
  const scraped = await sendScrapeMessage(tabId);

  return {
    status: scraped.status,
    matchSource: scraped.status === "matched" ? "automatic" : null,
    searchQuery,
    searchUrl,
    finalUrl: scraped.url || loadedTab.url,
    productName: scraped.productName || null,
    lowestPrice: scraped.lowestPrice ?? null,
    hasRecentReview: scraped.hasRecentReview ?? null,
    isTopProduct: scraped.isTopProduct ?? null,
    lowestHistoricalPriceSince2023:
      scraped.lowestHistoricalPriceSince2023 ?? null,
    checkedAt: new Date().toISOString(),
  };
}

async function navigateAndScrape(tabId, product) {
  const firstResult = await navigateAndScrapeQuery(
    tabId,
    product,
    product.name
  );
  const normalizedQuery = normalizeSearchQuery(product.name);
  const shouldRetry =
    firstResult.status === "not_found" &&
    isCategorySearchUrl(firstResult.finalUrl) &&
    normalizedQuery &&
    normalizedQuery !== product.name;

  if (!shouldRetry) return firstResult;

  console.log(
    `Árukereső: retrying without warranty suffix: ${normalizedQuery}`
  );
  return navigateAndScrapeQuery(tabId, product, normalizedQuery);
}

async function closeLookupTab(job) {
  if (!job.lookupTabId) return;

  const tabId = job.lookupTabId;
  job.lookupTabId = null;
  await browser.tabs.remove(tabId).catch(() => undefined);
}

async function closeComparisonWindow(job) {
  if (!job.comparisonWindowId) return;

  const windowId = job.comparisonWindowId;
  job.comparisonWindowId = null;
  await browser.windows.remove(windowId).catch(() => undefined);
}

async function positionWindow(windowId, bounds) {
  await browser.windows.update(windowId, { state: "normal" });
  await sleep(100);
  await browser.windows.update(windowId, bounds);

  // Some Linux window managers apply their own placement just after creation.
  await sleep(250);
  await browser.windows.update(windowId, bounds);
}

async function openComparisonWindows(job, tabId) {
  const product = job.results[job.currentIndex]?.alza;
  if (!product?.productUrl) return;

  await closeComparisonWindow(job);

  const lookupTab = await browser.tabs.get(tabId);
  const sourceWindow = await browser.windows.get(lookupTab.windowId);
  const screenInfo = globalThis.screen;
  const totalWidth = screenInfo?.availWidth > 0
    ? screenInfo.availWidth
    : Math.max(sourceWindow.width || 1400, 900);
  const height = screenInfo?.availHeight > 0
    ? screenInfo.availHeight
    : Math.max(sourceWindow.height || 800, 600);
  const left = Number.isFinite(screenInfo?.availLeft)
    ? screenInfo.availLeft
    : sourceWindow.left ?? 0;
  const top = Number.isFinite(screenInfo?.availTop)
    ? screenInfo.availTop
    : sourceWindow.top ?? 0;
  const leftWidth = Math.floor(totalWidth / 2);
  const rightWidth = totalWidth - leftWidth;

  const comparisonWindow = await browser.windows.create({
    url: product.productUrl,
    type: "normal",
    focused: false,
    left,
    top,
    width: leftWidth,
    height,
  });

  const lookupWindow = await browser.windows.create({
    tabId,
    type: "normal",
    focused: true,
    left: left + leftWidth,
    top,
    width: rightWidth,
    height,
  });

  const leftBounds = {
    left,
    top,
    width: leftWidth,
    height,
  };
  const rightBounds = {
    left: left + leftWidth,
    top,
    width: rightWidth,
    height,
  };

  await Promise.all([
    positionWindow(comparisonWindow.id, leftBounds),
    positionWindow(lookupWindow.id, rightBounds),
  ]);
  await browser.windows.update(lookupWindow.id, { focused: true });

  job.comparisonWindowId = comparisonWindow.id;
  job.lookupWindowId = lookupWindow.id;
  await saveJob(job);
}

async function completeJob(job) {
  job.status = "completed";
  job.currentIndex = job.total;
  job.finishedAt = new Date().toISOString();
  job.excelRows = buildExcelRows(job);
  await closeComparisonWindow(job);
  await closeLookupTab(job);
  await saveJob(job);
  console.log("Alza/Árukereső job completed.", job);
}

async function pauseForManualSelection(job, tabId) {
  job.status = "waiting_for_user";
  await saveJob(job);
  await openComparisonWindows(job, tabId).catch(error => {
    console.warn("Could not open side-by-side comparison windows.", error);
  });
  await browser.tabs.update(tabId, { active: true }).catch(() => undefined);
  await browser.tabs.sendMessage(tabId, {
    type: "SHOW_ARUKERESO_MANUAL_REVIEW",
  }).catch(() => undefined);
}

async function processJob(job) {
  if (job.currentIndex >= job.total) {
    await completeJob(job);
    return;
  }

  let lookupTab;

  if (job.lookupTabId) {
    lookupTab = await browser.tabs.get(job.lookupTabId).catch(() => null);
  }

  if (!lookupTab) {
    lookupTab = await browser.tabs.create({ active: false });
    job.lookupTabId = lookupTab.id;
    await saveJob(job);
  }

  for (let index = job.currentIndex; index < job.total; index++) {
    const product = job.results[index].alza;
    job.status = "running";
    job.currentIndex = index;
    job.results[index].arukereso = { status: "processing" };
    await saveJob(job);

    try {
      job.results[index].arukereso = await navigateAndScrape(
        lookupTab.id,
        product
      );
    } catch (error) {
      job.results[index].arukereso = {
        status: "error",
        searchQuery: product.name,
        searchUrl: createSearchUrl(product.name),
        message: error.message,
        checkedAt: new Date().toISOString(),
      };
    }

    if (job.results[index].arukereso.status === "manual_review") {
      await pauseForManualSelection(job, lookupTab.id);
      return;
    }

    applyDecision(job.results[index]);

    job.completed = index + 1;
    job.currentIndex = index + 1;
    await saveJob(job);

    if (index < job.total - 1) await sleep(LOOKUP_DELAY);
  }

  await completeJob(job);
}

async function runNewJob(products, workerName) {
  const job = {
    status: "running",
    total: products.length,
    completed: 0,
    currentIndex: 0,
    lookupTabId: null,
    lookupWindowId: null,
    comparisonWindowId: null,
    workerName,
    excelRows: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: products.map(product => ({
      alza: product,
      arukereso: { status: "pending" },
    })),
  };

  await saveJob(job);
  await processJob(job);
}

function trackJob(promise) {
  activeJobPromise = promise
    .catch(error => console.error("Alza/Árukereső job failed.", error))
    .finally(() => {
      activeJobPromise = null;
    });
}

function startJob(products, workerName) {
  if (activeJobPromise) {
    return { started: false, reason: "A lookup job is already running." };
  }

  if (!workerName) {
    return { started: false, reason: "Worker name is required." };
  }

  trackJob(runNewJob(products, workerName));
  return { started: true, productCount: products.length };
}

async function resumeJob(scraped, sender) {
  if (activeJobPromise) {
    return { resumed: false, reason: "The lookup job is already running." };
  }

  const job = await loadJob();
  const tabId = sender.tab?.id;

  if (!job || job.status !== "waiting_for_user") {
    return { resumed: false, reason: "No lookup is waiting for a selection." };
  }

  if (!tabId) {
    return { resumed: false, reason: "Could not identify this Árukereső tab." };
  }

  if (!scraped?.productName || scraped.status !== "matched") {
    return { resumed: false, reason: "Open a specific product page first." };
  }

  const index = job.currentIndex;
  const previousTabId = job.lookupTabId;
  const previousResult = job.results[index].arukereso;
  job.results[index].arukereso = {
    status: "matched",
    matchSource: "manual",
    searchQuery: previousResult.searchQuery || job.results[index].alza.name,
    searchUrl: previousResult.searchUrl,
    finalUrl: scraped.url,
    productName: scraped.productName,
    lowestPrice: scraped.lowestPrice ?? null,
    hasRecentReview: scraped.hasRecentReview ?? null,
    isTopProduct: scraped.isTopProduct ?? null,
    lowestHistoricalPriceSince2023:
      scraped.lowestHistoricalPriceSince2023 ?? null,
    checkedAt: new Date().toISOString(),
  };
  applyDecision(job.results[index]);
  job.completed = index + 1;
  job.currentIndex = index + 1;
  job.lookupTabId = tabId;
  job.status = "running";
  await saveJob(job);

  await closeComparisonWindow(job);
  await saveJob(job);

  if (previousTabId && previousTabId !== tabId) {
    await browser.tabs.remove(previousTabId).catch(() => undefined);
  }

  trackJob(processJob(job));
  return { resumed: true, productName: scraped.productName };
}

async function skipCurrentProduct(sender) {
  if (activeJobPromise) {
    return { skipped: false, reason: "The lookup job is already running." };
  }

  const job = await loadJob();
  const tabId = sender.tab?.id;

  if (!job || job.status !== "waiting_for_user") {
    return { skipped: false, reason: "No lookup is waiting for a decision." };
  }

  if (!tabId) {
    return { skipped: false, reason: "Could not identify this Árukereső tab." };
  }

  const index = job.currentIndex;
  const previousTabId = job.lookupTabId;
  const previousResult = job.results[index].arukereso;
  job.results[index].arukereso = {
    status: "skipped",
    searchQuery: previousResult.searchQuery || job.results[index].alza.name,
    searchUrl: previousResult.searchUrl,
    finalUrl: sender.tab.url || previousResult.finalUrl,
    productName: null,
    checkedAt: new Date().toISOString(),
  };
  job.completed = index + 1;
  job.currentIndex = index + 1;
  job.lookupTabId = tabId;
  job.status = "running";
  await saveJob(job);

  await closeComparisonWindow(job);
  await saveJob(job);

  if (previousTabId && previousTabId !== tabId) {
    await browser.tabs.remove(previousTabId).catch(() => undefined);
  }

  trackJob(processJob(job));
  return { skipped: true };
}

async function getJobContext(sender) {
  const job = await loadJob();
  const waitingForSelection = Boolean(
    job && job.status === "waiting_for_user" && sender.tab?.id
  );

  return {
    waitingForSelection,
    alzaProduct: waitingForSelection
      ? job.results[job.currentIndex]?.alza
      : null,
  };
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!isArukeresoUrl(tab.url)) return;

  browser.tabs.sendMessage(tabId, {
    type: "REFRESH_ARUKERESO_MANUAL_CONTROLS",
  }).catch(() => undefined);
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "START_ARUKERESO_LOOKUPS") {
    const products = Array.isArray(message.products) ? message.products : [];
    const workerName = String(message.workerName || "").trim();
    return Promise.resolve(startJob(products, workerName));
  }

  if (message?.type === "RESUME_ARUKERESO_LOOKUPS") {
    return resumeJob(message.scraped, sender);
  }

  if (message?.type === "SKIP_ARUKERESO_LOOKUP") {
    return skipCurrentProduct(sender);
  }

  if (message?.type === "GET_LOOKUP_JOB_CONTEXT") {
    return getJobContext(sender);
  }

  if (message?.type === "GET_LOOKUP_JOB") {
    return loadJob();
  }

  return undefined;
});

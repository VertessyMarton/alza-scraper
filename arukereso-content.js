const STORAGE_KEY = "alzaArukeresoJob";
const REVIEW_LOAD_TIMEOUT = 8000;
const PRICE_HISTORY_START = Date.UTC(2023, 0, 1);

function cleanText(text) {
  return text?.replace(/\s+/g, " ").trim() || "";
}

function isSearchResultsPage() {
  return location.pathname.toLowerCase().endsWith("/categorysearch.php");
}

function getProductName() {
  const selectors = [
    '#micro-data h1 > [itemprop="name"]',
    '[itemscope][itemtype*="schema.org/Product"] h1 > [itemprop="name"]',
    'h1[itemprop="name"]',
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const name = cleanText(element?.innerText || element?.textContent);

    if (name) return name;
  }

  const productMeta = document.querySelector(
    'meta[itemprop="name"], meta[property="og:title"]'
  );

  return cleanText(productMeta?.content);
}

function getLowestPrice() {
  const element = document.querySelector(
    '#micro-data [itemprop="offers"] [itemprop="lowPrice"]'
  );
  const price = Number(element?.getAttribute("content"));

  return Number.isFinite(price) ? Math.round(price) : null;
}

function isTopProduct() {
  return Boolean(
    document.querySelector('#micro-data .badge-top-item')
  );
}

function getPublishedReviewDates() {
  return [...document.querySelectorAll(
    '#reviews [itemprop="review"] meta[itemprop="datePublished"]'
  )]
    .map(element => new Date(element.content))
    .filter(date => !Number.isNaN(date.getTime()));
}

function getReviewCount(reviewTab) {
  const match = cleanText(reviewTab?.textContent).match(/\((\d+)\)/);
  return match ? Number(match[1]) : null;
}

async function waitForReviews(reviewTab) {
  const existingDates = getPublishedReviewDates();
  if (existingDates.length > 0) return existingDates;
  if (getReviewCount(reviewTab) === 0) return [];

  reviewTab.click();
  const startedAt = Date.now();

  while (Date.now() - startedAt < REVIEW_LOAD_TIMEOUT) {
    const dates = getPublishedReviewDates();
    if (dates.length > 0) return dates;

    const reviews = document.querySelector("#reviews");
    const hasLoadedReviewSection = Boolean(
      reviews?.querySelector(
        '.opinions-wrapper, #p-revs, #writereview, form#form_revs'
      )
    );

    if (hasLoadedReviewSection) return [];

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return [];
}

async function hasRecentReview() {
  const reviewTab = document.querySelector('[data-tab="reviews"]');
  if (!reviewTab) return false;

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const dates = await waitForReviews(reviewTab);

  return dates.some(date => date >= cutoff);
}

function getProductId() {
  const idFromUrl = location.pathname.match(/-p(\d+)\/?$/i)?.[1];
  if (idFromUrl) return idFromUrl;

  const compareImage = document.querySelector("[data-compare-image]");
  return compareImage?.dataset.compareImage?.match(/p?(\d+)/i)?.[1] || null;
}

function getMinimumPricePoints(responseText) {
  const match = responseText.match(
    /"label"\s*:\s*"minimum ár"[\s\S]*?"data"\s*:\s*(\[[^\]]*\])/
  );

  if (!match) return [];

  const points = JSON.parse(match[1]);
  return Array.isArray(points) ? points : [];
}

async function getLowestHistoricalPrice() {
  const productId = getProductId();
  if (!productId) return null;

  const url = new URL("/Ajax.GetChartData.php", location.origin);
  url.searchParams.set("pt", "p");
  url.searchParams.set("pid", productId);
  url.searchParams.set("t", "normal");
  url.searchParams.set("_", Date.now());

  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`Price history request failed: ${response.status}`);

  const points = getMinimumPricePoints(await response.text());
  const prices = points
    .filter(point => Number(point.t) >= PRICE_HISTORY_START)
    .map(point => Number(point.y))
    .filter(Number.isFinite);

  return prices.length > 0 ? Math.round(Math.min(...prices)) : null;
}

async function getOptionalProductData() {
  const [recentReviewResult, historicalPriceResult] = await Promise.allSettled([
    hasRecentReview(),
    getLowestHistoricalPrice(),
  ]);

  if (recentReviewResult.status === "rejected") {
    console.warn("Could not check Árukereső reviews.", recentReviewResult.reason);
  }

  if (historicalPriceResult.status === "rejected") {
    console.warn(
      "Could not check Árukereső price history.",
      historicalPriceResult.reason
    );
  }

  return {
    hasRecentReview: recentReviewResult.status === "fulfilled"
      ? recentReviewResult.value
      : null,
    lowestHistoricalPriceSince2023:
      historicalPriceResult.status === "fulfilled"
        ? historicalPriceResult.value
        : null,
  };
}

async function scrapeArukeresoPage() {
  if (isSearchResultsPage()) {
    return {
      status: "manual_review",
      url: location.href,
      productName: null,
    };
  }

  const productName = getProductName();

  if (!productName) {
    return {
      status: "not_found",
      url: location.href,
      productName: null,
    };
  }

  const optionalData = await getOptionalProductData();

  return {
    status: "matched",
    url: location.href,
    productName,
    lowestPrice: getLowestPrice(),
    isTopProduct: isTopProduct(),
    ...optionalData,
  };
}

function getHelper() {
  let helper = document.querySelector("#arukereso-scraper-helper");

  if (helper) return helper;

  helper = document.createElement("div");
  helper.id = "arukereso-scraper-helper";
  helper.style.position = "fixed";
  helper.style.right = "18px";
  helper.style.bottom = "18px";
  helper.style.zIndex = "2147483647";
  helper.style.width = "320px";
  helper.style.padding = "14px";
  helper.style.borderRadius = "10px";
  helper.style.background = "#10243e";
  helper.style.color = "#ffffff";
  helper.style.boxShadow = "0 8px 30px rgba(0, 0, 0, 0.3)";
  helper.style.font = "14px/1.4 system-ui, sans-serif";
  document.body.append(helper);

  return helper;
}

function showManualControls() {
  const helper = getHelper();
  helper.replaceChildren();

  const title = document.createElement("strong");
  title.textContent = "Manual product selection needed";

  const text = document.createElement("div");
  text.style.margin = "6px 0 10px";
  text.textContent = isSearchResultsPage()
    ? "Open the correct product, or skip if no matching product exists."
    : "Confirm this product, or skip the current lookup.";

  const message = document.createElement("div");
  message.style.marginBottom = "8px";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.textContent = "✓ Continue";
  confirmButton.disabled = isSearchResultsPage();
  confirmButton.style.flex = "1";
  confirmButton.style.padding = "10px";
  confirmButton.style.border = "0";
  confirmButton.style.borderRadius = "6px";
  confirmButton.style.background = "#16a34a";
  confirmButton.style.color = "#ffffff";
  confirmButton.style.cursor = confirmButton.disabled ? "not-allowed" : "pointer";
  confirmButton.style.opacity = confirmButton.disabled ? "0.55" : "1";
  confirmButton.style.font = "700 14px system-ui, sans-serif";

  const skipButton = document.createElement("button");
  skipButton.type = "button";
  skipButton.textContent = "✕ Skip";
  skipButton.style.flex = "1";
  skipButton.style.padding = "10px";
  skipButton.style.border = "0";
  skipButton.style.borderRadius = "6px";
  skipButton.style.background = "#dc2626";
  skipButton.style.color = "#ffffff";
  skipButton.style.cursor = "pointer";
  skipButton.style.font = "700 14px system-ui, sans-serif";

  confirmButton.addEventListener("click", async () => {
    confirmButton.disabled = true;
    skipButton.disabled = true;
    message.textContent = "Continuing...";

    try {
      const response = await browser.runtime.sendMessage({
        type: "RESUME_ARUKERESO_LOOKUPS",
        scraped: await scrapeArukeresoPage(),
      });

      if (!response?.resumed) {
        throw new Error(response?.reason || "Could not resume lookup.");
      }

      message.textContent = "Product selected. Continuing...";
    } catch (error) {
      message.textContent = error.message;
      confirmButton.disabled = false;
      skipButton.disabled = false;
    }
  });

  skipButton.addEventListener("click", async () => {
    confirmButton.disabled = true;
    skipButton.disabled = true;
    message.textContent = "Skipping...";

    try {
      const response = await browser.runtime.sendMessage({
        type: "SKIP_ARUKERESO_LOOKUP",
      });

      if (!response?.skipped) {
        throw new Error(response?.reason || "Could not skip lookup.");
      }

      message.textContent = "Skipped. Continuing...";
    } catch (error) {
      message.textContent = error.message;
      confirmButton.disabled = isSearchResultsPage();
      skipButton.disabled = false;
    }
  });

  actions.append(confirmButton, skipButton);
  helper.append(title, text, message, actions);
}

async function initializeManualControls() {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    const job = stored[STORAGE_KEY];
    const waitingForSelection = job?.status === "waiting_for_user";

    if (!waitingForSelection) return;

    showManualControls();
  } catch (error) {
    console.error("Could not initialize Árukereső helper.", error);
  }
}

browser.runtime.onMessage.addListener(message => {
  if (message?.type === "SCRAPE_ARUKERESO_PAGE") {
    return scrapeArukeresoPage();
  }

  if (message?.type === "SHOW_ARUKERESO_MANUAL_REVIEW") {
    showManualControls();
    return Promise.resolve({ shown: true });
  }

  if (message?.type === "REFRESH_ARUKERESO_MANUAL_CONTROLS") {
    return initializeManualControls().then(() => ({ refreshed: true }));
  }

  return undefined;
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) return;
  initializeManualControls();
});

initializeManualControls();

window.arukeresoScraper = {
  scrapeArukeresoPage,
  getProductName,
};

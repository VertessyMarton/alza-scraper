const productCardSelector = ".box.browsingitem";
const productLinkSelector = "a.name.browsinglink";
const priceSelector = ".ads-pb__price-value.js-price-box__primary-price__value";

const maxPages = 250;
const pageLoadTimeout = 12000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cleanText(text) {
  return text?.replace(/\s+/g, " ").trim() || "";
}

function getPriceNumber(text) {
  const digits = text?.replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

function getProductCards() {
  return [...document.querySelectorAll(productCardSelector)];
}

function getPriceText(card) {
  const priceEl = card.querySelector(priceSelector);
  return cleanText(priceEl?.innerText || priceEl?.textContent);
}

function scrapeCurrentPage() {
  return getProductCards()
    .map(card => {
      const link = card.querySelector(productLinkSelector);
      const priceText = getPriceText(card);

      return {
        name: cleanText(link?.innerText || link?.textContent),
        price: getPriceNumber(priceText),
        productUrl: link?.href || null,
      };
    })
    .filter(product => product.name && product.productUrl);
}

function getCurrentPageNumber() {
  const hashPage = new URLSearchParams(location.hash.replace(/^#/, "")).get("pg");
  const searchPage = new URLSearchParams(location.search).get("pg");
  const page = Number(hashPage || searchPage || 1);

  return page > 0 ? page : 1;
}

function getPageNumberFromLink(link) {
  const url = new URL(link.href, location.href);
  const hashPage = new URLSearchParams(url.hash.replace(/^#/, "")).get("pg");
  const searchPage = url.searchParams.get("pg");
  const page = Number(hashPage || searchPage);

  return page > 0 ? page : null;
}

function getLastPage() {
  const pages = [getCurrentPageNumber()];

  document
    .querySelectorAll('a[href*="pg="], .paging a, .pagination a, .pager a')
    .forEach(link => {
      const pageFromHref = getPageNumberFromLink(link);
      const pageFromText = Number(cleanText(link.textContent).replace(/\D/g, ""));

      if (pageFromHref) pages.push(pageFromHref);
      if (pageFromText > 0) pages.push(pageFromText);
    });

  const lastPage = Math.max(...pages);
  return lastPage > 1 ? lastPage : null;
}

function goToPage(page) {
  if (getCurrentPageNumber() === page) return false;

  const hashParts = (location.hash.replace(/^#/, "") || "f&cud=0&prod=")
    .split("&")
    .filter(Boolean);

  const hasPage = hashParts.some(part => part.startsWith("pg="));
  const nextHash = hashParts
    .map(part => part.startsWith("pg=") ? `pg=${page}` : part)
    .concat(hasPage ? [] : `pg=${page}`)
    .join("&");

  location.hash = nextHash;
  return true;
}

function productSignature() {
  return scrapeCurrentPage()
    .map(product => product.productUrl)
    .join("|");
}

async function waitForProductsToChange(oldSignature) {
  const startedAt = Date.now();

  return new Promise(resolve => {
    const timer = setInterval(() => {
      const hasChanged = productSignature() !== oldSignature && scrapeCurrentPage().length > 0;
      const timedOut = Date.now() - startedAt > pageLoadTimeout;

      if (hasChanged || timedOut) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

function debugPageSelectors() {
  const productLinks = [...document.querySelectorAll(productLinkSelector)];
  const firstProducts = scrapeCurrentPage().slice(0, 5);

  return {
    url: location.href,
    currentPage: getCurrentPageNumber(),
    productCards: getProductCards().length,
    productLinks: productLinks.length,
    priceMatches: document.querySelectorAll(priceSelector).length,
    sampleLinks: productLinks.slice(0, 5).map(link => ({
      text: cleanText(link.innerText || link.textContent),
      href: link.href,
    })),
    firstProducts,
  };
}

function getOverlay() {
  let overlay = document.querySelector("#alza-scraper-overlay");

  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "alza-scraper-overlay";
  overlay.style.position = "fixed";
  overlay.style.right = "16px";
  overlay.style.bottom = "16px";
  overlay.style.zIndex = "2147483647";
  overlay.style.padding = "12px 14px";
  overlay.style.borderRadius = "8px";
  overlay.style.background = "#101827";
  overlay.style.color = "#ffffff";
  overlay.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.25)";
  overlay.style.font = "13px/1.4 system-ui, sans-serif";
  overlay.style.minWidth = "220px";
  overlay.style.maxWidth = "320px";
  overlay.style.pointerEvents = "none";

  document.body.append(overlay);
  return overlay;
}

function updateOverlay(text, state = "running") {
  const overlay = getOverlay();

  overlay.textContent = text;
  overlay.style.background = state === "error"
      ? "#991b1b"
      : "#101827";
}

function showProgress(page, totalPages, productCount) {
  updateOverlay(`Scraping page ${page}/${totalPages}. Collected ${productCount} products.`);
}

async function scrapeAllPages(options = {}) {
  const lastPage = options.lastPage || getLastPage();
  const finalPage = lastPage || options.maxPages || maxPages;
  const products = [];
  const seenUrls = new Set();

  console.log(
    lastPage
      ? `Alza scraper: detected ${lastPage} pages.`
      : `Alza scraper: no last page found, trying up to ${finalPage}.`
  );
  updateOverlay("Starting Alza scrape...");

  for (let page = options.startPage || 1; page <= finalPage; page++) {
    showProgress(page, finalPage, products.length);

    const oldSignature = productSignature();
    const changedPage = goToPage(page);

    if (changedPage) {
      await waitForProductsToChange(oldSignature);
      await sleep(250);
    } else if (getProductCards().length === 0) {
      await waitForProductsToChange("");
    }

    const pageProducts = scrapeCurrentPage();

    if (pageProducts.length === 0) {
      updateOverlay("Alza scraper stopped: no products found.", "error");
      console.warn("Alza scraper: no products found.", debugPageSelectors());
      break;
    }

    const newProducts = pageProducts.filter(product => {
      if (seenUrls.has(product.productUrl)) return false;
      seenUrls.add(product.productUrl);
      return true;
    });

    products.push(...newProducts);
    showProgress(page, finalPage, products.length);

    console.log(
      `Alza scraper: page ${page} had ${pageProducts.length} products, ${newProducts.length} new.`
    );

    if (!lastPage && newProducts.length === 0) break;
  }

  console.log(`Alza scraper: finished with ${products.length} products.`);
  console.log(products);
  updateOverlay(`Scrape complete. Collected ${products.length} products.`);

  return products;
}

browser.runtime.onMessage.addListener(message => {
  if (message?.type === "SCRAPE_ALZA_CATEGORY") {
    return scrapeAllPages(message.options);
  }

  return undefined;
});

window.alzaScraper = {
  scrapeCurrentPage,
  scrapeAllPages,
  debugPageSelectors,
};

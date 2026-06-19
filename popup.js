const scrapeButton = document.querySelector("#scrape");
const workerNameInput = document.querySelector("#worker-name");
const errorMessage = document.querySelector("#error-message");
const copyResultsButton = document.querySelector("#copy-results");
const jobStatus = document.querySelector("#job-status");
const WORKER_NAME_KEY = "alzaScraperWorkerName";
const JOB_STORAGE_KEY = "alzaArukeresoJob";

let excelRows = [];

browser.storage.local.get(WORKER_NAME_KEY).then(stored => {
  workerNameInput.value = stored[WORKER_NAME_KEY] || "";
});

function cleanCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\t\r\n]+/g, " ").trim();
}

function formatRowsForExcel(rows) {
  return rows
    .map(row => [
      row.date,
      row.type,
      row.alzaLink,
      row.alzaPrice,
      row.workerName,
      row.arukeresoLowestPrice,
      row.dbLowestPrice,
    ].map(cleanCell).join("\t"))
    .join("\n");
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      console.warn("Clipboard API failed; using copy fallback.", error);
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) throw new Error("Copy command failed.");
}

function displayJob(job) {
  excelRows = Array.isArray(job?.excelRows) ? job.excelRows : [];
  copyResultsButton.hidden = job?.status !== "completed" || excelRows.length === 0;

  if (!job) {
    jobStatus.textContent = "";
  } else if (job.status === "completed") {
    jobStatus.textContent = excelRows.length > 0
      ? `${excelRows.length} matching row(s) ready to copy.`
      : "Completed. No matching products found.";
    copyResultsButton.textContent = `Copy ${excelRows.length} Excel row(s)`;
  } else if (job.status === "waiting_for_user") {
    jobStatus.textContent =
      `Waiting for manual selection (${job.completed}/${job.total}).`;
  } else {
    jobStatus.textContent = `Processing ${job.completed}/${job.total} products.`;
  }
}

async function refreshJob() {
  const stored = await browser.storage.local.get(JOB_STORAGE_KEY);
  displayJob(stored[JOB_STORAGE_KEY] || null);
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[JOB_STORAGE_KEY]) return;
  displayJob(changes[JOB_STORAGE_KEY].newValue || null);
});

refreshJob();

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

scrapeButton.addEventListener("click", async () => {
  const workerName = workerNameInput.value.trim();
  errorMessage.textContent = "";

  if (!workerName) {
    errorMessage.textContent = "Enter your name before starting.";
    workerNameInput.focus();
    return;
  }

  scrapeButton.disabled = true;

  try {
    await browser.storage.local.set({ [WORKER_NAME_KEY]: workerName });
    const tab = await getActiveTab();
    await browser.tabs.sendMessage(tab.id, {
      type: "SCRAPE_ALZA_CATEGORY",
      options: {
        maxPages: 250,
        workerName,
      },
    });
  } catch (error) {
    console.error(error);
    errorMessage.textContent = error.message;
  } finally {
    scrapeButton.disabled = false;
  }
});

copyResultsButton.addEventListener("click", async () => {
  errorMessage.textContent = "";

  try {
    await copyText(formatRowsForExcel(excelRows));
    jobStatus.textContent = `${excelRows.length} row(s) copied. Paste into Excel.`;
  } catch (error) {
    console.error(error);
    errorMessage.textContent = "Could not copy the results.";
  }
});

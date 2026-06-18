const scrapeButton = document.querySelector("#scrape");

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

scrapeButton.addEventListener("click", async () => {
  scrapeButton.disabled = true;

  try {
    const tab = await getActiveTab();
    await browser.tabs.sendMessage(tab.id, {
      type: "SCRAPE_ALZA_CATEGORY",
      options: {
        maxPages: 250,
      },
    });
  } catch (error) {
    console.error(error);
  } finally {
    scrapeButton.disabled = false;
  }
});

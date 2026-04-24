(async () => {
  const url = chrome.runtime.getURL("login.html");
  await chrome.tabs.create({ url });
  window.close();
})();

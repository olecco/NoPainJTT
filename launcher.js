const api = globalThis.browser ?? globalThis.chrome;

(async () => {
  const url = api?.runtime?.getURL?.("login.html") ?? "login.html";
  await api.tabs.create({ url });
  window.close();
})();


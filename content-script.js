const api = globalThis.browser ?? globalThis.chrome;

function pageFetchAuth({ requestId, user, password }) {
  // Runs in the PAGE context, so the request is same-origin with JTT.
  const payload = { user, password };
  fetch("/v1/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "include"
  })
    .then(async (res) => {
      let body;
      try {
        body = await res.text();
      } catch {
        body = "";
      }
      window.postMessage(
        { source: "JTTHelper", requestId, ok: res.ok, status: res.status, body },
        window.location.origin
      );
    })
    .catch((err) => {
      window.postMessage(
        {
          source: "JTTHelper",
          requestId,
          ok: false,
          status: 0,
          body: String(err?.message ?? err)
        },
        window.location.origin
      );
    });
}

function injectPageScript(args) {
  const script = document.createElement("script");
  script.type = "text/javascript";
  script.textContent = `(${pageFetchAuth.toString()})(${JSON.stringify(args)});`;
  (document.documentElement || document.head).appendChild(script);
  script.remove();
}

api?.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "JTT_PING") {
    sendResponse({ ok: true });
    return;
  }
  if (!msg || msg.type !== "JTT_AUTH") return;

  const requestId = msg.requestId || String(Date.now()) + Math.random().toString(16).slice(2);
  const user = String(msg.user ?? "");
  const password = String(msg.password ?? "");

  const onMessage = (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== "JTTHelper" || data.requestId !== requestId) return;

    window.removeEventListener("message", onMessage);
    sendResponse({ status: data.status, body: data.body, ok: data.ok });
  };

  window.addEventListener("message", onMessage);
  injectPageScript({ requestId, user, password });

  // Keep the message channel open for async response.
  return true;
});


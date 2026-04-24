const JTT_DOMAIN = "jtt.in.devexperts.com";
const JTT_ORIGIN = `https://${JTT_DOMAIN}`;

// Rule IDs for session rules
const RULE_ID_COOKIE = 1;
const RULE_ID_ORIGIN = 2;
const RULE_ID_REFERER = 3;

/**
 * Set declarativeNetRequest session rules that inject Cookie, Origin and
 * Referer headers on every request the extension makes to JTT.
 */
async function setAuthRules(cookieValue) {
  const extensionDomain = chrome.runtime.id; // e.g. "abcdef1234..."

  const commonCondition = {
    urlFilter: `||${JTT_DOMAIN}`,
    initiatorDomains: [extensionDomain],
    resourceTypes: ["xmlhttprequest"]
  };

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID_COOKIE, RULE_ID_ORIGIN, RULE_ID_REFERER],
    addRules: [
      {
        id: RULE_ID_COOKIE,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Cookie", operation: "set", value: cookieValue }
          ]
        },
        condition: { ...commonCondition }
      },
      {
        id: RULE_ID_ORIGIN,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "set", value: JTT_ORIGIN }
          ]
        },
        condition: { ...commonCondition }
      },
      {
        id: RULE_ID_REFERER,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: `${JTT_ORIGIN}/` }
          ]
        },
        condition: { ...commonCondition }
      }
    ]
  });
}

/** Remove all auth-related session rules. */
async function clearAuthRules() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID_COOKIE, RULE_ID_ORIGIN, RULE_ID_REFERER]
  });
}

/**
 * Read JSESSIONID and atlassian.xsrf.token cookies from the browser cookie
 * store for the JTT domain.
 */
async function getJttCookies() {
  const cookies = await chrome.cookies.getAll({ domain: JTT_DOMAIN });
  let jsessionid = null;
  let xsrf = null;
  for (const c of cookies) {
    if (c.name === "JSESSIONID") jsessionid = c.value;
    if (c.name === "atlassian.xsrf.token") xsrf = c.value;
  }
  return { jsessionid, xsrf };
}

// ---------------------------------------------------------------------------
// Message handler – login.js communicates with this service worker
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "SET_AUTH") {
    setAuthRules(msg.cookieValue)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep channel open for async response
  }

  if (msg.type === "CLEAR_AUTH") {
    clearAuthRules()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "GET_COOKIES") {
    getJttCookies()
      .then((cookies) => sendResponse({ ok: true, ...cookies }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

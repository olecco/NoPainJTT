const statusEl = document.getElementById("status");
const monthLabelEl = document.getElementById("monthLabel");
const gridEl = document.getElementById("grid");
const prevMonthBtn = document.getElementById("prevMonth");
const nextMonthBtn = document.getElementById("nextMonth");
const logoutBtn = document.getElementById("logout");
const settingsBtn = document.getElementById("settings");
const nameEl = document.getElementById("name");
const passwordEl = document.getElementById("password");
const loginBtn = document.getElementById("login");
const api = globalThis.browser ?? globalThis.chrome;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function setAuthedUiEnabled(enabled) {
  if (logoutBtn) logoutBtn.disabled = !enabled;
  if (settingsBtn) settingsBtn.disabled = !enabled;
}

let worklogDates = new Set(); // YYYY-MM-DD
let worklogsByDate = new Map(); // YYYY-MM-DD -> Array<{ id: string|number }>
let currentMonth = new Date();
currentMonth.setDate(1);
currentMonth.setHours(0, 0, 0, 0);
let authCookieHeaderValue = null; // "JSESSIONID=...; atlassian.xsrf.token=..."
let holidaysByDate = new Map(); // YYYY-MM-DD -> holiday name (fname)
let fetchedHolidayYears = new Set(); // years already fetched

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymdLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function monthLabel(d) {
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}

// Monday=0 ... Sunday=6
function mondayIndex(jsDay) {
  return (jsDay + 6) % 7;
}

async function fetchHolidays(year) {
  if (fetchedHolidayYears.has(year)) return;
  try {
    const res = await fetch(`https://get.api-feiertage.de/?years=${year}&states=by`);
    const json = await res.json();
    if (json?.status === "success" && Array.isArray(json.feiertage)) {
      for (const day of json.feiertage) {
        if (day?.by === "1" && day?.date) {
          holidaysByDate.set(day.date, day.fname ?? "Holiday");
        }
      }
    }
    fetchedHolidayYears.add(year);
  } catch {
    // silently ignore – holidays just won't render
  }
}

function renderCalendar() {
  if (!gridEl || !monthLabelEl) return;

  monthLabelEl.textContent = monthLabel(currentMonth);
  gridEl.innerHTML = "";

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayKey = ymdLocal(now);
  const isAuthed = Boolean(authCookieHeaderValue);
  setAuthedUiEnabled(isAuthed);
  const realCurrentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  realCurrentMonthStart.setHours(0, 0, 0, 0);
  const currentWeekStart = new Date(now);
  currentWeekStart.setDate(now.getDate() - mondayIndex(now.getDay()));
  // If today is Monday, also keep previous week's weekdays open
  if (now.getDay() === 1) {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
  }
  currentWeekStart.setHours(0, 0, 0, 0);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = mondayIndex(first.getDay());

  const start = new Date(year, month, 1 - startOffset);
  start.setHours(0, 0, 0, 0);

  // 6 weeks grid
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);

    const cell = document.createElement("div");
    cell.className = "day";
    if (d.getTime() < realCurrentMonthStart.getTime()) cell.classList.add("mutedPrev");
    if (d.getTime() < currentWeekStart.getTime()) cell.classList.add("closedWeek");
    const dow = d.getDay(); // 0=Sun ... 6=Sat
    if (dow === 0 || dow === 6) cell.classList.add("weekend");

    const key = ymdLocal(d);
    if (worklogDates.has(key)) cell.classList.add("hasWorklog");
    if (key === todayKey) cell.classList.add("today");
    if (!isAuthed) cell.classList.add("disabled");

    const holidayName = holidaysByDate.get(key);
    if (holidayName) {
      cell.classList.add("holiday");
      cell.title = holidayName;
    }

    cell.textContent = String(d.getDate());
    cell.dataset.date = key;
    cell.tabIndex = 0;
    cell.setAttribute("role", "button");
    cell.setAttribute("aria-label", holidayName ? `${key} – ${holidayName}` : key);
    cell.setAttribute(
      "aria-disabled",
      String(!isAuthed || cell.classList.contains("weekend") || cell.classList.contains("closedWeek") || cell.classList.contains("holiday"))
    );
    gridEl.appendChild(cell);
  }
}

function upsertHeader(headers, name, value) {
  const lower = name.toLowerCase();
  const existing = headers.find((h) => String(h?.name ?? "").toLowerCase() === lower);
  if (existing) existing.value = value;
  else headers.push({ name, value });
}

function parseCookieValue(setCookieValue, cookieName) {
  if (!setCookieValue) return null;
  const firstPart = (String(setCookieValue).split(";", 1)[0] ?? "").trim();
  const idx = firstPart.indexOf("=");
  if (idx < 0) return null;
  const name = firstPart.slice(0, idx).trim().toLowerCase();
  if (name !== String(cookieName).toLowerCase()) return null;
  let value = firstPart.slice(idx + 1).trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function formatResponseHeaders(responseHeaders) {
  const lines = [];
  for (const h of responseHeaders ?? []) {
    const name = String(h?.name ?? "").trim();
    if (!name) continue;
    const value = typeof h?.value === "string" ? h.value : "";
    lines.push(`${name}: ${value}`);
  }
  return lines.join("\n");
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractCookieFromSetCookieBlob(blob, cookieName) {
  if (!blob) return null;
  const re = new RegExp(`${escapeRegExp(cookieName)}=([^;\\r\\n]+)`, "i");
  const m = String(blob).match(re);
  return m?.[1] ?? null;
}

async function fetchWorklogsAndRender() {
  if (!authCookieHeaderValue) {
    setStatus("Not authenticated.");
    return;
  }
  if (!api?.webRequest?.onBeforeSendHeaders) {
    throw new Error("webRequest API not available");
  }

  const listUrl = "https://jtt.in.devexperts.com/v1/api/worklogs/list".trim();
  const cookieListener = (details) => {
    const headers = details.requestHeaders ?? [];
    upsertHeader(headers, "Cookie", authCookieHeaderValue);
    upsertHeader(headers, "Origin", "https://jtt.in.devexperts.com");
    upsertHeader(headers, "Referer", "https://jtt.in.devexperts.com/");
    return { requestHeaders: headers };
  };

  api.webRequest.onBeforeSendHeaders.addListener(
    cookieListener,
    { urls: [listUrl] },
    ["blocking", "requestHeaders"]
  );

  try {
    const listRes = await fetch(listUrl, { method: "GET" });
    const bodyText = await listRes.text().catch(() => "");
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = null;
    }

    const worklogs = Array.isArray(json?.worklogs) ? json.worklogs : [];
    const byDate = new Map();
    for (const w of worklogs) {
      const id = w?.id;
      const t = w?.startTime;
      const d = new Date(t);
      if (Number.isNaN(d.getTime())) continue;
      const key = ymdLocal(d); // local date key to match calendar clicks
      const arr = byDate.get(key) ?? [];
      arr.push({ id });
      byDate.set(key, arr);
    }

    worklogsByDate = byDate;
    worklogDates = new Set(byDate.keys());
    renderCalendar();
    setStatus(`Loaded ${worklogDates.size} worklog day(s).`);
  } finally {
    api.webRequest.onBeforeSendHeaders.removeListener(cookieListener);
  }
}

async function deleteWorklogsForDate(dateKey) {
  if (!authCookieHeaderValue) {
    setStatus("Not authenticated.");
    return;
  }
  if (!api?.webRequest?.onBeforeSendHeaders) {
    throw new Error("webRequest API not available");
  }

  const items = worklogsByDate.get(dateKey) ?? [];
  for (const item of items) {
    const id = item?.id;
    if (id == null || id === "") continue;

    const delUrl = `https://jtt.in.devexperts.com/v1/api/worklogs/${id}`.trim();
    const delListener = (details) => {
      const headers = details.requestHeaders ?? [];
      upsertHeader(headers, "Cookie", authCookieHeaderValue);
      upsertHeader(headers, "Origin", "https://jtt.in.devexperts.com");
      upsertHeader(headers, "Referer", "https://jtt.in.devexperts.com/");
      return { requestHeaders: headers };
    };

    api.webRequest.onBeforeSendHeaders.addListener(
      delListener,
      { urls: [delUrl] },
      ["blocking", "requestHeaders"]
    );

    try {
      const res = await fetch(delUrl, { method: "DELETE" });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`DELETE ${id} failed (HTTP ${res.status}) ${t}`);
      }
    } finally {
      api.webRequest.onBeforeSendHeaders.removeListener(delListener);
    }
  }
}

async function createWorklogForDate(dateKey, issueKey) {
  if (!authCookieHeaderValue) {
    setStatus("Not authenticated.");
    return;
  }

  const [y, m, d] = String(dateKey).split("-").map((x) => Number(x));
  if (!y || !m || !d) throw new Error("Invalid date");

  // Local timezone: 09:00 -> 17:00, serialized as UTC instants.
  const startLocal = new Date(y, m - 1, d, 9, 0, 0, 0);
  const endLocal = new Date(y, m - 1, d, 17, 0, 0, 0);

  const postUrl = "https://jtt.in.devexperts.com/v1/api/worklogs/".trim();
  const payload = {
    comment: "",
    endTime: endLocal.toISOString(),
    issueKey: issueKey,
    startTime: startLocal.toISOString()
  };

  const postListener = (details) => {
    const headers = details.requestHeaders ?? [];
    upsertHeader(headers, "Cookie", authCookieHeaderValue);
    upsertHeader(headers, "Origin", "https://jtt.in.devexperts.com");
    upsertHeader(headers, "Content-Type", "application/json");
    upsertHeader(headers, "Referer", "https://jtt.in.devexperts.com/");
    return { requestHeaders: headers };
  };

  api.webRequest.onBeforeSendHeaders.addListener(
    postListener,
    { urls: [postUrl] },
    ["blocking", "requestHeaders"]
  );

  try {
    const res = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`POST failed (HTTP ${res.status}) ${t}`);
    }
  } finally {
    api.webRequest.onBeforeSendHeaders.removeListener(postListener);
  }
}

async function login() {
  const user = nameEl?.value ?? "";
  const password = passwordEl?.value ?? "";

  if (api?.storage?.local) {
    api.storage.local.set({ savedUsername: user }).catch(() => {});
  }

  setStatus("Sending...");
  loginBtn.disabled = true;
  try {
    if (!api?.webRequest?.onBeforeSendHeaders || !api?.webRequest?.onHeadersReceived) {
      throw new Error("webRequest API not available");
    }

    const targetUrl = "https://jtt.in.devexperts.com/v1/api/auth";
    const cookiesPromise = new Promise((resolve) => {
      const onHeaders = (details) => {
        if (details.url !== targetUrl) return;
        if (details.method !== "POST") return;

        const responseHeaders = details.responseHeaders ?? [];
        const setCookieHeaders = responseHeaders.filter(
          (h) => String(h?.name ?? "").toLowerCase() === "set-cookie"
        );

        let jsessionid = null;
        let xsrf = null;
        for (const h of setCookieHeaders) {
          const v = typeof h?.value === "string" ? h.value : null;
          if (jsessionid == null) jsessionid = parseCookieValue(v, "JSESSIONID");
          if (xsrf == null) xsrf = parseCookieValue(v, "atlassian.xsrf.token");
        }

        api.webRequest.onHeadersReceived.removeListener(onHeaders);
        resolve({
          jsessionid,
          xsrf,
          responseHeaders
        });
      };

      api.webRequest.onHeadersReceived.addListener(
        onHeaders,
        { urls: [targetUrl] },
        ["responseHeaders"]
      );
    });

    const listener = (details) => {
      const headers = details.requestHeaders ?? [];
      upsertHeader(headers, "Content-Type", "application/json");
      upsertHeader(headers, "Origin", "https://jtt.in.devexperts.com");
      upsertHeader(headers, "Referer", "https://jtt.in.devexperts.com/login");
      return { requestHeaders: headers };
    };

    api.webRequest.onBeforeSendHeaders.addListener(
      listener,
      { urls: [targetUrl] },
      ["blocking", "requestHeaders"]
    );

    let res;
    let cookieInfo;
    try {
      res = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password, user })
      });
      cookieInfo = await cookiesPromise;
    } finally {
      api.webRequest.onBeforeSendHeaders.removeListener(listener);
    }

    const responseHeaders = cookieInfo?.responseHeaders ?? [];
    const setCookieValues = responseHeaders
      .filter((h) => String(h?.name ?? "").toLowerCase() === "set-cookie")
      .map((h) => (typeof h?.value === "string" ? h.value : ""))
      .filter(Boolean);
    const setCookieBlob = setCookieValues.join("\n");

    const jsessionid = extractCookieFromSetCookieBlob(setCookieBlob, "JSESSIONID") ?? "<not found>";
    const xsrf =
      extractCookieFromSetCookieBlob(setCookieBlob, "atlassian.xsrf.token") ?? "<not found>";

    if (jsessionid !== "<not found>" && xsrf !== "<not found>") {
      authCookieHeaderValue = `JSESSIONID=${jsessionid}; atlassian.xsrf.token=${xsrf}`;
      await fetchHolidays(currentMonth.getFullYear());
      await fetchWorklogsAndRender();
    }

    setStatus(`Done (HTTP ${res.status}).`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    alert(`Request failed: ${msg}`);
    setStatus("Request failed.");
  } finally {
    loginBtn.disabled = false;
  }
}

prevMonthBtn?.addEventListener("click", async () => {
  currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
  if (authCookieHeaderValue) await fetchHolidays(currentMonth.getFullYear());
  renderCalendar();
});

nextMonthBtn?.addEventListener("click", async () => {
  currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
  if (authCookieHeaderValue) await fetchHolidays(currentMonth.getFullYear());
  renderCalendar();
});

let pressedCell = null;
function setPressedCell(el) {
  if (pressedCell && pressedCell !== el) pressedCell.classList.remove("pressed");
  pressedCell = el;
  if (pressedCell) pressedCell.classList.add("pressed");
}

gridEl?.addEventListener("pointerdown", (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const cell = target.closest?.(".day");
  if (!(cell instanceof HTMLElement)) return;
  if (!authCookieHeaderValue) return;
  if (cell.classList.contains("mutedPrev") || cell.classList.contains("closedWeek") || cell.classList.contains("holiday")) return;
  setPressedCell(cell);
});

function clearPressed() {
  if (pressedCell) pressedCell.classList.remove("pressed");
  pressedCell = null;
}

gridEl?.addEventListener("pointerup", clearPressed);
gridEl?.addEventListener("pointercancel", clearPressed);
gridEl?.addEventListener("pointerleave", clearPressed);

gridEl?.addEventListener("click", async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const cell = target.closest?.(".day");
  if (!(cell instanceof HTMLElement)) return;
  if (cell.classList.contains("holiday")) {
    const hName = holidaysByDate.get(cell.dataset.date) ?? "Holiday";
    setStatus(`${hName} – no tracking.`);
    return;
  }
  if (cell.classList.contains("mutedPrev") || cell.classList.contains("closedWeek")) {
    setStatus("Tracking for this date is closed");
    return;
  }
  if (!authCookieHeaderValue) {
    setStatus("Login first.");
    return;
  }

  const dateKey = cell.dataset.date;
  if (!dateKey) return;

  const [yy, mm, dd] = String(dateKey).split("-").map((x) => Number(x));
  if (!yy || !mm || !dd) return;

  const clicked = new Date(yy, mm - 1, dd, 0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Block weekends (Sat/Sun) and future dates (tomorrow+), local time.
  const dow = clicked.getDay(); // 0=Sun ... 6=Sat
  if (dow === 0 || dow === 6) {
    setStatus("Weekend selected (no action).");
    return;
  }
  if (clicked.getTime() > today.getTime()) {
    setStatus("Future date selected (no action).");
    return;
  }

  try {
    if (worklogDates.has(dateKey)) {
      setStatus(`Deleting worklogs for ${dateKey}...`);
      await deleteWorklogsForDate(dateKey);
      await fetchWorklogsAndRender();
      setStatus(`Deleted for ${dateKey}.`);
    } else {
      let jiraTicketKey = null;
      if (api?.storage?.local) {
        try {
          const res = await api.storage.local.get(["jiraTicketKey"]);
          jiraTicketKey = res?.jiraTicketKey;
        } catch {}
      }
      if (!jiraTicketKey) {
        setStatus("Please set a Jira ticket to track first.");
        document.getElementById("settingsDropdown")?.classList.add("open");
        document.getElementById("jiraTicket")?.focus();
        return;
      }
      setStatus(`Creating worklog for ${dateKey}...`);
      await createWorklogForDate(dateKey, jiraTicketKey);
      await fetchWorklogsAndRender();
      setStatus(`Created for ${dateKey}.`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    alert(msg);
    setStatus("Action failed.");
  }
});

loginBtn?.addEventListener("click", login);

function onEnterLogin(e) {
  if (e.key === "Enter") login();
}
nameEl?.addEventListener("keydown", onEnterLogin);
passwordEl?.addEventListener("keydown", onEnterLogin);
setStatus("Ready.");
renderCalendar();

logoutBtn?.addEventListener("click", () => {
  const cookie = authCookieHeaderValue;

  // Immediately go to logged-out UI state.
  authCookieHeaderValue = null;
  worklogDates = new Set();
  worklogsByDate = new Map();
  holidaysByDate = new Map();
  fetchedHolidayYears = new Set();
  clearPressed();
  renderCalendar();
  setStatus("Logged out.");

  // Fire-and-forget logout request (best effort).
  if (cookie && api?.webRequest?.onBeforeSendHeaders) {
    const url = "https://jtt.in.devexperts.com/v1/api/auth".trim();
    const logoutListener = (details) => {
      const headers = details.requestHeaders ?? [];
      upsertHeader(headers, "Cookie", cookie);
      upsertHeader(headers, "Origin", "https://jtt.in.devexperts.com");
      upsertHeader(headers, "Referer", "https://jtt.in.devexperts.com/");
      return { requestHeaders: headers };
    };

    api.webRequest.onBeforeSendHeaders.addListener(
      logoutListener,
      { urls: [url] },
      ["blocking", "requestHeaders"]
    );

    fetch(url, { method: "DELETE" })
      .catch(() => {})
      .finally(() => {
        api.webRequest.onBeforeSendHeaders.removeListener(logoutListener);
      });
  }
});

// ---------------------------------------------------------------------------
// Settings dropdown
// ---------------------------------------------------------------------------
const settingsDropdown = document.getElementById("settingsDropdown");
const settingsCloseBtn = document.getElementById("settingsClose");
const jiraTicketEl = document.getElementById("jiraTicket");
const ticketSuggestionsEl = document.getElementById("ticketSuggestions");

settingsBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsDropdown?.classList.toggle("open");
});

settingsCloseBtn?.addEventListener("click", () => {
  settingsDropdown?.classList.remove("open");
});

document.addEventListener("click", (e) => {
  if (settingsDropdown?.classList.contains("open")) {
    const wrap = document.getElementById("settingsWrap");
    if (wrap && !wrap.contains(e.target)) {
      settingsDropdown.classList.remove("open");
    }
  }
  // Close suggestions if clicking outside
  if (ticketSuggestionsEl?.classList.contains("open")) {
    const ticketWrap = document.getElementById("jiraTicketWrap");
    if (ticketWrap && !ticketWrap.contains(e.target)) {
      ticketSuggestionsEl.classList.remove("open");
    }
  }
});

// ---------------------------------------------------------------------------
// Ticket search
// ---------------------------------------------------------------------------
let searchTimer = null;

async function searchTickets(query) {
  if (!authCookieHeaderValue) return [];
  if (!api?.webRequest?.onBeforeSendHeaders) return [];

  const searchUrl = "https://jtt.in.devexperts.com/v1/api/tickets/search";
  const listener = (details) => {
    const headers = details.requestHeaders ?? [];
    upsertHeader(headers, "Cookie", authCookieHeaderValue);
    upsertHeader(headers, "Origin", "https://jtt.in.devexperts.com");
    upsertHeader(headers, "Content-Type", "application/json");
    upsertHeader(headers, "Referer", "https://jtt.in.devexperts.com/");
    return { requestHeaders: headers };
  };

  api.webRequest.onBeforeSendHeaders.addListener(
    listener,
    { urls: [searchUrl] },
    ["blocking", "requestHeaders"]
  );

  try {
    const res = await fetch(searchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searchString: query })
    });
    const text = await res.text().catch(() => "");
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return Array.isArray(json?.issues) ? json.issues : [];
  } finally {
    api.webRequest.onBeforeSendHeaders.removeListener(listener);
  }
}

function renderSuggestions(issues) {
  if (!ticketSuggestionsEl) return;
  ticketSuggestionsEl.innerHTML = "";
  const limited = issues.slice(0, 10);
  if (limited.length === 0) {
    ticketSuggestionsEl.classList.remove("open");
    return;
  }
  for (const issue of limited) {
    const key = issue?.key ?? "";
    const summary = issue?.summary ?? "";
    const li = document.createElement("li");
    const formattedHtml = `<span class="hl-key">${key}</span> ${summary}`;
    li.innerHTML = formattedHtml;
    li.title = `${key} ${summary}`;
    li.addEventListener("click", () => {
      if (jiraTicketEl) jiraTicketEl.innerHTML = formattedHtml;
      ticketSuggestionsEl.classList.remove("open");
      // Save to extension storage
      const storage = api?.storage?.local;
      if (storage) {
        try {
          const promise = storage.set({ jiraTicketKey: key, jiraTicketSummary: summary });
          const verify = () => {
            const getPromise = storage.get(["jiraTicketKey"]);
            if (getPromise && getPromise.then) {
              getPromise.then((res) => {
                if (!res || !res.jiraTicketKey) {
                  setStatus("Error: Failed to save Jira ticket to storage.");
                } else {
                  setStatus("Jira ticket saved to storage.");
                }
              }).catch((e) => setStatus("Error verifying ticket: " + e.message));
            }
          };
          
          if (promise && promise.then) {
            promise.then(verify).catch((e) => setStatus("Error saving ticket: " + e.message));
          } else {
            // Fallback if no promise returned (e.g. some older Chrome versions)
            setTimeout(verify, 100);
          }
        } catch (e) {
          setStatus("Error saving ticket: " + e.message);
        }
      } else {
        setStatus("Error: Extension storage not available. Check permissions.");
      }
    });
    ticketSuggestionsEl.appendChild(li);
  }
  ticketSuggestionsEl.classList.add("open");
}

jiraTicketEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
  }
});

jiraTicketEl?.addEventListener("input", () => {
  const value = jiraTicketEl.textContent.trim();
  if (searchTimer) clearTimeout(searchTimer);
  if (!value) {
    ticketSuggestionsEl?.classList.remove("open");
    if (api?.storage?.local) {
      try {
        const p = api.storage.local.remove(["jiraTicketKey", "jiraTicketSummary"]);
        if (p && p.catch) p.catch(() => {});
        setStatus("Jira ticket tracking cleared.");
      } catch (e) {}
    }
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const issues = await searchTickets(value);
      renderSuggestions(issues);
    } catch {
      ticketSuggestionsEl?.classList.remove("open");
    }
  }, 300);
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
if (api?.storage?.local) {
  api.storage.local.get(["jiraTicketKey", "jiraTicketSummary", "savedUsername"]).then((res) => {
    if (res.jiraTicketKey && jiraTicketEl) {
      const key = res.jiraTicketKey;
      const summary = res.jiraTicketSummary || "";
      jiraTicketEl.innerHTML = `<span class="hl-key">${key}</span> ${summary}`;
    }
    if (res.savedUsername && nameEl) {
      nameEl.value = res.savedUsername;
    }
  }).catch(() => {});
}

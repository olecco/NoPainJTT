const statusEl = document.getElementById("status");
const monthLabelEl = document.getElementById("monthLabel");
const gridEl = document.getElementById("grid");
const prevMonthBtn = document.getElementById("prevMonth");
const nextMonthBtn = document.getElementById("nextMonth");
const logoutBtn = document.getElementById("logout");
const nameEl = document.getElementById("name");
const passwordEl = document.getElementById("password");
const loginBtn = document.getElementById("login");

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function setAuthedUiEnabled(enabled) {
  if (logoutBtn) logoutBtn.disabled = !enabled;
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

// ---------------------------------------------------------------------------
// Service-worker messaging helpers
// ---------------------------------------------------------------------------

/** Send a message to the background service worker and return the response. */
function sendBg(msg) {
  return chrome.runtime.sendMessage(msg);
}

/**
 * Ask the service worker to install declarativeNetRequest session rules that
 * inject Cookie, Origin, and Referer on every extension→JTT request.
 */
async function activateAuthRules(cookieValue) {
  const res = await sendBg({ type: "SET_AUTH", cookieValue });
  if (!res?.ok) throw new Error(res?.error ?? "SET_AUTH failed");
}

/** Ask the service worker to remove all auth session rules. */
async function deactivateAuthRules() {
  const res = await sendBg({ type: "CLEAR_AUTH" });
  if (!res?.ok) throw new Error(res?.error ?? "CLEAR_AUTH failed");
}

/**
 * Read JSESSIONID + xsrf token from the browser cookie store via the service
 * worker (which has the cookies permission).
 */
async function readJttCookies() {
  const res = await sendBg({ type: "GET_COOKIES" });
  if (!res?.ok) throw new Error(res?.error ?? "GET_COOKIES failed");
  return { jsessionid: res.jsessionid, xsrf: res.xsrf };
}

// ---------------------------------------------------------------------------
// API helpers (fetch calls – headers injected by DNR session rules)
// ---------------------------------------------------------------------------

async function fetchWorklogsAndRender() {
  if (!authCookieHeaderValue) {
    setStatus("Not authenticated.");
    return;
  }

  const listUrl = "https://jtt.in.devexperts.com/v1/api/worklogs/list";

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
}

async function deleteWorklogsForDate(dateKey) {
  if (!authCookieHeaderValue) {
    setStatus("Not authenticated.");
    return;
  }

  const items = worklogsByDate.get(dateKey) ?? [];
  for (const item of items) {
    const id = item?.id;
    if (id == null || id === "") continue;

    const delUrl = `https://jtt.in.devexperts.com/v1/api/worklogs/${id}`;
    const res = await fetch(delUrl, { method: "DELETE" });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`DELETE ${id} failed (HTTP ${res.status}) ${t}`);
    }
  }
}

async function createWorklogForDate(dateKey) {
  if (!authCookieHeaderValue) {
    setStatus("Not authenticated.");
    return;
  }

  const [y, m, d] = String(dateKey).split("-").map((x) => Number(x));
  if (!y || !m || !d) throw new Error("Invalid date");

  // Local timezone: 09:00 -> 17:00, serialized as UTC instants.
  const startLocal = new Date(y, m - 1, d, 9, 0, 0, 0);
  const endLocal = new Date(y, m - 1, d, 17, 0, 0, 0);

  const postUrl = "https://jtt.in.devexperts.com/v1/api/worklogs/";
  const payload = {
    comment: "",
    endTime: endLocal.toISOString(),
    issueKey: "TDAT-21",
    startTime: startLocal.toISOString()
  };

  const res = await fetch(postUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`POST failed (HTTP ${res.status}) ${t}`);
  }
}

// ---------------------------------------------------------------------------
// Login / Logout
// ---------------------------------------------------------------------------

async function login() {
  const user = nameEl?.value ?? "";
  const password = passwordEl?.value ?? "";

  setStatus("Sending...");
  loginBtn.disabled = true;
  try {
    const targetUrl = "https://jtt.in.devexperts.com/v1/api/auth";

    // 1. POST login credentials (no auth cookie needed for this request,
    //    but we still need Origin/Referer so set temporary rules).
    await activateAuthRules("__login_pending__");

    let res;
    try {
      res = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, user })
      });
    } catch (fetchErr) {
      await deactivateAuthRules();
      throw fetchErr;
    }

    if (!res.ok) {
      await deactivateAuthRules();
      const t = await res.text().catch(() => "");
      throw new Error(`Login failed (HTTP ${res.status}) ${t}`);
    }

    // 2. Read cookies set by the server from the browser cookie store.
    const { jsessionid, xsrf } = await readJttCookies();

    if (!jsessionid || !xsrf) {
      await deactivateAuthRules();
      throw new Error(
        `Missing cookies after login. JSESSIONID=${jsessionid ?? "<not found>"}, xsrf=${xsrf ?? "<not found>"}`
      );
    }

    // 3. Install proper auth rules with real cookie values.
    authCookieHeaderValue = `JSESSIONID=${jsessionid}; atlassian.xsrf.token=${xsrf}`;
    await activateAuthRules(authCookieHeaderValue);

    // 4. Fetch worklogs.
    await fetchHolidays(currentMonth.getFullYear());
    await fetchWorklogsAndRender();

    setStatus(`Done (HTTP ${res.status}).`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    alert(`Request failed: ${msg}`);
    setStatus("Request failed.");
  } finally {
    loginBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// UI event handlers
// ---------------------------------------------------------------------------

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
      setStatus(`Creating worklog for ${dateKey}...`);
      await createWorklogForDate(dateKey);
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

  // Fire-and-forget logout request (best effort), then clear rules.
  if (cookie) {
    const url = "https://jtt.in.devexperts.com/v1/api/auth";
    fetch(url, { method: "DELETE" })
      .catch(() => {})
      .finally(() => {
        deactivateAuthRules().catch(() => {});
      });
  }
});

// Runs a fill job: navigates the App Store Connect tab between the live
// version and the version in preparation, and asks the page script to read
// or write. The job status lives in chrome.storage.session so the popup can
// be closed and reopened while it runs.

import { getVersion, saveVersion } from "./history.js";

const ASC = "https://appstoreconnect.apple.com";

const versionUrl = (appId, platform, page) => `${ASC}/apps/${appId}/distribution/${platform}/version/${page}`;

function setStatus(state, text, extra = {}) {
  return chrome.storage.session.set({ job: { state, text, ...extra, at: Date.now() } });
}

async function send(tabId, cmd, args) {
  const response = await chrome.tabs.sendMessage(tabId, { cmd, args });
  if (!response?.ok) throw new Error(response?.error ?? "No answer from the page.");
  return response.result;
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Load `url` in the tab unless it is already there, then wait for the
// version form. The page script may not be injected yet right after load.
async function open(tabId, url) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith(url)) {
    const loaded = waitForLoad(tabId);
    await chrome.tabs.update(tabId, { url });
    await loaded;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(tabId, "ready");
    } catch (error) {
      if (attempt >= 10 || !/Receiving end|Could not establish/.test(error.message)) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function remember(ctx, snapshot) {
  if (!snapshot.version) return null;
  return saveVersion({
    appId: ctx.appId,
    appName: ctx.appName,
    platform: ctx.platform,
    version: snapshot.version,
    texts: snapshot.texts,
  });
}

// source: { kind: "live" } | { kind: "version", id }
async function runFill({ tabId, appId, platform, fields, source }) {
  let texts;
  if (source.kind === "live") {
    await setStatus("running", "Opening the live version…");
    const ctx = await open(tabId, versionUrl(appId, platform, "deliverable"));
    const live = await send(tabId, "capture");
    await remember(ctx, live);
    texts = live.texts;
  } else if (source.kind === "version") {
    const entry = await getVersion(source.id);
    if (!entry) throw new Error("This version is no longer in the history.");
    texts = entry.texts;
  }

  await setStatus("running", "Opening the version in preparation…");
  const ctx = await open(tabId, versionUrl(appId, platform, "inflight"));
  if (ctx?.page !== "inflight") throw new Error("No version in preparation. Create one in App Store Connect first.");

  const result = await send(tabId, "fill", { fields, texts });
  await remember(ctx, result);

  if (!result.filled.length) throw new Error("Nothing to paste: the source has no text for these languages.");
  const skipped = result.missing.length ? ` Skipped (no text): ${result.missing.join(", ")}.` : "";
  await setStatus("done", `Filled ${result.filled.length} languages. Review, then click Save.${skipped}`);
}

// Toolbar icon: orange on App Store Connect, gray elsewhere.
const ICONS = {
  on: { 16: "/icons/16.png", 32: "/icons/32.png" },
  off: { 16: "/icons/off/16.png", 32: "/icons/off/32.png" },
};

function paintIcon(tabId, url) {
  const on = url?.startsWith(`${ASC}/`);
  chrome.action.setIcon({ tabId, path: on ? ICONS.on : ICONS.off }).catch((error) => {
    // A tab closed in the meantime is fine; anything else is a bug.
    if (!/No tab with id/.test(error.message)) console.error("[ASC Fill] setIcon:", error);
  });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status) paintIcon(tabId, tab.url);
});

// Tabs already open when the extension starts.
chrome.tabs.query({}).then((tabs) => tabs.forEach((tab) => paintIcon(tab.id, tab.url)));

const jobs = { fill: runFill };

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "progress" && sender.tab) {
    setStatus("running", message.text);
  } else if (message?.type === "job" && jobs[message.job]) {
    jobs[message.job](message.args).catch((error) => setStatus("error", error.message));
  }
  return false;
});

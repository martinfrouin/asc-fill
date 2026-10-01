import { FIELDS, listVersions, deleteVersion, languageCount } from "../src/history.js";
import { LINKS } from "../src/links.js";

const $ = (id) => document.getElementById(id);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const match = tab?.url?.match(
  /^https:\/\/appstoreconnect\.apple\.com\/apps\/(\d+)(?:\/distribution\/([^/]+)(?:\/version\/([^/?#]+))?)?/,
);

renderLinks();

if (!match) {
  $("away").hidden = false;
} else {
  const [, appId, urlPlatform, page] = match;
  // The tab title is "<App> - App Store Connect" on some pages, just
  // "App Store Connect" on others.
  const titlePart = tab.title?.split(/\s[-–|]\s/)[0]?.trim();
  const appName = titlePart === "App Store Connect" ? null : titlePart;
  const prefs = (await chrome.storage.local.get("prefs")).prefs ?? {};
  let platform = urlPlatform ?? prefs.platform ?? "ios";
  let fields = prefs.fields ?? [...FIELDS];
  let source = { kind: "live" };

  $("tool").hidden = false;
  $("app").hidden = !appName;
  $("app").textContent = appName ?? "";
  $("platform").value = platform;
  $("capture").hidden = !page;

  const savePrefs = () => chrome.storage.local.set({ prefs: { platform, fields } });

  for (const box of $("fields").querySelectorAll("input")) {
    box.checked = fields.includes(box.value);
    box.addEventListener("change", () => {
      fields = FIELDS.filter((f) => $("fields").querySelector(`[value="${f}"]`).checked);
      savePrefs();
      renderSources();
    });
  }

  $("platform").addEventListener("change", () => {
    platform = $("platform").value;
    source = { kind: "live" };
    savePrefs();
    renderSources();
  });

  async function renderSources() {
    const versions = await listVersions(appId, platform);
    if (source.kind === "version" && !versions.some((v) => v.id === source.id)) source = { kind: "live" };

    const items = [
      { key: "live", source: { kind: "live" }, title: "Live version", meta: "On the App Store" },
      { key: "primary", source: { kind: "primary" }, title: "Primary language", meta: "To every language" },
      ...versions.map((v) => ({
        key: v.id,
        source: { kind: "version", id: v.id },
        title: v.version,
        meta: `${formatDate(v.savedAt)} · ${languageCount(v, fields)} lang.`,
        removable: true,
      })),
    ];

    $("sources").replaceChildren(
      ...items.map((item) => {
        const li = document.createElement("li");
        const label = document.createElement("label");
        const radio = Object.assign(document.createElement("input"), { type: "radio", name: "source" });
        radio.checked = sameSource(item.source, source);
        radio.addEventListener("change", () => (source = item.source));
        const title = Object.assign(document.createElement("span"), { className: "title", textContent: item.title });
        const meta = Object.assign(document.createElement("span"), { className: "meta", textContent: item.meta });
        if (item.source.kind === "version") title.classList.add("mono");
        label.append(radio, title, meta);
        li.append(label);
        if (item.removable) {
          const remove = Object.assign(document.createElement("button"), {
            className: "remove",
            title: "Remove from history",
            textContent: "×",
          });
          remove.addEventListener("click", async () => {
            await deleteVersion(item.source.id);
            renderSources();
          });
          li.append(remove);
        }
        return li;
      }),
    );
    updateButtons();
  }

  function startJob(job, args) {
    chrome.storage.session.set({ job: { state: "running", text: "Starting…", at: Date.now() } });
    chrome.runtime.sendMessage({ type: "job", job, args: { tabId: tab.id, ...args } });
  }

  $("fill").addEventListener("click", () => startJob("fill", { appId, platform, fields, source }));
  $("capture").addEventListener("click", () => startJob("capture", {}));

  let running = false;
  function updateButtons() {
    $("fill").disabled = running || !fields.length;
    $("capture").disabled = running;
  }

  function showJob(job) {
    running = job?.state === "running";
    $("status").hidden = !job;
    if (job) {
      $("status").className = job.state;
      $("status").textContent = job.text;
    }
    updateButtons();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.job) showJob(changes.job.newValue);
    if (area === "local" && changes.versions) renderSources();
  });

  // A job left "running" for a minute without news has died with its tab.
  const { job } = await chrome.storage.session.get("job");
  showJob(job?.state === "running" && Date.now() - job.at > 60_000 ? null : job);
  renderSources();
}

function sameSource(a, b) {
  return a.kind === b.kind && a.id === b.id;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function renderLinks() {
  const links = [
    ["GitHub", LINKS.github],
    ["Chrome Web Store", LINKS.chromeWebStore],
    ["Buy me a coffee ☕", LINKS.donate],
  ].filter(([, url]) => url);
  $("links").replaceChildren(
    ...links.map(([text, href]) => Object.assign(document.createElement("a"), { text, href, target: "_blank" })),
  );
}

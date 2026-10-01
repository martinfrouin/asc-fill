import { FIELDS, FIELD_LABELS, listVersions, deleteVersion, languageCount } from "../src/history.js";
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
  const [, appId, urlPlatform] = match;
  const prefs = (await chrome.storage.local.get("prefs")).prefs ?? {};
  let platform = urlPlatform ?? prefs.platform ?? "ios";
  let fields = prefs.fields ?? [...FIELDS];
  let source = { kind: "live" };
  let versions = [];
  let previewLang = null;

  $("tool").hidden = false;
  $("platform").value = platform;

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
    checkInflight();
  });

  async function renderSources() {
    versions = await listVersions(appId, platform);
    if (source.kind === "version" && !versions.some((v) => v.id === source.id)) source = { kind: "live" };

    const items = [
      { key: "live", source: { kind: "live" }, title: "Live version", meta: "On the App Store" },
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
        radio.addEventListener("change", () => {
          source = item.source;
          renderPreview();
        });
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
    renderPreview();
    updateButtons();
  }

  // Texts of the selected history version, one language at a time.
  function renderPreview() {
    const entry = source.kind === "version" && versions.find((v) => v.id === source.id);
    $("preview").hidden = !entry || !fields.length;
    if ($("preview").hidden) return;

    const langs = [...new Set(fields.flatMap((f) => Object.keys(entry.texts[f] ?? {})))];
    if (!langs.includes(previewLang)) previewLang = langs[0] ?? null;
    $("previewLang").replaceChildren(
      ...langs.map((lang) => new Option(lang, lang, false, lang === previewLang)),
    );

    $("previewTexts").replaceChildren(
      ...fields.map((field) => {
        const block = Object.assign(document.createElement("div"), { className: "text" });
        const label = Object.assign(document.createElement("span"), { className: "meta", textContent: FIELD_LABELS[field] });
        const text = entry.texts[field]?.[previewLang]?.trim();
        const body = Object.assign(document.createElement("p"), { textContent: text || "—" });
        if (!text) body.className = "empty";
        block.append(label, body);
        return block;
      }),
    );
  }

  $("previewLang").addEventListener("change", () => {
    previewLang = $("previewLang").value;
    renderPreview();
  });

  function startJob(job, args) {
    chrome.storage.session.set({ job: { state: "running", text: "Starting…", at: Date.now() } });
    chrome.runtime.sendMessage({ type: "job", job, args: { tabId: tab.id, ...args } });
  }

  $("fill").addEventListener("click", () => startJob("fill", { appId, platform, fields, source }));

  // Whether the platform has a version in preparation: null while unknown.
  let inflight = null;
  async function checkInflight() {
    const asked = platform;
    inflight = null;
    let answer = null;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { cmd: "hasInflight", args: { platform } });
      answer = response?.ok ? response.result : null;
    } catch {
      // Page script not injected (tab opened before install): don't block.
    }
    if (asked !== platform) return;
    inflight = answer;
    const name = $("platform").selectedOptions[0].textContent;
    $("noVersion").textContent = `No ${name} version in preparation.`;
    $("noVersion").hidden = inflight !== false;
    updateButtons();
  }

  let running = false;
  function updateButtons() {
    $("fill").disabled = running || !fields.length || inflight === false;
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
  checkInflight();
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

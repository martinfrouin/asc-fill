// Version history, kept in chrome.storage.local under "versions".
// One entry per app + platform + version; only the latest MAX_PER_APP
// entries of each app + platform are kept.

export const FIELDS = ["whatsNew", "promotionalText"];
export const FIELD_LABELS = { whatsNew: "What's New", promotionalText: "Promotional Text" };

const KEY = "versions";
const MAX_PER_APP = 10;

export async function listVersions(appId, platform) {
  const { [KEY]: all = [] } = await chrome.storage.local.get(KEY);
  return all
    .filter((v) => v.appId === appId && v.platform === platform)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function getVersion(id) {
  const { [KEY]: all = [] } = await chrome.storage.local.get(KEY);
  return all.find((v) => v.id === id) ?? null;
}

// Insert or replace the entry for this app/platform/version, then trim.
export async function saveVersion({ appId, appName, platform, version, texts }) {
  const { [KEY]: all = [] } = await chrome.storage.local.get(KEY);
  const id = `${appId}:${platform}:${version}`;
  const previous = all.find((v) => v.id === id);
  const entry = {
    id,
    appId,
    appName: appName || previous?.appName || "",
    platform,
    version,
    // A partial capture (some fields only) keeps the other fields' texts.
    texts: { ...previous?.texts, ...texts },
    savedAt: new Date().toISOString(),
  };

  const others = all.filter((v) => v.id !== id);
  const siblings = others
    .filter((v) => v.appId === appId && v.platform === platform)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  const dropped = new Set(siblings.slice(MAX_PER_APP - 1).map((v) => v.id));

  await chrome.storage.local.set({
    [KEY]: [entry, ...others.filter((v) => !dropped.has(v.id))],
  });
  return entry;
}

export async function deleteVersion(id) {
  const { [KEY]: all = [] } = await chrome.storage.local.get(KEY);
  await chrome.storage.local.set({ [KEY]: all.filter((v) => v.id !== id) });
}

export function languageCount(entry, fields) {
  const langs = new Set();
  for (const field of fields) {
    for (const [lang, text] of Object.entries(entry.texts[field] ?? {})) {
      if (text.trim()) langs.add(lang);
    }
  }
  return langs.size;
}

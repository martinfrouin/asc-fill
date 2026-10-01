// Runs on App Store Connect. Reads and writes the localized version texts
// by driving the page itself: the language menu and the form fields.
// Only stable attributes are used (name, role, aria-*, data-id): the CSS
// classes are build hashes that change with every App Store Connect release.

(() => {
  const FIELDS = ["whatsNew", "promotionalText"];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();

  async function until(check, timeout = 8000, every = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = check();
      if (value) return value;
      await sleep(every);
    }
    return null;
  }

  function progress(text) {
    chrome.runtime.sendMessage({ type: "progress", text }).catch(() => {});
  }

  // --- Page context ------------------------------------------------------

  // /apps/<appId>/distribution/<platform>/version/<inflight|deliverable>
  function context() {
    const match = location.pathname.match(
      /^\/apps\/(\d+)(?:\/distribution\/([^/]+)(?:\/version\/([^/]+))?)?/,
    );
    if (!match) return null;
    const [, appId, platform = null, page = null] = match;
    const appName = clean(document.title.split(/\s[-–|]\s/)[0]);
    return { appId, platform, page, appName };
  }

  // --- Language menu -----------------------------------------------------

  const menuButton = () =>
    document.querySelector('button[aria-haspopup="menu"][aria-controls^="popover-content-"]');

  async function openMenu() {
    const button = menuButton();
    if (!button) throw new Error("Language menu not found on this page.");
    if (button.getAttribute("aria-expanded") !== "true") button.click();
    const menu = await until(() => document.getElementById(button.getAttribute("aria-controls")), 3000);
    if (!menu) throw new Error("Language menu did not open.");
    return menu;
  }

  function closeMenu() {
    const button = menuButton();
    if (button?.getAttribute("aria-expanded") === "true") button.click();
  }

  // The menu lists the version's localizations followed by "add language"
  // entries. A localization row carries a remove button, except the primary
  // language, whose aria-label begins with its own name ("Add …" entries end
  // with it).
  function localeItems(menu) {
    return [...menu.querySelectorAll('[role="menuitem"]')]
      .map((item) => {
        const name = clean(item.textContent);
        const removable = !!item.parentElement?.querySelector('[data-id^="removeLocale_"]');
        const label = clean(item.getAttribute("aria-label"));
        const isLocale = removable || !label || label.startsWith(name);
        return isLocale ? { item, name, primary: !removable } : null;
      })
      .filter(Boolean);
  }

  async function languages() {
    const menu = await openMenu();
    const items = localeItems(menu);
    closeMenu();
    if (!items.length) throw new Error("No localization found on this version.");
    return items.map(({ name, primary }) => ({ name, primary }));
  }

  async function switchTo(name) {
    const before = document.querySelector(`[name="${FIELDS[0]}"], [name="${FIELDS[1]}"]`);
    const menu = await openMenu();
    const target = localeItems(menu).find((l) => l.name === name);
    if (!target) {
      closeMenu();
      throw new Error(`Language "${name}" not found in the menu.`);
    }
    target.item.click();
    // The form re-renders for the new language: wait for the menu button
    // to show it or for the fields to be replaced, then let React settle.
    await until(() => {
      const shown = clean(menuButton()?.textContent);
      const now = document.querySelector(`[name="${FIELDS[0]}"], [name="${FIELDS[1]}"]`);
      return shown.includes(name) || (now && now !== before);
    }, 4000);
    await sleep(300);
  }

  // --- Fields ------------------------------------------------------------

  const fieldElement = (field) => document.querySelector(`[name="${field}"]`);

  function readField(field) {
    const el = fieldElement(field);
    if (!el) return null;
    return "value" in el ? el.value : el.innerText;
  }

  // React ignores a plain `el.value = …`: it tracks the last value it set.
  // Going through the prototype's setter and firing "input" makes the change
  // look like typing, so App Store Connect enables Save.
  function writeField(field, text) {
    const el = fieldElement(field);
    if (!el || el.disabled || el.readOnly) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function versionString() {
    const input = document.querySelector('[name="versionString"]');
    return clean(input?.value ?? input?.textContent) || null;
  }

  // --- Commands ----------------------------------------------------------

  async function ready() {
    const ok = await until(() => menuButton() && FIELDS.some(fieldElement), 20000, 250);
    if (!ok) throw new Error("This version page did not load. Is there a version in preparation?");
    await sleep(500);
    return context();
  }

  // Read every field of every language currently on the page.
  async function capture() {
    const texts = Object.fromEntries(FIELDS.map((f) => [f, {}]));
    const langs = await languages();
    for (const [i, { name }] of langs.entries()) {
      progress(`Reading ${name} (${i + 1}/${langs.length})`);
      await switchTo(name);
      for (const field of FIELDS) {
        const text = readField(field);
        if (text != null) texts[field][name] = text;
      }
    }
    return { version: versionString(), texts };
  }

  // Paste `texts[field][language]` for the selected fields, and return a
  // snapshot of the page afterwards so it can go to the history.
  async function fill({ fields, texts }) {
    const langs = await languages();
    const snapshot = Object.fromEntries(FIELDS.map((f) => [f, {}]));
    const filled = [];
    const missing = [];

    for (const [i, { name }] of langs.entries()) {
      const wanted = fields.filter((f) => texts[f]?.[name]?.trim());
      progress(`${wanted.length ? "Filling" : "Reading"} ${name} (${i + 1}/${langs.length})`);
      await switchTo(name);
      for (const field of wanted) writeField(field, texts[field][name]);
      if (wanted.length) filled.push(name);
      else missing.push(name);
      for (const field of FIELDS) {
        const text = readField(field);
        if (text != null) snapshot[field][name] = text;
      }
    }
    return { version: versionString(), texts: snapshot, filled, missing };
  }

  // Copy the primary language's texts into every other language.
  async function fillFromPrimary({ fields }) {
    const langs = await languages();
    const primary = langs.find((l) => l.primary) ?? langs[0];
    await switchTo(primary.name);
    const texts = {};
    for (const field of fields) {
      const text = readField(field) ?? "";
      texts[field] = Object.fromEntries(langs.map((l) => [l.name, text]));
    }
    return fill({ fields, texts });
  }

  const commands = { context: async () => context(), ready, capture, fill, fillFromPrimary };

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    const command = commands[message?.cmd];
    if (!command) return false;
    command(message.args ?? {})
      .then((result) => reply({ ok: true, result }))
      .catch((error) => reply({ ok: false, error: error.message }));
    return true;
  });
})();

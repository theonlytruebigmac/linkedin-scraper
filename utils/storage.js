/**
 * Storage utility for LinkedOut extension.
 * Manages chrome.storage.local operations for contact data.
 */

const StorageHelper = (() => {
  const CONTACTS_KEY = 'li_scraper_contacts';
  const META_KEY = 'li_scraper_meta';

  /**
   * Get all stored contacts, optionally filtered.
   */
  async function getContacts(filters = {}) {
    const result = await chrome.storage.local.get(CONTACTS_KEY);
    let contacts = result[CONTACTS_KEY] || [];

    if (filters.company) {
      const companyLower = filters.company.toLowerCase();
      contacts = contacts.filter(c =>
        c.company && c.company.toLowerCase().includes(companyLower)
      );
    }

    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      contacts = contacts.filter(c =>
        (c.name && c.name.toLowerCase().includes(searchLower)) ||
        (c.title && c.title.toLowerCase().includes(searchLower)) ||
        (c.location && c.location.toLowerCase().includes(searchLower))
      );
    }

    if (filters.sortBy) {
      contacts.sort((a, b) => {
        const valA = (a[filters.sortBy] || '').toLowerCase();
        const valB = (b[filters.sortBy] || '').toLowerCase();
        return filters.sortOrder === 'desc' ? valB.localeCompare(valA) : valA.localeCompare(valB);
      });
    }

    return contacts;
  }

  /**
   * Save new contacts, merging and deduplicating by profileUrl.
   * Returns the count of newly added contacts.
   */
  async function saveContacts(newContacts) {
    const result = await chrome.storage.local.get(CONTACTS_KEY);
    const existing = result[CONTACTS_KEY] || [];

    const urlMap = new Map();
    existing.forEach(c => urlMap.set(c.profileUrl, c));

    let addedCount = 0;
    newContacts.forEach(c => {
      if (!c.profileUrl) return;
      if (!urlMap.has(c.profileUrl)) {
        addedCount++;
      }
      // Always update with latest data
      urlMap.set(c.profileUrl, {
        ...urlMap.get(c.profileUrl),
        ...c,
        scrapedAt: c.scrapedAt || new Date().toISOString()
      });
    });

    const merged = Array.from(urlMap.values());
    await chrome.storage.local.set({ [CONTACTS_KEY]: merged });

    // Update metadata
    await updateMeta(merged);

    return addedCount;
  }

  /**
   * Get list of unique companies from stored contacts.
   */
  async function getCompanies() {
    const contacts = await getContacts();
    const companies = new Map();
    contacts.forEach(c => {
      if (c.company) {
        const key = c.company.toLowerCase();
        if (!companies.has(key)) {
          companies.set(key, { name: c.company, count: 0 });
        }
        companies.get(key).count++;
      }
    });
    return Array.from(companies.values()).sort((a, b) => b.count - a.count);
  }

  /**
   * Clear contacts — all or filtered by company.
   */
  async function clearContacts(company = null) {
    if (!company) {
      await chrome.storage.local.set({ [CONTACTS_KEY]: [] });
      await updateMeta([]);
      return;
    }

    const result = await chrome.storage.local.get(CONTACTS_KEY);
    const contacts = (result[CONTACTS_KEY] || []).filter(
      c => !c.company || c.company.toLowerCase() !== company.toLowerCase()
    );
    await chrome.storage.local.set({ [CONTACTS_KEY]: contacts });
    await updateMeta(contacts);
  }


  /**
   * Update metadata (total count, company count, last scrape time).
   */
  async function updateMeta(contacts) {
    const companies = new Set();
    contacts.forEach(c => {
      if (c.company) companies.add(c.company.toLowerCase());
    });

    await chrome.storage.local.set({
      [META_KEY]: {
        totalContacts: contacts.length,
        totalCompanies: companies.size,
        lastScrapeAt: new Date().toISOString()
      }
    });
  }

  /**
   * Get metadata.
   */
  async function getMeta() {
    const result = await chrome.storage.local.get(META_KEY);
    return result[META_KEY] || { totalContacts: 0, totalCompanies: 0, lastScrapeAt: null };
  }

  return {
    getContacts,
    saveContacts,
    getCompanies,
    clearContacts,
    getMeta
  };
})();

// Make available globally for content scripts and in modules
if (typeof globalThis !== 'undefined') {
  globalThis.StorageHelper = StorageHelper;
}

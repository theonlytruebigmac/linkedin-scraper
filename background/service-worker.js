/**
 * LinkedOut — Background Service Worker
 * Handles badge updates on storage change and on install/startup.
 */

async function updateBadge() {
  try {
    const result = await chrome.storage.local.get('li_scraper_meta');
    const meta = result.li_scraper_meta || { totalContacts: 0 };
    const count = meta.totalContacts;
    await chrome.action.setBadgeText({
      text: count > 0 ? (count > 999 ? '999+' : String(count)) : ''
    });
    await chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
  } catch (e) {
    console.debug('[LI Scraper SW] Badge update error:', e);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.li_scraper_meta) {
    updateBadge();
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updateBadge') {
    updateBadge().then(() => sendResponse({ success: true }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  console.log('[LI Scraper] Extension installed.');
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

updateBadge();

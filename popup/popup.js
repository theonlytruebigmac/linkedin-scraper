/**
 * LinkedOut — Popup Logic (v6, Manual Capture, Clean UI)
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const totalContacts = document.getElementById('totalContacts');
  const totalCompanies = document.getElementById('totalCompanies');
  const sessionCount = document.getElementById('sessionCount');
  const searchInput = document.getElementById('searchInput');
  const btnSearch = document.getElementById('btnSearch');
  const btnCapture = document.getElementById('btnCapture');
  const captureLabel = document.getElementById('captureLabel');
  const captureHint = document.getElementById('captureHint');
  const btnExport = document.getElementById('btnExport');
  const btnClear = document.getElementById('btnClear');
  const pageInfo = document.getElementById('pageInfo');
  const pageInfoText = document.getElementById('pageInfoText');
  const recentList = document.getElementById('recentList');

  // Progress tracker elements
  const progressTracker = document.getElementById('progressTracker');
  const progressPhase = document.getElementById('progressPhase');
  const progressPercent = document.getElementById('progressPercent');
  const progressFill = document.getElementById('progressFill');
  const progressDetail = document.getElementById('progressDetail');

  let currentTab = null;
  let isOnLinkedIn = false;
  let contentScriptReady = false;
  let scrapeStatus = null;

  // ──────── Init: query tab + content script ────────

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;
    isOnLinkedIn = tab?.url?.startsWith('https://www.linkedin.com');
  } catch (e) { }

  if (isOnLinkedIn && currentTab) {
    try {
      const resp = await sendToContentScript({ action: 'ping' });
      contentScriptReady = resp?.alive === true;
    } catch { contentScriptReady = false; }
  }

  if (contentScriptReady) {
    try { scrapeStatus = await sendToContentScript({ action: 'getStatus' }); }
    catch { /* ignore */ }
  }

  // ──────── Progress Listener ────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== 'scrapeProgress') return;

    const { phase, current, total, detail } = msg;
    progressTracker.style.display = 'block';

    // Phase label
    const phaseLabels = {
      scanning: 'Scanning pages...',
      enriching: 'Enriching profiles...',
      saving: 'Saving...',
      done: 'Complete',
      error: 'Error'
    };
    progressPhase.textContent = phaseLabels[phase] || phase;

    // Progress bar
    if (phase === 'scanning' && total === 0) {
      // Indeterminate — we don't know total pages yet
      progressFill.classList.add('indeterminate');
      progressFill.style.width = '';
      progressPercent.textContent = `${current} pages`;
    } else if (total > 0) {
      // Determinate bar
      progressFill.classList.remove('indeterminate');
      const pct = Math.round((current / total) * 100);
      progressFill.style.width = `${pct}%`;
      progressPercent.textContent = `${current} / ${total}`;
    }

    // Detail text
    progressDetail.textContent = detail || '';
  });

  // ──────── Status + Context ────────

  updateUI();
  await loadStats();
  await loadRecentContacts();

  function updateUI() {
    // Status badge
    if (isOnLinkedIn && contentScriptReady) {
      statusBadge.className = 'status-badge status-badge--active';
      statusText.textContent = 'Active';
      sessionCount.textContent = scrapeStatus?.totalScraped || 0;
    } else if (isOnLinkedIn) {
      statusBadge.className = 'status-badge status-badge--error';
      statusText.textContent = 'Reload Page';
    } else {
      statusBadge.className = 'status-badge status-badge--inactive';
      statusText.textContent = 'Not LinkedIn';
    }

    // Capture button + page info — single source of context
    if (!isOnLinkedIn) {
      btnCapture.disabled = true;
      captureLabel.textContent = 'Capture People';
      captureHint.textContent = '';
      showContext('Navigate to LinkedIn to get started');
    } else if (!contentScriptReady) {
      btnCapture.disabled = true;
      captureLabel.textContent = 'Capture People';
      captureHint.textContent = '';
      showContext('Refresh this LinkedIn page to activate');
    } else if (!scrapeStatus) {
      btnCapture.disabled = true;
      captureLabel.textContent = 'Capture People';
      captureHint.textContent = '';
      showContext('Could not connect to page');
    } else {
      const { pageType, companySlug, keywords } = scrapeStatus;

      if (pageType === 'company-people' || pageType === 'company-page') {
        const name = formatSlug(companySlug);
        btnCapture.disabled = false;
        captureLabel.textContent = `Capture ${name} Employees`;
        captureHint.textContent = 'Current employees only · Auto-paginate · Enriched profiles';
        showContext(`Company: ${name}`);
      } else if (pageType === 'search-results') {
        btnCapture.disabled = false;
        if (keywords) {
          captureLabel.textContent = `Capture: "${truncate(keywords, 25)}"`;
          captureHint.textContent = 'All pages · Enriched profiles';
          showContext(`Search: "${truncate(keywords, 30)}"`);
        } else {
          captureLabel.textContent = 'Capture Search Results';
          captureHint.textContent = 'All pages · Enriched profiles';
          showContext('People search — filtered results');
        }
      } else {
        btnCapture.disabled = true;
        captureLabel.textContent = 'Capture People';
        captureHint.textContent = '';
        showContext('Go to a company page or people search');
      }
    }
  }

  function showContext(text) {
    pageInfo.style.display = 'flex';
    pageInfoText.textContent = text;
  }

  // ──────── Event Handlers ────────

  btnCapture.addEventListener('click', async () => {
    if (btnCapture.disabled) return;
    btnCapture.disabled = true;
    btnCapture.classList.add('loading');
    const origLabel = captureLabel.textContent;
    captureLabel.textContent = 'Capturing…';
    captureHint.textContent = '';

    // Show progress tracker, reset state
    progressTracker.style.display = 'block';
    progressPhase.textContent = 'Starting...';
    progressPercent.textContent = '';
    progressFill.style.width = '0%';
    progressFill.classList.add('indeterminate');
    progressDetail.textContent = 'Initializing...';

    try {
      const result = await sendToContentScript({ action: 'scrape' });

      // Scrape done — update progress to complete
      progressFill.classList.remove('indeterminate');
      progressFill.style.width = '100%';

      if (result?.success) {
        progressPhase.textContent = 'Complete';
        progressDetail.textContent = result.message;
        captureLabel.textContent = `${result.added} new / ${result.count} total`;
        captureHint.textContent = '';
        showContext(result.message);
        sessionCount.textContent = (parseInt(sessionCount.textContent) || 0) + (result?.count || 0);
      } else {
        progressPhase.textContent = 'No results';
        progressDetail.textContent = result?.message || 'No contacts found';
        captureLabel.textContent = origLabel;
        showContext(result?.message || 'No contacts found');
      }

      await loadStats();
      await loadRecentContacts();

      // Auto-hide progress after 5 seconds
      setTimeout(() => {
        progressTracker.style.display = 'none';
      }, 5000);
    } catch (e) {
      progressFill.classList.remove('indeterminate');
      progressPhase.textContent = 'Error';
      progressDetail.textContent = e.message;
      captureLabel.textContent = origLabel;
      showContext(e.message);
    } finally {
      btnCapture.disabled = false;
      btnCapture.classList.remove('loading');
    }
  });

  btnSearch.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  btnExport.addEventListener('click', async () => {
    const contacts = await StorageHelper.getContacts();
    if (contacts.length === 0) return;
    const json = JSON.stringify(contacts, null, 2);

    try {
      await navigator.clipboard.writeText(json);
      const orig = btnExport.textContent;
      btnExport.textContent = 'Copied';
      btnExport.style.color = 'var(--success)';
      setTimeout(() => {
        btnExport.textContent = orig;
        btnExport.style.color = '';
      }, 2500);
    } catch {
      btnExport.textContent = 'Failed';
      setTimeout(() => { btnExport.textContent = 'Copy JSON'; }, 2000);
    }
  });

  btnClear.addEventListener('click', async () => {
    await StorageHelper.clearContacts();
    await loadStats();
    await loadRecentContacts();
    chrome.runtime.sendMessage({ action: 'updateBadge' }).catch(() => { });
  });

  // ──────── Helpers ────────

  function doSearch() {
    const query = searchInput.value.trim();
    if (!query) { searchInput.focus(); return; }
    const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;
    if (currentTab) { chrome.tabs.update(currentTab.id, { url }); }
    else { chrome.tabs.create({ url }); }
    showContext(`Navigating to "${query}" — click Capture when loaded`);
  }

  function sendToContentScript(message) {
    return new Promise((resolve, reject) => {
      if (!currentTab?.id) return reject(new Error('No active tab'));
      chrome.tabs.sendMessage(currentTab.id, message, resp => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

  async function loadStats() {
    const meta = await StorageHelper.getMeta();
    totalContacts.textContent = meta.totalContacts;
    totalCompanies.textContent = meta.totalCompanies;
    btnExport.disabled = meta.totalContacts === 0;
    btnClear.disabled = meta.totalContacts === 0;
  }

  async function loadRecentContacts() {
    const contacts = await StorageHelper.getContacts();
    const recent = contacts
      .sort((a, b) => new Date(b.scrapedAt) - new Date(a.scrapedAt))
      .slice(0, 5);

    if (recent.length === 0) {
      recentList.innerHTML = '<p class="empty-state">No contacts yet</p>';
      return;
    }

    recentList.innerHTML = recent.map(c => {
      const initials = getInitials(c.name);
      const avatar = c.photoUrl
        ? `<img class="contact-avatar" src="${esc(c.photoUrl)}" alt="" onerror="this.outerHTML='<div class=\\'contact-avatar\\'>${initials}</div>'">`
        : `<div class="contact-avatar">${initials}</div>`;

      return `
        <a href="${esc(c.profileUrl)}" target="_blank" class="contact-card">
          ${avatar}
          <div class="contact-info">
            <div class="contact-name">${esc(c.name)}</div>
            <div class="contact-detail">${esc(c.title || c.headline || '')}</div>
          </div>
          ${c.company ? `<span class="contact-badge contact-badge--company">${esc(c.company)}</span>` : ''}
        </a>`;
    }).join('');
  }

  function formatSlug(slug) {
    if (!slug) return 'Company';
    return slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  function truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function getInitials(name) {
    if (!name) return '?';
    return name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase();
  }

  function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
});

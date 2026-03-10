/**
 * LinkedOut — Content Script (API-based, v6)
 *
 * Uses LinkedIn's internal Voyager API to fetch structured contact data.
 * All scraping is manual — triggered by the popup's "Capture" button.
 *
 * Supports three modes:
 *   1. Company People  — resolves company slug to ID, fetches current employees
 *   2. Keyword Search  — fetches people matching a keyword query
 *   3. Filter Search   — fetches people matching active URL filters (no keywords)
 *
 * Both search modes auto-paginate and enrich each contact with profile data.
 */

(() => {
  if (window.__liScraperInjected) return;
  window.__liScraperInjected = true;

  let scrapedUrls = new Set();
  let totalScraped = 0;

  // ──────────────────── Progress Reporting ────────────────────

  function sendProgress(phase, current, total, detail = '') {
    try {
      chrome.runtime.sendMessage({
        action: 'scrapeProgress',
        phase,
        current,
        total,
        detail
      }).catch(() => { });
    } catch (e) { /* popup may be closed */ }
  }

  // ──────────────────── Voyager API Client ────────────────────

  function getCsrfToken() {
    const cookies = document.cookie.split(';').map(c => c.trim());
    const jsessionid = cookies.find(c => c.startsWith('JSESSIONID='));
    if (!jsessionid) return '';
    return jsessionid.split('=')[1]?.replace(/"/g, '') || '';
  }

  function getApiHeaders() {
    return {
      'csrf-token': getCsrfToken(),
      'x-li-lang': 'en_US',
      'x-restli-protocol-version': '2.0.0',
      'accept': 'application/vnd.linkedin.normalized+json+2.1'
    };
  }

  // ──────────────────── Company Resolution ────────────────────

  async function resolveCompanyId(slug) {
    const url = `https://www.linkedin.com/voyager/api/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=${encodeURIComponent(slug)}`;

    const resp = await fetch(url, {
      headers: getApiHeaders(),
      credentials: 'include'
    });

    if (!resp.ok) throw new Error(`Company resolve failed: ${resp.status}`);

    const json = await resp.json();
    const included = json.included || [];
    const company = included.find(i => i.name || i.universalName);

    if (!company?.entityUrn) throw new Error('Company not found');

    const companyId = company.entityUrn.match(/(\d+)$/)?.[1];
    if (!companyId) throw new Error('Could not extract company ID');

    return { id: companyId, name: company.name || slug };
  }

  function getCompanySlug() {
    const match = window.location.pathname.match(/\/company\/([^/]+)/);
    return match ? match[1] : '';
  }

  // ──────────────────── Search APIs ────────────────────

  async function searchCompanyPeoplePage(companyId, start = 0) {
    const queryId = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0';
    const variables = `(start:${start},origin:COMPANY_PAGE_CANNED_SEARCH,query:(flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:currentCompany,value:List(${companyId})),(key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))`;
    const url = `https://www.linkedin.com/voyager/api/graphql?queryId=${queryId}&variables=${variables}&includeWebMetadata=true`;

    const response = await fetch(url, {
      headers: getApiHeaders(),
      credentials: 'include'
    });

    if (!response.ok) throw new Error(`API ${response.status}`);
    return parseSearchResponse(await response.json());
  }

  async function searchPeoplePage(keywords, start = 0) {
    const queryId = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0';
    const encodedKeywords = encodeURIComponent(keywords);
    const variables = `(start:${start},origin:GLOBAL_SEARCH_HEADER,query:(keywords:${encodedKeywords},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))`;
    const url = `https://www.linkedin.com/voyager/api/graphql?queryId=${queryId}&variables=${variables}&includeWebMetadata=true`;

    const response = await fetch(url, {
      headers: getApiHeaders(),
      credentials: 'include'
    });

    if (!response.ok) throw new Error(`API ${response.status}`);
    return parseSearchResponse(await response.json());
  }

  // Parses LinkedIn URL filter values encoded as JSON arrays e.g. ["F","S","O"] -> "F,S,O"
  function parseListParam(raw) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.join(',');
    } catch { }
    return raw || null;
  }

  async function searchPeoplePageFromCurrentUrl(start = 0) {
    const queryId = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0';
    const urlParams = new URL(window.location.href).searchParams;

    const filterParts = ['(key:resultType,value:List(PEOPLE))'];

    const network = parseListParam(urlParams.get('network'));
    if (network) filterParts.push(`(key:network,value:List(${network}))`);

    const company = parseListParam(urlParams.get('currentCompany'));
    if (company) filterParts.push(`(key:currentCompany,value:List(${company}))`);

    const geo = parseListParam(urlParams.get('geoUrn'));
    if (geo) filterParts.push(`(key:geoUrn,value:List(${geo}))`);

    const industry = parseListParam(urlParams.get('industry'));
    if (industry) filterParts.push(`(key:industry,value:List(${industry}))`);

    const title = parseListParam(urlParams.get('titleFreeText'));
    if (title) filterParts.push(`(key:titleFreeText,value:List(${title}))`);

    const variables = `(start:${start},origin:FACETED_SEARCH,query:(flagshipSearchIntent:SEARCH_SRP,queryParameters:List(${filterParts.join(',')}),includeFiltersInResponse:false))`;
    const url = `https://www.linkedin.com/voyager/api/graphql?queryId=${queryId}&variables=${variables}&includeWebMetadata=true`;

    const response = await fetch(url, {
      headers: getApiHeaders(),
      credentials: 'include'
    });

    if (!response.ok) throw new Error(`API ${response.status}`);
    return parseSearchResponse(await response.json());
  }

  async function paginateSearch(fetchPage, maxPages = 100, delayMs = 1500) {
    let allContacts = [];
    let page = 0;

    while (page < maxPages) {
      const start = page * 10;
      sendProgress('scanning', page + 1, 0, `Scanning page ${page + 1} (${allContacts.length} found)`);

      const contacts = await fetchPage(start);

      if (contacts.length === 0) {
        console.log(`[LI Scraper] Page ${page + 1}: no more results, done.`);
        break;
      }

      allContacts.push(...contacts);
      console.log(`[LI Scraper] Page ${page + 1}: ${contacts.length} contacts (${allContacts.length} total)`);
      sendProgress('scanning', page + 1, 0, `Page ${page + 1}: ${allContacts.length} people found`);

      if (contacts.length < 10) break;

      page++;
      if (page < maxPages) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    sendProgress('scanning', page + 1, page + 1, `Scan complete: ${allContacts.length} people found`);
    return allContacts;
  }

  // ──────────────────── Profile Enrichment ────────────────────

  async function enrichProfile(publicId) {
    const result = {};

    try {
      const profileUrl = `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicId)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`;
      const profResp = await fetch(profileUrl, {
        headers: getApiHeaders(),
        credentials: 'include'
      });

      if (profResp.ok) {
        const profJson = await profResp.json();
        const included = profJson.included || [];

        const profile = included.find(i => i.firstName && i.lastName);
        if (profile) {
          result.firstName = profile.firstName || '';
          result.lastName = profile.lastName || '';
          result.industry = profile.industryName || profile.industry || '';
          result.summary = profile.summary || '';
          if (profile.geoLocation) {
            result.geoCity = profile.geoLocation.city || '';
            result.geoState = profile.geoLocation.state || '';
            result.geoCountry = profile.geoLocation.countryCode || '';
          }
          if (profile.locationName) result.locationName = profile.locationName;
        }

        const positions = included.filter(i =>
          i['$type']?.includes('Position') || (i.companyName && i.title)
        );
        if (positions.length > 0) {
          result.currentTitle = positions[0].title || '';
          result.currentCompany = positions[0].companyName || '';
        }
      }
    } catch (e) {
      console.debug('[LI Scraper] Profile enrichment error:', e);
    }

    try {
      const contactUrl = `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicId)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.ProfileContactInfo-13`;
      const contactResp = await fetch(contactUrl, {
        headers: getApiHeaders(),
        credentials: 'include'
      });

      if (contactResp.ok) {
        const contactJson = await contactResp.json();
        const included = contactJson.included || [];

        included.forEach(item => {
          if (item.emailAddress) result.email = result.email || item.emailAddress;
          if (item.phoneNumbers?.length > 0) result.phone = result.phone || item.phoneNumbers[0].number;
          if (item.websites?.length > 0) result.websites = item.websites.map(w => w.url || w).filter(Boolean);
          if (item.twitterHandles?.length > 0) result.twitter = item.twitterHandles[0].name || item.twitterHandles[0];
        });
      }
    } catch (e) {
      console.debug('[LI Scraper] Contact info error:', e);
    }

    return result;
  }

  async function enrichContacts(contacts, delayMs = 800) {
    console.log(`[LI Scraper] Enriching ${contacts.length} contacts...`);
    let enriched = 0;
    const total = contacts.length;

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      const match = contact.profileUrl?.match(/\/in\/([^/?]+)/);
      if (!match) continue;

      sendProgress('enriching', i + 1, total, `Enriching ${contact.name}`);

      try {
        const extra = await enrichProfile(match[1]);
        if (extra.firstName) contact.firstName = extra.firstName;
        if (extra.lastName) contact.lastName = extra.lastName;
        if (extra.email) contact.email = typeof extra.email === 'string'
          ? extra.email
          : (extra.email?.emailAddress || null);
        if (extra.phone) contact.phone = extra.phone;
        if (extra.twitter) contact.twitter = extra.twitter;
        if (extra.websites) contact.websites = extra.websites;
        if (extra.industry) contact.industry = extra.industry;
        if (extra.geoCity) contact.city = extra.geoCity;
        if (extra.geoState) contact.state = extra.geoState;
        if (extra.geoCountry) contact.country = extra.geoCountry;
        if (extra.summary && !contact.summary) contact.summary = extra.summary;
        if (extra.currentTitle) contact.title = extra.currentTitle;
        if (extra.currentCompany) contact.company = extra.currentCompany;

        enriched++;
        const emailDisplay = contact.email ? ` · ${contact.email}` : '';
        console.log(`[LI Scraper]   ${contact.name}: ${contact.email || 'no email'} | ${contact.phone || 'no phone'}`);
        sendProgress('enriching', i + 1, total, `${contact.name}${emailDisplay}`);
      } catch (e) {
        console.debug('[LI Scraper] Enrichment failed:', e);
        sendProgress('enriching', i + 1, total, `${contact.name} — skipped`);
      }

      await new Promise(r => setTimeout(r, delayMs));
    }

    sendProgress('saving', total, total, `Saving ${enriched} enriched contacts...`);
    console.log(`[LI Scraper] Enriched ${enriched}/${total} contacts`);
    return contacts;
  }

  // ──────────────────── Response Parsing ────────────────────

  function parseSearchResponse(json) {
    const included = json.included || [];
    const contacts = [];

    const searchHits = included.filter(item =>
      item['$type'] === 'com.linkedin.voyager.dash.search.EntityResultViewModel'
    );

    searchHits.forEach(hit => {
      try {
        const contact = parseSearchHit(hit);
        if (contact && contact.profileUrl && !scrapedUrls.has(contact.profileUrl)) {
          contacts.push(contact);
          scrapedUrls.add(contact.profileUrl);
        }
      } catch (e) {
        console.debug('[LI Scraper] Parse error:', e);
      }
    });

    return contacts;
  }

  function parseSearchHit(hit) {
    const name = hit.title?.text || '';
    if (!name || name === 'LinkedIn Member') return null;

    const nameParts = name.split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    let profileUrl = '';
    if (hit.navigationUrl) {
      const match = hit.navigationUrl.match(/\/in\/([^?/]+)/);
      if (match) profileUrl = `https://www.linkedin.com/in/${match[1]}/`;
    }
    if (!profileUrl) return null;

    const headline = hit.primarySubtitle?.text || '';
    const location = hit.secondarySubtitle?.text || '';

    let title = headline;
    let company = '';
    const atMatch = headline.match(/^(.+?)\s+at\s+(.+)$/i);
    const dashMatch = headline.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (atMatch) { title = atMatch[1].trim(); company = atMatch[2].trim(); }
    else if (dashMatch) { title = dashMatch[1].trim(); company = dashMatch[2].trim(); }

    let connectionDegree = '';
    if (hit.badgeText?.text) {
      const m = hit.badgeText.text.match(/(1st|2nd|3rd)/);
      if (m) connectionDegree = m[1];
    }
    if (!connectionDegree && hit.insightsResolutionResults) {
      const m2 = JSON.stringify(hit.insightsResolutionResults).match(/(1st|2nd|3rd)/);
      if (m2) connectionDegree = m2[1];
    }

    let photoUrl = '';
    try {
      const imgRoot = hit.image?.attributes?.[0]?.detailData?.['*profilePicture'] ||
        hit.image?.attributes?.[0]?.detailData?.nonEntityProfilePicture;
      if (imgRoot?.vectorImage?.rootUrl && imgRoot?.vectorImage?.artifacts?.length > 0) {
        const artifact = imgRoot.vectorImage.artifacts[imgRoot.vectorImage.artifacts.length - 1];
        photoUrl = imgRoot.vectorImage.rootUrl + artifact.fileIdentifyingUrlPathSegment;
      }
    } catch (e) { }

    return {
      name, firstName, lastName,
      title, company, location, headline,
      connectionDegree, profileUrl, photoUrl,
      summary: hit.summary?.text || '',
      source: detectPageType(),
      scrapedAt: new Date().toISOString()
    };
  }

  // ──────────────────── Page Detection ────────────────────

  function detectPageType() {
    const url = window.location.href;
    if (url.includes('/search/results/people')) return 'search-results';
    if (url.match(/\/company\/[^/]+\/people/)) return 'company-people';
    if (url.match(/\/in\/[^/]+/)) return 'profile';
    if (url.match(/\/company\/[^/]+/)) return 'company-page';
    return 'other';
  }

  function getSearchKeywords() {
    const url = new URL(window.location.href);
    return url.searchParams.get('keywords') || '';
  }

  // ──────────────────── Main Scrape Orchestration ────────────────────

  async function scrapeCurrentPage() {
    const pageType = detectPageType();
    scrapedUrls.clear();

    if (pageType === 'company-people' || pageType === 'company-page') {
      return await scrapeCompanyEmployees();
    } else if (pageType === 'search-results') {
      return await scrapeSearchResults();
    } else {
      console.log('[LI Scraper] Not a scrapable page:', pageType);
      return { contacts: [], error: 'Navigate to a company page or search results to capture contacts.' };
    }
  }

  async function scrapeCompanyEmployees() {
    const slug = getCompanySlug();
    if (!slug) return { contacts: [], error: 'Not on a company page.' };

    console.log(`[LI Scraper] Resolving company: ${slug}`);
    const { id: companyId, name: companyName } = await resolveCompanyId(slug);
    console.log(`[LI Scraper] ${companyName} (ID: ${companyId})`);

    const contacts = await paginateSearch(
      (start) => searchCompanyPeoplePage(companyId, start)
    );

    contacts.forEach(c => { if (!c.company) c.company = companyName; });
    console.log(`[LI Scraper] Found ${contacts.length} current employees`);

    if (contacts.length > 0) {
      await enrichContacts(contacts);
    }

    totalScraped += contacts.length;
    return { contacts, companyName };
  }

  async function scrapeSearchResults() {
    const keywords = getSearchKeywords();
    console.log(`[LI Scraper] Search capture — keywords: "${keywords || '(filter-based)'}"`);

    const contacts = await paginateSearch(
      keywords
        ? (start) => searchPeoplePage(keywords, start)
        : (start) => searchPeoplePageFromCurrentUrl(start)
    );

    console.log(`[LI Scraper] Found ${contacts.length} contacts`);

    if (contacts.length > 0) {
      await enrichContacts(contacts);
    }

    totalScraped += contacts.length;
    return { contacts, keywords: keywords || '(filtered search)' };
  }

  // ──────────────────── Message Handling ────────────────────

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case 'getStatus': {
        sendResponse({
          pageType: detectPageType(),
          totalScraped,
          companySlug: getCompanySlug(),
          keywords: getSearchKeywords(),
          mode: 'api-v6'
        });
        return false;
      }

      case 'scrape':
        scrapeCurrentPage()
          .then(async result => {
            if (result.contacts.length > 0) {
              const addedCount = await StorageHelper.saveContacts(result.contacts);
              chrome.runtime.sendMessage({ action: 'updateBadge' }).catch(() => { });
              console.log(`[LI Scraper] Captured ${addedCount} new contact(s).`);
              sendProgress('done', result.contacts.length, result.contacts.length, `Done — ${addedCount} new contacts saved.`);
              sendResponse({
                success: true,
                count: result.contacts.length,
                added: addedCount,
                message: `Scraped ${result.contacts.length} contacts, ${addedCount} new.`
              });
            } else {
              console.log('[LI Scraper] No contacts found.');
              sendProgress('done', 0, 0, result.error || 'No contacts found.');
              sendResponse({
                success: false,
                count: 0,
                message: result.error || 'No contacts found.'
              });
            }
          })
          .catch(err => {
            console.error('[LI Scraper] Error:', err.message);
            sendResponse({ success: false, error: err.message });
          });
        return true;

      case 'ping':
        sendResponse({ alive: true });
        return false;
    }
  });

  // ──────────────────── Init ────────────────────

  // All scraping is button-triggered from the popup — no auto-scrape on load.
  const pageType = detectPageType();
  const csrfToken = getCsrfToken();
  console.log(`[LI Scraper] Content script loaded (API v6) — ${pageType}`);
  console.log(`[LI Scraper] CSRF token: ${csrfToken ? 'found' : 'MISSING'}`);
})();

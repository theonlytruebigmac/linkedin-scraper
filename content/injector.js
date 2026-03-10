/**
 * LinkedIn Interceptor (v4 — JSON.parse)
 * 
 * LinkedIn's networking stack:
 *   1. Overwrites window.fetch with its own wrapper
 *   2. Reads response bodies via FileReader + Blob (bypasses Response.prototype)
 *   3. Eventually calls JSON.parse to deserialize
 * 
 * So we patch JSON.parse — the ONE function LinkedIn cannot bypass.
 * We check parsed results for LinkedIn API response signatures.
 */

(() => {
  if (window.__liInterceptorInstalled) return;
  window.__liInterceptorInstalled = true;

  const originalParse = JSON.parse;
  let interceptCount = 0;

  JSON.parse = function (text, reviver) {
    const result = originalParse.call(this, text, reviver);

    // Quick gate: only process objects (not arrays, strings, etc.)
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return result;
    }

    // Check for LinkedIn API response signatures
    try {
      const hasIncluded = Array.isArray(result.included) && result.included.length > 0;
      const hasNestedIncluded = Array.isArray(result.data?.included) && result.data.included.length > 0;
      const hasElements = Array.isArray(result.elements) && result.elements.length > 0;

      // Also check for GraphQL nested structure
      const hasGraphQL = result.data?.data && typeof result.data.data === 'object';

      if (hasIncluded || hasNestedIncluded || hasElements || hasGraphQL) {
        interceptCount++;

        // Quick entity type scan
        const entities = hasIncluded ? result.included :
                         hasNestedIncluded ? result.data.included :
                         hasElements ? result.elements : [];

        const sampleTypes = [];
        for (let i = 0; i < Math.min(entities.length, 5); i++) {
          const e = entities[i];
          if (e?.['$type']) sampleTypes.push(e['$type']);
          if (e?.['$recipeTypes']?.length) sampleTypes.push('R:' + e['$recipeTypes'][0]);
        }

        console.log(`[LI Interceptor] 📡 #${interceptCount} Caught LinkedIn data! Entities: ${entities.length}, Types: [${sampleTypes.join(', ')}]`);

        // Post to content script
        window.postMessage({
          type: 'LI_SCRAPER_INTERCEPT',
          url: window.location.href,
          data: result,
          source: 'json-parse',
          entityCount: entities.length
        }, '*');
      }
    } catch (e) {
      // Never let our logic break JSON.parse
    }

    return result;
  };

  // Also patch XMLHttpRequest for URL tracking
  const origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__liUrl = typeof url === 'string' ? url : String(url || '');
    return origXHROpen.apply(this, [method, url, ...rest]);
  };

  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__liUrl || '';
    if (url.includes('/voyager/api/') || url.includes('/graphql')) {
      this.addEventListener('load', function () {
        try {
          // responseText triggers our JSON.parse patch when LinkedIn parses it
          // But let's also try to intercept directly
          if (this.responseText && this.responseText.length > 50) {
            const data = originalParse(this.responseText);
            if (data && (Array.isArray(data.included) || Array.isArray(data.data?.included))) {
              console.log(`[LI Interceptor] 📡 XHR direct: ${url.substring(0, 100)}`);
              window.postMessage({
                type: 'LI_SCRAPER_INTERCEPT',
                url: url,
                data: data,
                source: 'xhr-direct'
              }, '*');
            }
          }
        } catch (e) { /* ignore */ }
      });
    }
    return origXHRSend.apply(this, args);
  };

  console.log('[LI Scraper] ✅ JSON.parse interceptor installed');
})();

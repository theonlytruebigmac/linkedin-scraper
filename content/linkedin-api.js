/**
 * LinkedIn Response Parser (v2 — aggressive matching)
 * 
 * Pure parsing utility. Extracts people data from intercepted LinkedIn 
 * API responses. Uses multiple strategies and is intentionally permissive
 * to handle any LinkedIn response format version.
 */

const LinkedInParser = (() => {

  /**
   * Parse an intercepted API response and extract any people contacts.
   */
  function extractContacts(url, data) {
    if (!data) return [];

    // Collect ALL included entities from any level of the response
    const allEntities = collectAllEntities(data);

    if (allEntities.length === 0) {
      console.log('[LI Parser] No entities found in response');
      return [];
    }

    console.log(`[LI Parser] Processing ${allEntities.length} entities from: ${url.substring(0, 80)}`);

    // Log all entity types for debugging
    const typeSet = new Set();
    allEntities.forEach(e => {
      if (e['$type']) typeSet.add(e['$type']);
      (e['$recipeTypes'] || []).forEach(r => typeSet.add('R:' + r));
    });
    console.log('[LI Parser] Entity types found:', [...typeSet]);

    const contacts = [];
    const seenUrls = new Set();

    // Pass 1: Entities with title.text + navigationUrl (search results)
    for (const entity of allEntities) {
      if (entity.title?.text && entity.navigationUrl) {
        const contact = parseFromTitleNav(entity);
        if (contact && !seenUrls.has(contact.profileUrl)) {
          seenUrls.add(contact.profileUrl);
          contacts.push(contact);
        }
      }
    }

    // Pass 2: Entities with firstName/lastName (MiniProfile, Profile)
    for (const entity of allEntities) {
      if (entity.firstName || entity.lastName) {
        const contact = parseFromName(entity);
        if (contact && !seenUrls.has(contact.profileUrl)) {
          seenUrls.add(contact.profileUrl);
          contacts.push(contact);
        }
      }
    }

    // Pass 3: Entities with publicIdentifier (any profile-like entity)
    for (const entity of allEntities) {
      if (entity.publicIdentifier && entity.publicIdentifier !== 'UNKNOWN') {
        const url = `https://www.linkedin.com/in/${entity.publicIdentifier}`;
        if (!seenUrls.has(url)) {
          const contact = parseFromPublicId(entity);
          if (contact) {
            seenUrls.add(url);
            contacts.push(contact);
          }
        }
      }
    }

    // Pass 4: Entities with occupation or headline that contain "at" (someone's role)
    for (const entity of allEntities) {
      const occ = entity.occupation || entity.headline || '';
      if (occ && occ.includes(' at ') && entity.entityUrn?.includes('profile')) {
        const contact = parseFromOccupation(entity);
        if (contact && !seenUrls.has(contact.profileUrl)) {
          seenUrls.add(contact.profileUrl);
          contacts.push(contact);
        }
      }
    }

    console.log(`[LI Parser] Extracted ${contacts.length} contact(s)`);
    return contacts;
  }

  /**
   * Collect ALL entities from any level of the response.
   * LinkedIn wraps things differently in REST vs GraphQL responses.
   */
  function collectAllEntities(data) {
    const entities = [];

    // Top-level included (REST format)
    if (Array.isArray(data.included)) {
      entities.push(...data.included);
    }

    // Nested under data (GraphQL wrapper)
    if (Array.isArray(data.data?.included)) {
      entities.push(...data.data.included);
    }

    // Some responses nest further
    if (data.data?.data && typeof data.data.data === 'object') {
      // Look for included at various nesting levels
      if (Array.isArray(data.data.data.included)) {
        entities.push(...data.data.data.included);
      }
    }

    // Also check elements arrays that might contain profile data
    if (Array.isArray(data.elements)) {
      entities.push(...data.elements);
    }
    if (Array.isArray(data.data?.elements)) {
      entities.push(...data.data.elements);
    }

    // Walk through data looking for any object with entityUrn
    // (catches deeply nested GraphQL responses)
    if (entities.length === 0) {
      findEntitiesDeep(data, entities, 0);
    }

    return entities;
  }

  /**
   * Recursively find entity-like objects in deeply nested responses.
   * Max depth of 5 to avoid infinite recursion.
   */
  function findEntitiesDeep(obj, results, depth) {
    if (depth > 5 || !obj || typeof obj !== 'object') return;
    if (results.length > 500) return; // Safety cap

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item && typeof item === 'object' && (item.entityUrn || item.publicIdentifier || item.firstName)) {
          results.push(item);
        }
        findEntitiesDeep(item, results, depth + 1);
      }
    } else {
      // Check if this object itself is entity-like
      if (obj.entityUrn || obj.publicIdentifier || (obj.firstName && obj.lastName)) {
        results.push(obj);
      }
      for (const key of Object.keys(obj)) {
        if (key.startsWith('$') || key === 'meta') continue; // Skip metadata
        findEntitiesDeep(obj[key], results, depth + 1);
      }
    }
  }

  /* --- Parsing strategies --- */

  function parseFromTitleNav(entity) {
    const name = entity.title?.text || '';
    if (!name || name === 'LinkedIn Member') return null;
    if (!entity.navigationUrl?.includes('/in/')) return null;

    return {
      name,
      title: entity.primarySubtitle?.text || entity.headline?.text || '',
      company: extractCompany(entity),
      location: entity.secondarySubtitle?.text || entity.subline?.text || '',
      profileUrl: cleanUrl(entity.navigationUrl.split('?')[0]),
      photoUrl: extractAnyPhoto(entity),
      connectionDegree: extractDegree(entity),
      scrapedAt: new Date().toISOString(),
      source: 'search-result'
    };
  }

  function parseFromName(entity) {
    const first = entity.firstName || '';
    const last = entity.lastName || '';
    const name = `${first} ${last}`.trim();
    if (!name) return null;

    const pid = entity.publicIdentifier || extractPidFromUrn(entity.entityUrn);
    if (!pid || pid === 'UNKNOWN') return null;

    return {
      name,
      title: entity.occupation || entity.headline || '',
      company: extractCompany(entity),
      location: entity.locationName || entity.geoLocationName || '',
      profileUrl: `https://www.linkedin.com/in/${pid}`,
      photoUrl: extractAnyPhoto(entity),
      connectionDegree: extractDegree(entity),
      scrapedAt: new Date().toISOString(),
      source: 'profile-entity'
    };
  }

  function parseFromPublicId(entity) {
    const pid = entity.publicIdentifier;
    // Try to get a name from any available field
    const name = (entity.firstName && entity.lastName)
      ? `${entity.firstName} ${entity.lastName}`.trim()
      : entity.title?.text || '';

    if (!name) return null;

    return {
      name,
      title: entity.occupation || entity.headline || entity.primarySubtitle?.text || '',
      company: extractCompany(entity),
      location: entity.locationName || entity.geoLocationName || entity.secondarySubtitle?.text || '',
      profileUrl: `https://www.linkedin.com/in/${pid}`,
      photoUrl: extractAnyPhoto(entity),
      connectionDegree: extractDegree(entity),
      scrapedAt: new Date().toISOString(),
      source: 'public-id'
    };
  }

  function parseFromOccupation(entity) {
    const occ = entity.occupation || entity.headline || '';
    const pid = entity.publicIdentifier || extractPidFromUrn(entity.entityUrn);
    if (!pid || pid === 'UNKNOWN') return null;

    const name = (entity.firstName && entity.lastName)
      ? `${entity.firstName} ${entity.lastName}`.trim()
      : '';
    if (!name) return null;

    return {
      name,
      title: occ,
      company: extractCompany(entity),
      location: entity.locationName || entity.geoLocationName || '',
      profileUrl: `https://www.linkedin.com/in/${pid}`,
      photoUrl: extractAnyPhoto(entity),
      connectionDegree: '',
      scrapedAt: new Date().toISOString(),
      source: 'occupation'
    };
  }

  /* --- Company extraction --- */

  function extractCompany(entity) {
    // Direct company fields
    if (entity.companyName) return entity.companyName;

    // From summary "Current: Company Name"
    if (entity.summary?.text) {
      const m = entity.summary.text.match(/Current:\s*(.+?)(?:\s*\||$)/);
      if (m) return m[1].trim();
    }

    // From headline/occupation "Role at Company"
    const text = entity.occupation || entity.headline || entity.primarySubtitle?.text || '';
    if (text.includes(' at ')) {
      return text.split(' at ').pop().trim();
    }

    return '';
  }

  /* --- Photo extraction (try everything) --- */

  function extractAnyPhoto(entity) {
    // vectorImage patterns
    if (entity.profilePicture?.displayImageReference?.vectorImage) {
      return buildVectorUrl(entity.profilePicture.displayImageReference.vectorImage);
    }
    if (entity.picture?.vectorImage) {
      return buildVectorUrl(entity.picture.vectorImage);
    }
    if (entity.image?.vectorImage) {
      return buildVectorUrl(entity.image.vectorImage);
    }

    // rootUrl + artifacts pattern
    if (entity.picture?.rootUrl && entity.picture?.artifacts?.length) {
      const a = entity.picture.artifacts[entity.picture.artifacts.length - 1];
      return entity.picture.rootUrl + (a.fileIdentifyingUrlPathSegment || '');
    }

    // image.attributes patterns
    if (entity.image?.attributes) {
      for (const attr of entity.image.attributes) {
        if (attr.detailData?.nonEntityProfilePicture?.vectorImage) {
          return buildVectorUrl(attr.detailData.nonEntityProfilePicture.vectorImage);
        }
        if (attr.detailData?.profilePicture?.vectorImage) {
          return buildVectorUrl(attr.detailData.profilePicture.vectorImage);
        }
        if (attr.miniProfile?.picture) {
          const mp = attr.miniProfile.picture;
          if (mp.rootUrl && mp.artifacts?.length) {
            const a = mp.artifacts[mp.artifacts.length - 1];
            return mp.rootUrl + (a.fileIdentifyingUrlPathSegment || '');
          }
        }
        if (attr.imageUrl) return attr.imageUrl;
      }
    }

    // Direct URL
    if (entity.profilePictureRootUrl) return entity.profilePictureRootUrl;

    return '';
  }

  function buildVectorUrl(vi) {
    if (!vi?.rootUrl || !vi.artifacts?.length) return '';
    const a = vi.artifacts[vi.artifacts.length - 1];
    return vi.rootUrl + (a.fileIdentifyingUrlPathSegment || '');
  }

  /* --- Connection degree --- */

  function extractDegree(entity) {
    // Badge text
    const badge = entity.badgeText?.text || entity.badgeText?.accessibilityText || '';
    const m = badge.match(/(1st|2nd|3rd)/);
    if (m) return m[1];

    // Tracking info
    const dist = entity.entityCustomTrackingInfo?.memberDistance || '';
    if (dist.includes('1')) return '1st';
    if (dist.includes('2')) return '2nd';
    if (dist.includes('3')) return '3rd';

    // Distance field
    if (entity.distance?.value) {
      const d = entity.distance.value;
      if (d.includes('1')) return '1st';
      if (d.includes('2')) return '2nd';
      if (d.includes('3')) return '3rd';
    }

    return '';
  }

  /* --- Helpers --- */

  function extractPidFromUrn(urn) {
    if (!urn) return '';
    // urn:li:fsd_profile:ACoAABQp... or urn:li:member:12345
    const m = urn.match(/fsd_profile:(.+)/);
    if (m) return m[1];
    return '';
  }

  function cleanUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      return `https://www.linkedin.com${parsed.pathname.replace(/\/$/, '')}`;
    } catch {
      return url;
    }
  }

  return {
    extractContacts,
    collectAllEntities
  };
})();

if (typeof globalThis !== 'undefined') {
  globalThis.LinkedInParser = LinkedInParser;
}

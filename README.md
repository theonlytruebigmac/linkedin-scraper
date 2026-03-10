# LinkedOut

A Chrome extension that captures LinkedIn people data — employees at a company, keyword searches, or filtered searches — and exports the enriched contact list as JSON.

---

## Features

- **Company capture** — scrape all current employees from any LinkedIn company page
- **Keyword search** — search people by job title, name, or keywords and capture results
- **Filter search** — capture results from any people search with active filters (connection degree, location, company, etc.), no keywords required
- **Profile enrichment** — enriches each contact with email, phone, location, industry, and title via LinkedIn's profile API
- **Auto-pagination** — walks all result pages automatically
- **JSON export** — copies all contacts to clipboard as clean JSON
- **Badge counter** — shows total contacts captured in the extension icon

---

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the project folder
5. Navigate to a LinkedIn company page or people search and click the extension icon

---

## Usage

### Capture company employees
1. Go to any LinkedIn company page (e.g. `linkedin.com/company/openai/people`)
2. Open the extension — the button will read **Capture [Company] Employees**
3. Click to start — it will auto-paginate and enrich all current employees

### Capture search results
1. Run a people search on LinkedIn (with keywords or filters)
2. Open the extension — the button will read **Capture Search Results**
3. Click to start

### Export contacts
Once captured, click **Copy JSON** in the footer to copy all contacts to your clipboard. Paste into any text editor and save as `.json`.

### Search from popup
Use the **Search LinkedIn** box to navigate directly to a keyword search on LinkedIn from the popup.

---

## Data Captured Per Contact

| Field | Source |
|---|---|
| Name, First, Last | Search result |
| Title, Company, Headline | Search result |
| Location | Search result |
| Connection degree | Search result |
| Profile URL | Search result |
| Photo URL | Search result |
| Email | Profile API (contact info) |
| Phone | Profile API (contact info) |
| Twitter | Profile API (contact info) |
| Websites | Profile API (contact info) |
| Industry | Profile API |
| City, State, Country | Profile API |
| Summary | Profile API |
| Scraped at | Timestamp |

---

## Project Structure

```
linkedout/
├── manifest.json              # Chrome MV3 manifest
├── background/
│   └── service-worker.js      # Badge update logic
├── content/
│   ├── scraper.js             # Voyager API scraper + enrichment
│   └── scraper.css            # Minimal content script styles
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.js               # Popup logic + progress tracking
│   └── popup.css              # Dark theme styles
├── utils/
│   └── storage.js             # chrome.storage.local helpers
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

---

## Permissions

| Permission | Reason |
|---|---|
| `activeTab` | Read the current tab's URL to detect page type |
| `storage` | Persist captured contacts locally |
| `tabs` | Navigate the tab when searching from popup |
| `host_permissions: linkedin.com` | Make authenticated Voyager API calls |

No data leaves your machine. All contacts are stored in `chrome.storage.local`.

---

## Notes

- Requires an active LinkedIn session — you must be logged in
- LinkedIn rate-limits API calls; the scraper delays between requests automatically
- Enrichment calls the profile and contact-info endpoints per person — for large lists this takes time
- The extension uses LinkedIn's internal Voyager API which is undocumented and may break if LinkedIn changes their API

---

## License

MIT

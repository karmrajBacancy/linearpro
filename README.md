# LinearPro — Team Analytics Dashboard

A browser-based team analytics dashboard that connects to **Linear** or **JIRA** and visualizes issue tracking data, team workload, and project health.

## Features

- **Dual Provider Support** — Connect with either Linear or JIRA Cloud
- **Team Overview** — Member cards with issue counts and status breakdowns
- **Analytics Charts** — Status distribution, workload, priority breakdown, issues by team
- **Member Detail Modal** — Per-member drill-down with time period filtering (Today, 3d, 7d, 15d, All Time), status/priority charts, and full issue table
- **Ticket Detail Panel** — Slide-out panel showing description, comments, activity timeline, sub-issues, and metadata
- **SOS Alerts** — Identifies high-priority tickets stale for 2–7 days with no comments or status changes
- **Daily Standup Brief** — Auto-generated summary with blockers, at-risk items, unassigned tickets, workload imbalances, and recent completions
- **Animated UI** — Particle background, animated counters, smooth transitions

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single-page app structure — login view, dashboard, panels, modals |
| `style.css` | Full styling — dark theme, cards, charts, panels, responsive layout |
| `app.js` | All application logic — API layer, data processing, UI rendering, event handling |
| `proxy.js` | Local CORS proxy server for JIRA Cloud connections |

## Getting Started

### Linear

1. Open `index.html` in a browser
2. Select the **Linear** tab (default)
3. Enter your Linear API key (`lin_api_...`)
4. Click **Connect to Linear**

> Get your API key from **Linear → Settings → API → Personal API keys**

### JIRA Cloud

JIRA Cloud blocks direct browser requests (CORS), so a local proxy is required.

#### 1. Start the CORS proxy

```bash
npm install
node proxy.js
```

This starts a proxy on `http://127.0.0.1:8080`.

#### 2. Connect

1. Open `index.html` in a browser
2. Select the **JIRA** tab
3. Enter your JIRA domain (e.g. `your-company.atlassian.net`)
4. Enter your Atlassian email
5. Enter your Atlassian API token
6. Expand **Advanced — CORS Proxy** and enter `http://127.0.0.1:8080`
7. Click **Connect to JIRA**

> Create an API token at **id.atlassian.com → Security → API tokens**

## Architecture

### Provider Pattern

The app uses a provider/dispatcher pattern so the entire dashboard works identically with either data source:

```
UI / Dashboard / Panels / Charts
         │
    api (dispatcher)
       ┌──┴──┐
  linearApi  jiraApi
```

- `linearApi` — GraphQL calls to `api.linear.app`
- `jiraApi` — REST v3 calls to `{domain}.atlassian.net` (via CORS proxy)
- `api` — Dispatcher that delegates to the active provider based on `state.provider`

All provider methods return normalized data with the same shape, so `loadAllData()`, `processData()`, UI rendering, modals, charts, and panels require zero provider-specific logic.

### JIRA Data Normalization

| JIRA Concept | Mapped To |
|-------------|-----------|
| Project | Team |
| Status category `new` | State type `unstarted` |
| Status category `indeterminate` | State type `started` |
| Status category `done` | State type `completed` |
| Priority `Highest` | Priority 1 (Urgent) |
| Priority `High` | Priority 2 (High) |
| Priority `Medium` | Priority 3 (Medium) |
| Priority `Low` / `Lowest` | Priority 4 (Low) |
| ADF (Atlassian Document Format) | Plain text (recursive extraction) |

### State & Persistence

Credentials are stored in `localStorage`:

| Key | Purpose |
|-----|---------|
| `linearProProvider` | Active provider (`linear` or `jira`) |
| `linearApiKey` | Linear API key |
| `jiraDomain` | JIRA Cloud domain |
| `jiraEmail` | Atlassian account email |
| `jiraToken` | Atlassian API token |
| `jiraProxyUrl` | Optional CORS proxy URL |

On page load, the app auto-reconnects using saved credentials.

## Dependencies

- [Chart.js 4](https://www.chartjs.org/) — Charts (loaded via CDN)
- [Font Awesome 6](https://fontawesome.com/) — Icons (loaded via CDN)
- [Inter Font](https://rsms.me/inter/) — Typography (loaded via Google Fonts)
- [cors-anywhere](https://github.com/Rob--W/cors-anywhere) — Local CORS proxy for JIRA (npm dependency)

## Browser Support

Modern browsers with ES2017+ support (async/await, fetch, template literals).

# TC4S Review Tool — product-standardization-review

Automated and AI-assisted review tool for Catena-X standardisation quality gates.

## What this tool does

- Checks GitHub Issues against **QG1** completeness rules
- Checks Pull Requests against **QG2** rules (checklist, changelog, versioning, BC, CAC)
- Optionally enhances checks with **semantic AI analysis** (Claude / Blockbrain / any OpenAI-compatible API)
- Displays results grouped by SR / CR / Patch / PR
- Exports review reports as Markdown

## Live UI

Open `tc4s-review-ui.html` directly in a browser — no server or installation required.

GitHub Pages URL (after activation): `https://catenax-ev.github.io/product-standardization-review`

## Repository structure

```
product-standardization-review/
├── tc4s-review-ui.html          # Main UI — single-file web app
├── rules/
│   ├── qg1-rules.yaml           # QG1 Issue review rules (editable)
│   ├── qg2-rules.yaml           # QG2 PR review rules incl. BC + CAC (editable)
│   └── ai-config.yaml           # AI provider configuration
├── docs/
│   └── quality-criteria-catalogue-v0.1.pdf   # Source: TC4S Quality Criteria Catalogue
├── .github/
│   └── workflows/
│       └── tc4s-review.yml      # GitHub Actions: auto-comment on Issues + PRs
└── README.md
```

## How to use — browser (reviewers with limited GitHub access)

1. Open the GitHub Pages URL (or download `tc4s-review-ui.html` and open locally)
2. Enter your GitHub Personal Access Token (read-only: `repo` scope)
3. Enter milestone (e.g. `26.06`) — partial match works
4. Optionally enter specific Issue or PR numbers
5. Toggle which check categories to run
6. Click **Run review**

**Token requirements:**
- `repo` scope (read-only) on `catenax-eV/product-standardization-prod`
- For AI-enhanced checks: additionally an API key for Claude or Blockbrain

## How to edit rules (no code needed)

All rules live in `rules/*.yaml`. Each rule has:

```yaml
- id: QG1-01
  title: Management Summary present and filled
  enabled: true          # set false to disable without deleting
  ai_check: true         # set false to disable AI semantic check for this rule
  status: Active         # Active (blocking) | Recommendation (advisory)
```

Changes to YAML files take effect immediately — the UI fetches them on each load via GitHub Raw URLs.

## AI-enhanced checks

When enabled, rules marked `ai_check: true` send the Issue/PR content to an AI for semantic analysis alongside the rule-based keyword check.

**Supported providers:**
- **Claude** (Anthropic API) — set `provider: claude` in `ai-config.yaml`
- **Blockbrain** — set `provider: custom` and configure `base_url`
- **Any OpenAI-compatible endpoint** — set `provider: openai` or `custom`

API keys are entered in the UI settings panel and stored in browser sessionStorage only — never in this repository.

## Roadmap

- [ ] **Rule editor in UI** — edit YAML rules directly in browser, commit via GitHub API
- [ ] **Full standard analysis** — given a standard ID, analyse the complete document against all 10 quality criteria from the Quality Criteria Catalogue
- [ ] **Data model diff check** — structural BC analysis against eclipse-tractusx/sldt-semantic-models
- [ ] **Standard improvement report** — AI-generated suggested revisions for the full standard

## Setup: GitHub Pages

1. Go to repository **Settings → Pages**
2. Source: Deploy from branch → `main` → `/` (root)
3. Save — URL appears within a few minutes

## Transfer to catenax-eV organisation

When ready: **Settings → General → Danger Zone → Transfer ownership** → enter `catenax-eV`.
All Issues, PRs, and history are preserved. GitHub Pages URL updates automatically.

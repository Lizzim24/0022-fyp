# Meeting Log — 10 June 2026

**Attendees:** Lizi Wang, Valerio  
**Type:** In-person meeting at CELab
**Next meeting:** Tuesday 16 June, 11:00

---

## Progress Update

- Data collection and deployment phase **complete**
- Pipeline is live across LFL machines; ~4 weeks of data will have accumulated by exhibition
- Next phase: **visualisation and dashboard development**

---

## Exhibition Proposal

- Form to be filled in on **Moodle** — detailed and comprehensive
- Valerio's guidance: imagine the actual physical setup in full detail
  - Power strips (quantity, cable lengths)
  - Support structure dimensions (W × D × H in cm)
  - Screen size and mounting method
  - Enclosure design
  - Every piece of equipment listed

### Display Format Decision

| Option | Format | Notes |
|--------|--------|-------|
| A | Looping video on screen | Passive, lower risk |
| **B ✓** | **Interactive touchscreen** | Visitor can explore freely |

- **Decision: Option B (interactive)**
- Security concern addressed by designing a **physical enclosure** — protects hardware while keeping the screen accessible for touch interaction

---

## Dashboard / Web App

### Structure (approved)

| Tab | Content |
|-----|---------|
| 1 | Raw data view |
| 2 | Analysis page |
| 3 | Scenario planner |

### Tech Stack

- **3D visualisation:** [Babylon.js](https://www.babylonjs.com/) (recommended over Unity and Three.js)
- **Charts:** [ECharts](https://echarts.apache.org/) 
- **Action:** find examples of 3D chart integrations with Three.js / Babylon.js
- **Grafana** noted as an alternative — easy InfluxDB integration, good for historical data views

### Scope

- Exhibition deadline is the hard requirement — must have something that communicates the concept clearly (does not need to be feature-complete)
- Post-exhibition: continuing to develop and refine the project is fine

---

## Action Items

| # | Task | Owner | Due |
|---|------|-------|-----|
| 1 | Fill in exhibition proposal form on Moodle | Lizi | ASAP |
| 2 | Plan physical setup: dimensions, equipment list, enclosure sketch | Lizi | Before proposal deadline |
| 3 | Research Babylon.js + ECharts 3D examples | Lizi | Before next meeting |
| 4 | Begin dashboard development | Lizi | Ongoing |
| 5 | Plan full dashboard content (all tabs, data sources, visualisation types, interactions) → then consult Danny & Simon (lab supervisors) for their needs and feedback | Lizi | Before next meeting |

# Meeting & Communication Log

**Project:** Operational Digital Twin for Shared Fabrication Equipment Using Heterogeneous Machine Telemetry
**Student:** Lizi Wang
**Programme:** MSc Connected Environments, CASA UCL

---

## [2026-06-04] Supervision Meeting — Digital Twin Direction & Exhibition Planning

**Parties:** Valerio Signorelli (Supervisor), Lizi Wang
**Type:** In-person meeting at CELab
**Next meeting:** Tuesday 9th June 2026, 11:00am (with Valerio)

### Items Presented

- Updated project timeline and Gantt chart (tasks: CELab Pipeline ✓, Fab Lab Pipeline, Digital Twin Build, Physical Exhibit Build & Polish, Final Report, Exhibition Open/Close, Crits)
- Live Supabase database tables showing real data from CELab pipeline
- Initial thinking on research directions

### Discussion

**Digital Twin research directions:**
Four directions proposed: operational awareness, availability prediction, anomaly detection, and machine utilisation analysis. Valerio responded positively and pushed further, suggesting the Digital Twin should be capable of **scenario-based predictive modelling** — for example:

- Given 15 students needing to complete assignments, estimate the number of jobs required
- Given total machine count and job queue, estimate time to completion
- If machines fail (e.g. 2 out of 4 go offline), predict revised completion time and impact
- Estimate filament/material consumption based on planned workload
- Predict likelihood of failures based on historical patterns

The overall direction is an **ML-informed planning model**: connecting job demand, machine availability, historical failure rates, and material stock into a system that can simulate different scenarios and their outcomes. The primary users are lab managers (operational planning) and students (scheduling awareness).

**Visualisation and Dashboard:**
- A website/dashboard is preferred over a standalone app — more accessible and easier to maintain
- The dashboard should be readable and engaging, not just a data dump
- Should include **real-time status** alongside **predictive/planning views**
- A calendar-based planning dashboard showing projected machine load, job completion estimates, and scenario comparisons was suggested
- Valerio encouraged making the interface genuinely useful and interesting, not just technically correct

**Next steps for research:**
- Visit Simon and Danny to understand their actual lab management needs and pain points
- Prepare a draft wireframe or feature table of the planned dashboard before the visit — this will give them something concrete to respond to and make the conversation more productive

**Exhibition:**
- Physical component: a model or representation of the lab environment, with the actual devices (or scaled models) showing their status via LED indicators
- Screen component: display historical data (approximately one month), time-accelerated (e.g. one minute representing one day) to show the system working over time
- Valerio advised **against showing live real-time data** at the exhibition — historical data with analysis is more controlled and visually compelling
- The screen should show the same historical data processed into meaningful analysis, charts, or predictions

### Decisions

- Research direction confirmed: scenario-based predictive modelling, not just passive monitoring
- Dashboard format: website with real-time status + planning/prediction views + calendar interface
- Exhibition: physical lab model with LEDs + screen showing historical data time-lapse and analysis
- Next action: visit Simon and Danny with a prepared wireframe to gather requirements

### Action Items

| Task | Owner | Deadline | Status |
|---|---|---|---|
| Visit Simon and Danny to discuss lab management needs | Lizi | Before next meeting | To do |
| Prepare dashboard wireframe / feature table before visit | Lizi | Before Simon/Danny visit | To do |
| Research scenario-based ML approaches for job scheduling prediction | Lizi | Ongoing | To do |
| Continue LFL pipeline setup (USB WiFi adapter ordered) | Lizi | This week | In Progress |
| Send Outlook invite for next meeting | Lizi | Immediately | Done |

### Follow-Up Questions

- What data does Simon/Danny currently use to manage lab scheduling? Is there any existing system?
- What is the minimum viable dataset needed to train a job completion prediction model?
- Should the calendar planning view show individual machine-level predictions or lab-level aggregates?
- What is the most useful scenario for the exhibition audience to see played out in the historical data time-lapse?

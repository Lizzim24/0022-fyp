# Communication Log

---

# Supervisor Email Exchange - 2026-05-28/29 (Late May)

## Meeting Type
Asynchronous email exchange with dissertation supervisor.

## Summary
This exchange covered three main areas: the correct process for booking dissertation supervision meetings, hardware and network setup for the second lab deployment, and the technical decision to use Supabase instead of InfluxDB. The supervisor also requested that a project timeline, milestones list, and initial literature review be prepared before the next meeting. The next meeting was confirmed for Wednesday 4th June at 11:00am.

## Key Points

### Meeting Booking
- The wrong booking link had been used, which only showed Monday availability.
- The correct dissertation supervision link was resent by the supervisor.
- Future meetings should be booked using the correct link or confirmed via Outlook calendar invitation.

### Hardware and Network Setup (Fabrication Lab)
- The second lab has no existing network infrastructure for the printers.
- The supervisor advised against adding a separate router.
- Recommended approach: configure the Raspberry Pi itself as a WiFi access point using RaspAP (https://raspap.com/), so printers connect directly to the Pi, which then connects to the school WiFi.
- No Pi 4 units are currently available in the lab. Pi 3 units may be available and should be sufficient.
- Contacted Steve to confirm Pi 3 availability. Awaiting reply.

### Database Choice: Supabase vs InfluxDB
- The supervisor questioned why Supabase was used instead of InfluxDB, which is covered in the programme.
- Current reasoning: the project is not only collecting telemetry. It also models relationships between machines, operational events, anomaly records, and aggregated analytics. These entities are closely connected, and PostgreSQL provides a more natural relational structure for this kind of data model.
- InfluxDB is well suited for high-frequency time-series telemetry, but the core research questions — operational awareness, utilisation analysis, anomaly detection — require relational modelling more than pure time-series storage.
- A more detailed comparison, including the possibility of a hybrid architecture (InfluxDB for raw telemetry, PostgreSQL for events and summaries), will be prepared for the next meeting.

### Meeting Preparation Requested
- Project timeline and milestones diagram
- System architecture overview
- Initial literature review notes

## Key Dates

| Date | Requirement |
|---|---|
| Tuesday 2 June | Supervisor NOT available |
| Wednesday 4 June, 11:00am | Dissertation supervision meeting (confirmed) |

## Decisions
- RaspAP approach adopted for second lab network setup instead of a separate router.
- Supabase remains the current database choice; a hybrid architecture comparison will be prepared.
- All meeting preparation materials (timeline, architecture, literature review, database comparison) to be completed before 3 June.

## Action Items

| Task | Owner | Deadline | Status |
|---|---|---|---|
| Prepare project timeline and milestones diagram | Lizi | Before 3 June | In Progress |
| Prepare system architecture overview | Lizi | Before 3 June | In Progress |
| Prepare Supabase vs InfluxDB comparison + hybrid architecture notes | Lizi | Before 3 June | In Progress |
| Prepare initial literature review notes | Lizz | Before 3 June | In Progress |
| Send Outlook calendar invite for Wed 4 June 11:00am | Lizi | Immediately | Done |
| Investigate RaspAP configuration on Pi 3 | Lizi | Before 3 June | In Progress |
| Confirm availability of Raspberry Pi 3 unit | Steve | ASAP | Awaiting Reply |

## Follow-Up Questions
- Is the hybrid architecture (InfluxDB + PostgreSQL) worth implementing at the current scale, or is Supabase sufficient for the full project scope?
- Which Raspberry Pi 3 model is available, and what are the storage and connectivity specs?
- Should the RaspAP access point be set up as a completely isolated network, or is it acceptable for the Pi to bridge traffic between the printers and the school WiFi?
- Should I add more devices in these lab by using related sensor to get their data？I'm thinking of how to implement them.
- Which data presentation method is more ideal for both exhibitions and research?

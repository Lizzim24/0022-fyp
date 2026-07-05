# Meeting Log — 22 June 2026

**Attendees:** Lizi, Valerio
**Type:** Quick progress check-in (in-person supervision)
**Next meeting:** 2 July 2026 10:00am

---

## Progress Update

**Physical / Exhibition Model**

- 3D-printed miniature printer models finalised and adjusted — all printing now complete
- Two variants produced: **Prusa (5 units)** and **Bambu (8 units)**
- **Acrylic panels** selected as the light-transmitting material
- **LED:** switched to **LED strips** — the pin-header LEDs originally considered didn't provide enough brightness

**Panel Text Form — Question for Valerio**

- Asked whether the title in the 100-word panel text form should read as a formal report title, or be tailored specifically for the exhibition audience

### Valerio's Feedback

- Keep the title simple and easy to understand — should be accessible and friendly to a general public audience

---

## Data Collection — Raspberry Pi Agent Update

- Based on feedback from a classmate, added logic to the Raspberry Pi data-collection agent (`lfl_agent.py`&`prusa_mqtt_agent.py`) to stop **manual print stops** being misread as machine faults
- Previously, a printer being manually stopped mid-job could look identical to an actual error/fault in the logged events
- New logic: track each machine's last known print progress (`last_print_progress`) while its state is `PRINTING`
- When a machine transitions from `PRINTING` to a non-printing state (`IDLE` / `FINISH` / `STOPPED` / `PAUSED`, plus `PAUSE` / `UNKNOWN` for Bambu), the agent now logs a distinct `print_stopped_manual` event (severity: warning, not error), recording the exact progress % at which the print was stopped
- Implemented for both machine types: **Bambu** (in the MQTT `on_message` handler) and **Prusa** (in the polling loop)
- Also hardened the Bambu MQTT handler with broader exception handling so unexpected errors are logged rather than silently crashing the client loop

---

## Discussion & Next Steps

- Valerio suggested starting to write the report
- Valerio shared his upcoming schedule: business travelling **4–10 July**; annual leave starts **17 August**
- Lizi borrowed the **iPad** from Valerio
- Lizi noted she will prioritise **dashboard development** over the coming week

---

## Action Items

| # | Task | Owner | Due |
|---|------|-------|-----|
| 1 | Finalise all 3D-printed printer models (Prusa x5, Bambu x8) | Lizi | Done |
| 2 | Confirm acrylic as light-transmitting material | Lizi | Done |
| 3 | Switch LED solution to LED strips | Lizi | Done |
| 4 | Decide panel text form title style (simple/public-friendly) | Lizi | Done |
| 5 | Begin drafting report | Lizi | Ongoing |
| 6 | Prioritise dashboard development | Lizi | Next week |
| 7 | Borrow iPad from Valerio | Lizi | Ongoing |
| 8 | Add manual-stop detection to Pi agent (Bambu + Prusa) | Lizi | Done |

# Individual Supervision Meeting - 2026-05-11

## Meeting Type

Individual supervision meeting with my dissertation supervisor.

## Summary

This meeting focused on narrowing down the dissertation topic and selecting a specific research object. I presented three possible topics. After discussion, the final direction became a digital twin of the lab, because it has clearer practical meaning than the other two options. The project will focus on understanding equipment usage status, collecting and analysing data, identifying failures or availability issues, and presenting the physical and virtual parts together through a digital twin.

## Key Points

### Topic Selection

- I presented three possible dissertation topics.
- The last two topics were considered to have less practical significance.
- The selected direction is to develop a digital twin for the lab.
- This topic has a clearer relationship to real equipment, real usage, data collection, and practical analysis.

### Proposed Research Direction

The project may explore how a digital twin can be used to:

- Understand the usage status of lab equipment.
- Collect data from devices and analyse patterns.
- Infer or identify failures from the collected data.
- Predict equipment availability or analyse usage behaviour.
- Present both the physical and virtual parts of the system in the final exhibition.

The current direction is not fully finalised, but the project is likely to investigate lab equipment usage and represent it through a digital twin. One possible additional feature could be a booking system or another way of connecting user behaviour with equipment availability, but this still needs further research and definition.

### Physical and Virtual Exhibition Output

- The exhibition could include both a physical component and a virtual component.
- The physical component may relate to the actual equipment, sensors, or a prototype setup.
- The virtual component may show the digital twin interface, live data, equipment status, availability prediction, or usage analysis.
- The project should make the connection between the real lab and its digital representation clear to the audience.

### Data Collection from 3D Printers

- The Prusa 3D printer data may need to be accessed through an API.
- The collected data could then be sent to MQTT.
- The system may subscribe to MQTT topics and record the data for later analysis.
- A technical limitation is that the data or messages may only be accessible through a specific Wi-Fi network.
- This limitation may also apply to the 3D printers in the downstairs lab.

### Technical Implementation Questions

- An ESP32 or Raspberry Pi may be needed to connect devices, collect data, and upload data to MQTT.
- A method needs to be found for transmitting data reliably from the lab equipment to the digital twin system.
- The workflow may involve API access, MQTT publishing and subscribing, data storage, and visualisation.
- More technical research is needed to confirm what data can be accessed, what network restrictions exist, and what hardware is required.

## Decisions

- The dissertation topic will focus on a lab digital twin rather than the other two proposed topics.
- The project should have both practical meaning and a clear data-driven research component.
- The project should investigate equipment usage status, failure inference, availability prediction, or usage pattern analysis.
- The exhibition should aim to show both the physical system and the virtual digital twin representation.

## Action Items

| Task | Owner | Deadline / Timing | Status |
|---|---|---|---|
| Refine the research question around the lab digital twin | Me | Next stage | To do |
| Investigate what data can be accessed from Prusa 3D printers through the API | Me | Next technical research stage | To do |
| Check whether the printer data can be sent to MQTT | Me | Next technical research stage | To do |
| Confirm Wi-Fi or network restrictions for accessing printer data | Me | Before implementation | To do |
| Research whether ESP32 or Raspberry Pi is more suitable for the data pipeline | Me | Before prototype development | To do |
| Explore whether the project needs a booking system or another interaction model | Me | During concept development | To do |
| Plan how the physical and virtual components will be shown in the exhibition | Me | Exhibition planning stage | To do |

## Follow-Up Questions

- What is the most suitable research question for the lab digital twin?
- Should the project focus more on failure detection, availability prediction, usage pattern analysis, or public visualisation?
- Is a booking system necessary, or would it make the project too broad?
- What exact data can be collected from the Prusa printers?
- How can the physical and virtual parts be connected clearly in the exhibition?


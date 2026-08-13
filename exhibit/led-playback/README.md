# `led-playback/` — the physical model's LED light show

The exhibition console has a 3D-printed miniature of every printer, each lit by two addressable LEDs. This folder is the **offline playback** system that drives them: it takes a month of real status from Supabase, bakes it into a compact timeline, and an Arduino replays it as a looping light show on the model. It runs **standalone — no Wi-Fi, no laptop, no live database** — which is exactly what you want on an exhibition floor.

> Previously lived at `deploy/supabase/ArduinoTimeline/`. It has nothing to do with the database definition, so it now sits with the rest of the physical build.

## How it works

```
Supabase  ──export──▶  *.csv  ──generate_timeline.py──▶  timeline.h  ──▶  PrinterLEDPlayback.ino  ──▶  26 LEDs
 (history)             (raw status/events)              (baked frames)      (Arduino)              (the model)
```

1. Historical status is exported to CSV (`hourly_status*.csv`, `machine_events.csv`).
2. `generate_timeline.py` maps each machine's status at each time-step to a **state code 0–4** and writes `timeline.h` — the `timeline[NUM_FRAMES][NUM_PRINTERS]` array plus per-frame durations.
3. `PrinterLEDPlayback.ino` plays those frames in a loop, with a start "breath" animation and an end flash.

## Hardware

| | |
|---|---|
| Board | **Arduino MKR WiFi 1010** (SAMD21). 13 GPIO used: **D2–D10 + A0–A3**, one pin per printer. |
| LEDs | Adafruit NeoPixel (WS2812), **2 per printer × 13 printers = 26**, `NEO_GRB + NEO_KHZ800` |
| Brightness | 35 / 255 (gentle, exhibition-friendly) |
| Library | [`Adafruit_NeoPixel`](https://github.com/adafruit/Adafruit_NeoPixel) |
| Power | 5 V; 26 LEDs at brightness 35 draw little, but power the strips from 5 V (not the 3.3 V pin) |

The MKR 1010 was chosen for its **larger memory** — the whole month of status is baked into `timeline.h` and held on-device, which is too big for an Uno/Nano. **Its Wi-Fi is not used**: playback is deliberately offline, so the model needs nothing but power to run.

Pin → printer mapping is the array order in the `.ino` (CoreOne-3, H2D-01…04, XL-01/02, X1C-02/01, CoreOne-2/6/4/5).

## LED status legend

| Code | Meaning | Colour (R,G,B) |
|:---:|---|---|
| 0 | Offline | dim white (35,35,35) |
| 1 | Ready / idle | blue (0,0,120) |
| 2 | Printing | green (0,120,0) |
| 3 | Warning | amber (120,80,0) |
| 4 | Error | red (120,0,0) |

This is the mapping printed on the console's physical **LEGEND** panel — keep the two in sync if you change the colours.

## Files

| File | Role |
|------|------|
| `PrinterLEDPlayback/PrinterLEDPlayback.ino` | The Arduino sketch (setup / loop / animations). |
| `PrinterLEDPlayback/timeline.h` | **Generated** — baked frames + durations. Do not hand-edit. |
| `generate_timeline.py` | Builds `timeline.h` from the CSV exports. |
| `hourly_status.csv`, `hourly_status_2.csv`, `lfl_hourly_status.csv` | Exported per-hour status snapshots. |
| `machine_events.csv` | Exported events (large — see note). |

## Regenerate + flash

```bash
# 1. (optional) re-export fresh CSVs from Supabase, then:
python3 generate_timeline.py                 # writes PrinterLEDPlayback/timeline.h
# 2. Open PrinterLEDPlayback.ino in the Arduino IDE
#    Boards Manager → install "Arduino SAMD Boards (MKR)" and select MKR WiFi 1010
#    Library Manager → install "Adafruit NeoPixel"
#    Select your board + port → Upload
```

## Worth adding (currently missing)

- A **wiring diagram / pin map** (which pin drives which miniature, plus the 5 V/GND rail) — the single most useful thing for anyone rebuilding it.
- A short **bill of materials** (MKR WiFi 1010, NeoPixel count/type, wire, the wood, the tablet).
- A photo or short clip of the lit model (see `../media/` and `media/hero_device.gif`).

## Note on the CSVs
`machine_events.csv` is ~2 MB and the CSVs together are ~3.4 MB of **generated input**. That is fine to keep for reproducibility, but if you want a lean repo you could keep just one representative export and regenerate the rest, or move the raw dumps out of version control.

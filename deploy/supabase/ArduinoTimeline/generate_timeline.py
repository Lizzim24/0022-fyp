import pandas as pd
import os

INPUT_CSV = "hourly_status_2.csv"
OUTPUT_H = "timeline.h"

MACHINES = [
    "81f266ba-6d33-437a-88ab-d02a14437c88", # P1 CoreOne-3
    "d23c6dd1-a002-4d80-8f2a-78924a25efcf", # P2 H2D-01
    "859dcf38-b6b6-4c4c-a6f9-efaf35aa2117", # P3 H2D-02
    "79288b1c-84a8-4095-9ab0-3d3d63d28c12", # P4 H2D-03
    "a4ad3be2-5b4e-4037-a061-c9dc325e90c9", # P5 H2D-04
    "f806fdec-37c2-40ad-8bde-63bb377b6b3a", # P6 XL-01
    "b0c2a2c6-2ace-462c-be90-bbe15f0344bf", # P7 XL-02
    "e7adc2a8-0246-470b-9fd3-0ef427b64f65", # P8 X1C-02
    "a05622c0-9f49-4578-90de-dfcb3e5c0f2d", # P9 X1C-01
    "c2416b33-cc2a-4f71-9bbf-3fa24d7702df", # P10 CoreOne-2
    "b4cc8da5-dd88-4492-8f9a-82b7f31fef1a", # P11 CoreOne-6
    "79ade4be-7076-4aec-bd6b-942bd3791cf0", # P12 CoreOne-4
    "51b05e66-1679-4776-afbc-d38ca8629dc8", # P13 CoreOne-5
]

# 1 hour real data = 250ms lighting effect
# About 24 days = 144 seconds; 30 days about 180 seconds
MS_PER_HOUR = 250

def map_state(state, online):
    if str(online).lower() == "false":
        return 0  # offline = white

    if pd.isna(state):
        return 0

    state = str(state).upper()

    if state in ["IDLE", "FINISHED", "STOPPED"]:
        return 1  # blue

    if state in ["PRINTING", "BUSY", "PREPARING"]:
        return 2  # green

    if state in ["PAUSED", "ATTENTION"]:
        return 3  # yellow

    if state == "ERROR":
        return 4  # red

    return 0

df = pd.read_csv(INPUT_CSV)
df["timestamp"] = pd.to_datetime(df["timestamp"])
df["state_code"] = df.apply(lambda r: map_state(r["state"], r["online"]), axis=1)

hours = sorted(df["timestamp"].unique())

frames = []

for hour in hours:
    row = []
    hour_df = df[df["timestamp"] == hour]

    for machine_id in MACHINES:
        machine_row = hour_df[hour_df["machine_id"] == machine_id]

        if machine_row.empty:
            row.append(0)
        else:
            row.append(int(machine_row.iloc[0]["state_code"]))

    frames.append(row)

# shorten consecutive identical frames
compressed = []
last = None
duration = 0

for frame in frames:
    if frame == last:
        duration += MS_PER_HOUR
    else:
        if last is not None:
            compressed.append((duration, last))
        last = frame
        duration = MS_PER_HOUR

compressed.append((duration, last))

with open(OUTPUT_H, "w") as f:
    f.write("#pragma once\n\n")
    f.write("#define NUM_PRINTERS 13\n")
    f.write(f"#define NUM_FRAMES {len(compressed)}\n\n")

    f.write("const uint16_t frameDuration[NUM_FRAMES] = {\n")
    f.write(", ".join(str(d) for d, _ in compressed))
    f.write("\n};\n\n")

    f.write("const uint8_t timeline[NUM_FRAMES][NUM_PRINTERS] = {\n")
    for duration, frame in compressed:
        f.write("  {" + ", ".join(map(str, frame)) + "},\n")
    f.write("};\n")

print("Done.")
print("Raw hours:", len(hours))
print("Compressed frames:", len(compressed))
print("Output:", OUTPUT_H)
print("timeline.h size:", round(os.path.getsize(OUTPUT_H) / 1024, 2), "KB")
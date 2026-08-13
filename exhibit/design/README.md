# `design/` — fabrication sources for the physical console

Everything that was 3D-printed or laser-cut to build the exhibition model: the printer miniatures, the structural supports, and the laser-cut enclosure layers. The lit, assembled result is the project's hero image (`media/hero_device.gif`); this folder is how it was made.

> Moved here from `media/design/`. `media/` is for images; these are editable fabrication files, so they live with the rest of the physical build.

## Contents

### `3D model/` — the parts on show
| File | What it is |
|------|-----------|
| `bambu.stl` | Bambu printer miniature (used for the H2D and X1C machines). |
| `Prusa.stl` | Prusa printer miniature (Core One / XL machines). |
| `lab_sign.3mf` | The lab signage / label piece (multi-colour, hence `.3mf`). |
| `orange.stl` | Small accent part. |

Print **one miniature per machine on the console** (13 total: mix of `bambu.stl` and `Prusa.stl` to match the real fleet).

### `3D support/` — structure that holds it together
Corner mounts and fixings for the enclosure and the raised section:
`bottom-left.stl`, `bottom-right.stl`, `top-left.stl`, `top-right.stl` (corner brackets), `fix-1.stl`, `fix-2.stl` (clips/fixings), `stairs.stl` (the stepped/raised platform).

### `laser cut/` — the enclosure layers
| File | What it is |
|------|-----------|
| `base-liz.dxf` | The base layer outline. |
| `first-layer.dxf` | The first stacked layer (with cut-outs / engraving detail). |

Cut from sheet stock; the layers stack to form the console body around the embedded tablet.

## Print / cut settings

<!-- Fill in what you actually used so others can reproduce it: -->
- **Material:** _e.g. PLA_ · **Nozzle:** _0.4 mm_ · **Layer height:** _0.2 mm_ · **Infill:** _…_
- **Miniatures needed:** _N × bambu.stl, N × Prusa.stl_
- **Laser stock:** _material + thickness (e.g. 3 mm plywood)_ · **machine/settings:** _…_

## Incomplete — worth adding
This is a partial set. To make the build fully reproducible, add:

- The **remaining laser-cut layers** — only the base and first layer are here, but the console is a multi-layer stack with the tablet cut-out and side walls. Export the rest as `.dxf`/`.svg`.
- The **LEGEND panel** and the **"Print Lab Digital Twin / Touch to Explore"** face-panel source files.
- **Editable sources** (`.f3d` / `.step` / `.scad`) alongside the meshes, so parts can be modified rather than re-modelled from STL.
- A short **assembly note or exploded view**, and a **bill of materials** (board, LEDs, wood, tablet, fixings).
- The LED wiring is documented separately in [`../led-playback/`](../led-playback).

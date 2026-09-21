# Recipe B: image → 3D model (research-updated variant, A/B test 2026-09-12)

Same goal and rules as recipe A (trace the reference; never draw from the description alone; one coordinate
frame; every inner wall connected; iterate on the flat preview; deliver STL + generator + notes). What
changes, from the 2026-09-12 research reports:

## B0. The two stages, and which one you are in
This job has two stages that fail for different reasons and are judged by different things. Do not mix them.

**B0.1 — DRAFTING: settle the drawing.** Deliverable: `out/artwork.png`, a flat top view of your 2-D centrelines,
thin strokes on white, at the design's real proportions. No extrusion, no booleans, no mesh, no verifier, no STL.
A round here costs seconds; a round in B0.2 costs half an hour, so everything that can be decided on paper is
decided here.

1. Put the drawing **beside the reference and go feature by feature, in writing**: name each feature the spec lists
   and say whether it reads. "The treeline reads as a row of firs" / "the treeline reads as a zigzag" — not "looks
   close". A feature you cannot name is a feature you have not checked.
2. Check the **spacing rule now, where a fix is free**. An impression wall of width W centred on its path consumes
   W before any gap exists, so two neighbouring paths need centrelines at least **W + 1.5 mm** apart (1.4 mm walls
   -> 3.0 mm). Measure the minimum centreline separation across the whole drawing. Fix violations by moving lines,
   never by thinning walls: a gap that closes on paper is a solid blob in the print and a smear in the dough.
3. Junctions are binary. Two paths either **share a point exactly** — so their strokes fuse into one solid — or stay
   **>= 2.0 mm apart**. Nothing in between; a near-miss is the defect that looks fine on screen and prints as a blob.
4. **Simplify by construction, never by decimation.** When the reference carries finer detail than your wall can
   hold, do not trace it and then drop points: a decimated trace is not a simpler shape, it is noise that used to be
   a shape. Take only the *layout* from the image — where a band runs, where the tips sit — and draw the feature
   yourself as a parametric shape at a size the wall can carry. Count how many elements the space affords at
   W + 1.5 mm spacing **before** you draw any of them, and if the honest answer is nine where the photo has thirty,
   draw nine.
5. Satisfying every rule is not the same as looking right. A shape can be geometrically perfect and still read as
   the wrong object — triangles hanging from a line satisfy every constraint above and read as teeth. Judge the
   picture as a picture, and if it reads wrong, change the shape rather than tuning its numbers.

**If your task is tagged `drafting`, B0.1 is the whole job: stop at the approved drawing and deliver it. Ignore
everything below about STLs, meshes and verifiers.** If a reviewer is in the loop, stop and show them
`artwork.png` before going further, whatever the tag says.

**B0.2 — MODELLING: build the solid.** Only once the drawing reads correctly and the spacing rule holds. Apply wall
widths and tapers, decide the final size, then follow B2-B5 and the task's own verifier. If clearance forces a
change to the artwork at this point, go back to B0.1 with the specific line that has to move — do not quietly
redraw geometry that was already approved.

## B1. Rectify the photograph before you trace it
A reference photo is taken at an angle. Every proportion you read off it is then wrong by a perspective
transform, and every downstream measurement inherits that error: a circular design traces as an ellipse, a
symmetrical feature comes out lopsided, and scaling to mm mis-sizes the whole part.

Do this first, before masks, thresholds or tracing:
1. Find four points whose true geometry you know — the corners of a rectangular frame, or (easiest) the design's
   own outer boundary when it is a known shape such as a circle.
2. Solve the homography (`cv2.findHomography` / `cv2.getPerspectiveTransform`) that maps them to their true
   positions, and warp the image (`cv2.warpPerspective`).
3. Save the rectified image and **look at it**. A circular design should now be a true circle. Trace only this.

On the alpine cutter (2026-09-20) the one model that rectified first produced visibly better line work in the
peaks and slopes than four models that traced the raw photo, and the rectified image was good enough to keep as
the benchmark's reference. It costs one extra step and improves everything after it.

## B2. The model never hand-writes coordinates
Hand-fitting Bézier control points is where most tokens went. Instead:
1. Trace to SVG with **vtracer** (`pip` package, deterministic, one call) or potrace; keep the raw trace.
   ```python
   import vtracer; vtracer.convert_image_to_svg_py('lineart.png', 'trace.svg', colormode='binary', mode='spline', filter_speckle=8, corner_threshold=60, length_threshold=4.0, splice_threshold=45)
   ```
2. Parse the SVG into paths with **svgpathtools** (`svg2paths2`), sample each path to a polyline (≥ 8 points
   per segment), and give every path an **id**. Write `paths.json` (id → points, length, closed?) and render
   `paths_labelled.png` with the id printed on each path.
3. Edit by **id**, not by coordinates: a small `edits.json` with `drop: [ids]`, `bridge: [[idA, idB]]`
   (join nearest endpoints), `close: [ids]`, `outline: id`. Re-render, look, adjust. Three or four rounds.
4. Level the baseline and scale to mm once, from the outline's width and the spec's numbers.

## B3. Geometry in Python with shapely + manifold3d, no OpenSCAD
Offsets and unions in shapely (GEOS) are the robust part; extrusion and booleans in manifold3d
(guaranteed manifold output). Build per band, union the 2-D profiles *before* extruding:
```python
from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union
import manifold3d as m3d, trimesh, numpy as np
outline = Polygon(outline_pts)                                   # closed outer path
blade  = outline.buffer(wall).difference(outline)               # cutting wall outside the line
details = unary_union([LineString(p).buffer(inner_wall/2) for p in inner_paths]).intersection(outline.buffer(wall/2))
flange = outline.buffer(grip).difference(outline.buffer(-0.75))
# manifold3d: CrossSection from shapely rings, then extrude each band; taper = extrude(..., scale_top=...) or short stacked bands
```
Export with trimesh (`Trimesh(vertices, faces).export('cutter.stl')`). If a boolean fails, simplify the 2-D
input (`.simplify(0.05)`, `.buffer(0)`), never widen walls to force it.

## B4. Judge yourself before exporting
Two numeric checks against the cleaned trace, both on the installed libraries:
- **Hausdorff** (`scipy.spatial.distance.directed_hausdorff`) between the sampled artwork points and the
  cleaned trace points, both in trace pixels: report the value; if any path's directed distance is > 3% of the
  outline width, that path is wrong or missing.
- **SSIM** (`skimage.metrics.structural_similarity`) between a thresholded top-view render of your 2-D
  artwork and the cleaned trace image at the same size: report it; below ~0.6 means the layout does not match.
Write both numbers into NOTES.md for every iteration. They are your early fail signal; do not export a mesh
while they are bad.

## B5. Repair and printability
After export: `pymeshfix.MeshFix(v, f).repair()` and compare face counts before/after (a large change
means your CSG was sloppy: fix the input, do not ship the repaired mesh silently). Then the usual: watertight,
one body, section loop counts at flange / mid / just below inner-wall top / cutting edge, extents in the box,
then the task's own verifier.

## B6. Deliverables
`out/artwork.png` (the approved 2-D draft from B0), STL, `build.py` (trace → paths.json → edits.json → geometry → STL, reproducible), `paths.json`, `edits.json`,
top-view preview, NOTES.md with Hausdorff/SSIM per iteration, verifier output, tool versions, doubts.

## Tools (all pre-installed; run Python via the workspace shim)
vtracer, svgpathtools, shapely, manifold3d, trimesh (+rtree), pymeshfix, scipy, scikit-image, opencv-python-headless,
Pillow, numpy, matplotlib. potrace and OpenSCAD 2021 are in `tools/` if you prefer them; OpenSCAD's console
binary only, under a timeout.

**Windows Python — do this exactly.** Your workspace root has a `py.cmd` shim → a working Python 3.12 with every
library above. Invoke it as **`.\py.cmd`** (`.\py.cmd build.py`, `.\py.cmd verify.py out\cutter.stl`). Do NOT use the
bare `py` launcher (it finds no Python in the sandbox), and **never `pip install`** — network is blocked (`WinError 10013`)
and everything is already installed.

## Anti-patterns (unchanged)
Drawing from the text while the image sits unused; stopping at "the gate passes"; widening walls or filling
regions to make a union succeed; writing outside `out/`.

# Recipe B: image → 3D model (research-updated variant, A/B test 2026-09-12)

Same goal and rules as recipe A (trace the reference; never draw from the description alone; one coordinate
frame; every inner wall connected; iterate on the flat preview; deliver STL + generator + notes). What
changes, from the 2026-09-12 research reports:

## B1. The model never hand-writes coordinates
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

## B2. Geometry in Python with shapely + manifold3d, no OpenSCAD
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

## B3. Judge yourself before exporting
Two numeric checks against the cleaned trace, both on the installed libraries:
- **Hausdorff** (`scipy.spatial.distance.directed_hausdorff`) between the sampled artwork points and the
  cleaned trace points, both in trace pixels: report the value; if any path's directed distance is > 3% of the
  outline width, that path is wrong or missing.
- **SSIM** (`skimage.metrics.structural_similarity`) between a thresholded top-view render of your 2-D
  artwork and the cleaned trace image at the same size: report it; below ~0.6 means the layout does not match.
Write both numbers into NOTES.md for every iteration. They are your early fail signal; do not export a mesh
while they are bad.

## B4. Repair and printability
After export: `pymeshfix.MeshFix(v, f).repair()` and compare face counts before/after (a large change
means your CSG was sloppy: fix the input, do not ship the repaired mesh silently). Then the usual: watertight,
one body, section loop counts at flange / mid / just below inner-wall top / cutting edge, extents in the box,
then the task's own verifier.

## B5. Same deliverables as A
STL, `build.py` (trace → paths.json → edits.json → geometry → STL, reproducible), `paths.json`, `edits.json`,
top-view preview, NOTES.md with Hausdorff/SSIM per iteration, verifier output, tool versions, doubts.

## Tools (all installed for `py` on this machine)
vtracer, svgpathtools, shapely, manifold3d, trimesh (+rtree), pymeshfix, scipy, scikit-image, opencv-python-headless,
Pillow, numpy, matplotlib. potrace and OpenSCAD 2021 are in `tools/` if you prefer them; OpenSCAD's console
binary only, under a timeout.

## Anti-patterns (unchanged)
Drawing from the text while the image sits unused; stopping at "the gate passes"; widening walls or filling
regions to make a union succeed; writing outside `out/`.

# Recipe: image → 3D model (printable STL from reference photos or artwork)

Distilled from the run that passed the cookie-cutter benchmark (GPT-6 Astra, ultra, 2026-09-12) and the
four runs that failed it at the same time. The single biggest separator: **the pass traced the reference
image; the fails drew curves from the written description.** When an image exists, trace it.

## 0. Before you draw anything
- Identify the **design source image** (the flattest, most head-on view of the artwork; for a cookie
  cutter that is the *cookie impression* photo, not the plastic cutter). Use the others only to confirm
  proportions and which lines are cutting edges vs. impression lines.
- Read the **engineering numbers** from the spec (footprint, wall widths, heights, minimum feature) into
  named parameters at the top of your CAD file. Do not invent dimensions.
- Decide the **coordinate frame** once: work in reference-image pixels for all artwork, and scale to mm
  in one place in the CAD. Never resize individual paths.

## 1. Trace the image (raster → clean line art)
Python (`numpy`, `Pillow`, `scipy`, `scikit-image`), then `potrace`.
1. Convert to grayscale; **upscale 3×** (LANCZOS) so thin lines survive.
2. **Flatten lighting**: divide by a broad Gaussian-blurred copy of the image (radius ≈ 10 px × scale),
   then high-pass so grooves/lines become positive values. Save every intermediate as a PNG and look at it.
3. **Threshold sweep** (e.g. 30/45/60/80); pick by eye the one that keeps lines and drops texture.
4. **Keep the design, drop the noise**: label connected components; keep the largest (the outline) plus
   any component whose centroid lies inside the outline's bounding box and is ≥ ~2% of its area. One
   `binary_closing` pass; crop with a margin. Save as PBM (black lines on white).
5. **Vectorize** with potrace: `potrace -s -t 20 --alphamax 1 lineart.pbm -o lineart.svg`
   (`-s` = SVG, `-t` = drop specks, `--alphamax` = curve smoothness).
6. **Outline vs. inner lines are separate problems**:
   - *Outline*: fill holes on the closed outer contour; if it has gaps, `binary_closing` with the smallest
     radius that makes `binary_fill_holes` enclose the interior, or bridge from a dilated convex-hull
     perimeter. Export as its own SVG/polygon.
   - *Inner impression lines*: skeletonize; **bridge gaps** by extending each endpoint along its local
     tangent (PCA over ~14 px) to the nearest skeleton pixel within a forward cone; iterate until no new
     bridges; remove stray dashes; dilate 1 px. Export as its own SVG.
7. Level the baseline (rotate so a known-flat edge is horizontal) before fitting.

## 2. Fit parametric artwork (the editable source of truth)
- Write `build_artwork.py` that holds the design as **explicit path commands** (`M`, `C` cubic Bézier,
  `L`) in reference-pixel coordinates, one list for the outline and one per inner path, with a comment per
  path saying what it is ("skirt hem", "left lobe", …). Fit them to the traced SVG; smooth by hand where the
  trace is ragged. Restore continuity across gaps the trace missed.
- The script samples each curve (≥ 8 points per segment, more for long ones) and emits:
  `artwork.scad` (OpenSCAD point lists), `artwork.json` (the same numbers, for hashing/diffing) and
  `outline.svg` (a flat preview you and the reviewer can compare to the reference).
- **Every inner path must connect** to the outline or to another inner path (the part must be one body).
  Where the design leaves an island (a small detail floating in a gap), connect it with the thinnest
  allowed wall or a low rib at flange height, and say so in the notes.

## 3. Build the solid in OpenSCAD (CSG, not mesh surgery)
Portable OpenSCAD is enough (`openscad.com` on Windows). Structure that worked:
```
silhouette()            = polygon(outline_points), scaled to mm
blade_ring(w)           = offset(r=w) silhouette() − silhouette()          // cutting wall, outside the line
details(w)              = union of offset(r=w/2) over each open path polygon
                          + (offset(+w/2) − offset(−w/2)) for each closed loop  // strokes, not fills
flange                  = offset(r=grip) silhouette() − offset(r=−0.75) silhouette()   // at z = 0..1.5
ribs                    = low bars (rib_width) crossing the interior, clipped to the silhouette,
                          only where needed to tie islands; leave the interior open
band(z0, z1, ...)       = linear_extrude of the 2-D union for that height range
```
- Extrude in **bands**: flange+ribs (0..1.5), full walls, then a short **taper** to the thin cutting edge
  and to the impression edge (4 steps is enough). Inner walls stop below the cutting edge by the spec's
  setback.
- Union 2-D profiles *before* extruding each band: far faster exports and no coincident-face artifacts.
  Add a tiny `epsilon` overlap (0.02 mm) between bands.
- `mirror([1,0,0])` at the end if the impression must read correctly on the cookie/part (a cutter is the
  mirror of the print it leaves).
- Put `assert()`s on minimum widths and heights so a bad parameter fails loudly.
- Export: `openscad.com --export-format binstl -o cutter.stl model.scad`. Always the **console binary
  `openscad.com`**, never `openscad.exe` (the GUI binary), and always under a timeout (`timeout 600` /
  `-print-timeout`): a crash dialog ("exception 0x40000015") blocks the process until someone clicks it.
  That exception is CGAL aborting on degenerate 2-D input: self-intersecting or coincident-edge polygons,
  zero-width offsets, duplicate points. Fix the artwork (simplify, remove duplicate/near-duplicate points,
  keep offsets ≥ 0.1 mm), or union the 2-D profiles with shapely/manifold3d first; do not retry the same
  export. Render previews from the top in the *impression* orientation (that is what the reviewer compares)
  and one isometric.

## 4. Validate (your own checks, then the task's gate)
- Watertight, one connected body, consistent winding, no duplicate or zero-area triangles.
- **Sections at several heights** (flange, mid, just below the inner-wall top, cutting edge): count closed
  loops and check wall widths — inner lines present at mid height, absent at the cutting edge, a single
  ~spec-width loop at the edge.
- Extents inside the spec's box; volume matches the 2-D profile areas × heights (catches missing bands).
- Then run the task's own verifier exactly as instructed and paste its output into the notes.

## 5. Iterate on the flat preview, not the mesh
Compare `outline.svg` / the top-view preview to the reference **before** every export. Change one path at a
time; keep the rest byte-identical (hash `artwork.json` parts so you can prove what changed). Most of the
work is in step 2; a mesh that passes the gate but does not resemble the reference is a fail.

## 6. Deliver
STL (binary), the generator scripts (`build_artwork.py`, the `.scad`), a top-view preview, notes with the
verification output, the exact tool versions used, and an honest list of doubts (which curves were
guessed, which reference view was ambiguous). If you installed a tool, give the exact install command.

## Tools
| Need | Tool | Get it |
|---|---|---|
| Raster → vector | potrace 1.16 | `tools/potrace-1.16.win64/potrace.exe` if present; else https://potrace.sourceforge.net (win64 zip) |
| CSG + STL export | OpenSCAD 2021.01 | `tools/openscad-2021.01/openscad.com` if present; else `winget install OpenSCAD.OpenSCAD` |
| Image cleanup | numpy, Pillow, scipy, scikit-image | `py -m pip install --user numpy pillow scipy scikit-image` |
| Mesh checks | trimesh (+rtree), shapely, manifold3d | `py -m pip install --user trimesh rtree shapely manifold3d` |

**Windows Python — do this exactly.** Your workspace root has a `py.cmd` shim pointing at a working Python 3.12
with every library above already installed. Invoke it as **`.\py.cmd`** (e.g. `.\py.cmd verify.py out\cutter.stl`,
`.\py.cmd generate.py`). Do NOT use the bare `py` launcher — inside the sandbox it cannot find Python and reports
"No installed Python found". **Never `pip install` anything** — the sandbox blocks network and the libraries are
already present; an install attempt fails with `WinError 10013` and wastes the run. If `.\py.cmd` ever fails, call
the interpreter directly at the path the shim contains (`type py.cmd` to read it).

## Anti-patterns seen in the failed runs
- Drawing Béziers from the verbal description while the reference image sat unused.
- Stopping at "it exports and the gate passes"; the gate checks geometry, the reviewer checks resemblance.
- Widening walls or filling regions to make the union succeed instead of fixing the paths.
- Writing outside the assigned output folder.

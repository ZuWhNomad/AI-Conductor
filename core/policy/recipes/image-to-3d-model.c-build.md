# Recipe C, stage 2 (build): labelled paths → printable STL

You are the **build stage** of a two-model pipeline. A cheaper model has already traced the reference into
`out/lineart.png`, `out/trace.svg`, `out/paths.json`, `out/paths_labelled.png` and `out/TRACE_NOTES.md`. Start from
those. Re-trace only if the trace is unusable, and say so in NOTES.md (that is a finding about the pipeline).

## Method (same as recipe B from here)
1. **Inspect the trace** against the reference photo: `paths_labelled.png` beside `ref/`. Read `TRACE_NOTES.md`.
2. **Edit by id**, never by coordinates: `edits.json` with `drop: [ids]`, `bridge: [[idA, idB]]` (join nearest
   endpoints), `close: [ids]`, `outline: id`, optional `smooth: {id: tolerance}`. Re-render `artwork_preview.png`,
   look, adjust. As many rounds as it takes to resemble the reference; write what changed each round.
3. **Scale once** to mm from the outline width and the spec's numbers; level the baseline if the trace notes say so.
4. **Geometry in Python**: shapely for offsets/unions (outline buffer for the blade ring, `LineString.buffer(w/2)`
   for stroked inner lines, `unary_union`, flange = `buffer(grip) − buffer(−0.75)`, ribs only where needed to tie
   islands), manifold3d for extrusion per band (flange, full walls, short tapers to the cutting edge and to the
   impression edge) and booleans, trimesh to export. If a boolean fails, simplify the 2-D input
   (`.simplify(0.05)`, `.buffer(0)`); never widen walls to force it. Mirror if the impression must read correctly.
5. **Judge yourself before exporting**: directed Hausdorff (scipy) between your edited artwork and the cleaned trace,
   in trace pixels, per path (> 3% of outline width = wrong/missing); SSIM (scikit-image) between a thresholded
   top-view render of the artwork and `lineart.png` at the same size (< ~0.6 = layout mismatch). Log both per
   iteration in NOTES.md. Do not export a mesh while they are bad.
6. **Repair and validate**: `pymeshfix` repair and compare face counts (a big change = sloppy CSG, fix the input);
   watertight, one body, section loop counts at flange / mid / just below inner-wall top / cutting edge, extents in
   the box; then the task's own verifier, output pasted into NOTES.md.

## Deliverables (in `out/`)
`cutter.stl`, `build.py` (paths.json + edits.json → geometry → STL, reproducible), `edits.json`, `artwork_preview.png`,
top-view preview, `NOTES.md` (trace assessment, edits per round, Hausdorff/SSIM per iteration, verifier output, tool
versions, doubts — including whether the cheap trace was good enough).

## Tools (installed for `py`)
shapely, manifold3d, trimesh (+rtree), pymeshfix, scipy, scikit-image, svgpathtools, vtracer, opencv-python-headless,
numpy, Pillow, matplotlib. OpenSCAD 2021 is in `tools/` (console binary only, under a timeout) if you prefer it.
If the `py` launcher finds no Python inside the sandbox, call `%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe` directly and say so.

## Anti-patterns
Redoing the trace from scratch without saying why; hand-writing coordinates; stopping at "the gate passes"; widening
walls or filling regions to make a union succeed; writing outside `out/`.

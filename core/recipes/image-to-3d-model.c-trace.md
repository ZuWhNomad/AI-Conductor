# Recipe C, stage 1 (trace): reference image → labelled vector paths

You are the **tracing stage** of a two-model pipeline. A stronger model will take your output and build the 3D
part; it will not redo your work, so make it clean and self-describing. You do not build any 3D geometry.

## Deliverables (all in `out/`)
- `lineart.png` — the cleaned binary line art (black lines on white) of the design source image.
- `trace.svg` — the vectorised line art (vtracer or potrace).
- `paths.json` — `{ "px_per_mm": <number or null>, "outline": <id>, "paths": [ { "id": n, "closed": bool, "length_px": x, "points": [[x,y],...] } ] }`
  with every path sampled to a polyline (≥ 8 points per curve segment), ids stable, the outer cutting outline identified.
- `paths_labelled.png` — the paths drawn over the line art with each id printed on it, plus a rendering of the
  original reference beside it, so the next model can see what is what.
- `TRACE_NOTES.md` — which image you used, the threshold you chose and why, which paths you think are noise, which
  gaps you saw (path ids at each side), whether the baseline needed levelling (angle), and anything you were unsure of.

## Method
1. Pick the flattest, most head-on **design source** image (for a cookie cutter: the cookie *impression* photo, not
   the plastic cutter). Grayscale, upscale 3× (LANCZOS).
2. Flatten lighting (divide by a broad Gaussian blur, radius ≈ 10 px × scale), high-pass, then a **threshold sweep**
   (30/45/60/80): save each as PNG, look at them, pick the one that keeps lines and drops texture. Say which.
3. Keep the design: label connected components, keep the largest (outline) and components inside its bounding box
   that are ≥ ~2% of its area; one `binary_closing`; crop with margin. Level the baseline if the photo is skewed
   (rotate; record the angle).
4. Vectorise: `vtracer.convert_image_to_svg_py(...)` (binary, spline) or `potrace -s -t 20 --alphamax 1`. Parse with
   `svgpathtools.svg2paths2`; sample; assign ids; find the outline (largest closed path or the outer contour).
5. Render `paths_labelled.png`. Look at it next to the reference. If a feature of the design is obviously missing or a
   line is broken into pieces, note the ids; do **not** hand-draw curves.

## Tools (installed for `py`)
numpy, Pillow, scipy, scikit-image, opencv-python-headless, vtracer, svgpathtools, matplotlib; `tools/potrace-1.16.win64/potrace.exe`.
If the `py` launcher finds no Python inside the sandbox, call `%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe` directly and say so.

## Rules
Write only inside `out/`. No 3D. No hand-drawn coordinates. Be honest about noise and gaps: the builder relies on your notes.

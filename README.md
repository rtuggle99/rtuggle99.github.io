# Board & Die Workshop

An interactive customizer for a rolling-cube puzzle board: pick a grid
size, theme it, place blocked spaces and a goal, trace a path, add dice
and custom images, and export the result as a standalone TikZ file or a
ready-to-print PDF - all client-side, nothing is uploaded anywhere.

## Files

```
board_tikz.html          page structure + sidebar controls
style.css                 styling
board.js                   Three.js scene: board/die/block geometry, orbit camera, click handling
tikz.js                     turns the current state + camera angle into a .tex string
pdfexport.js              wraps the bundled pdfTeX engine to compile that .tex to a PDF
app.js                     state + wires the UI to board.js / tikz.js / pdfexport.js
PdfTeXEngine.js
swiftlatexpdftex.js           \_ SwiftLaTeX's WebAssembly pdfTeX build (MIT/EPL licensed,
swiftlatexpdftex.wasm         /  from github.com/SwiftLaTeX/SwiftLaTeX). These three files
                                  must stay next to board_tikz.html - the engine loads
                                  swiftlatexpdftex.js via a relative path.
```

Three.js and OrbitControls are pulled from a CDN at runtime (see the
`<script>` tags in `board_tikz.html`); everything else is self-contained.

## Deploying to GitHub Pages

1. Copy all the files above into your repo, keeping them all in the same
   directory - the relative paths matter, especially for the SwiftLaTeX
   engine files.
2. Commit and push. GitHub Pages serves static files as-is, no build step
   needed.
3. Visit `https://yourusername.github.io/board_tikz.html` (or wherever
   you placed it). Open it over `https://`, not a local `file://` URL -
   browsers block the Web Worker and WASM fetches the PDF engine needs
   when opened directly from disk. For local testing, run a tiny local
   server instead, e.g. `python3 -m http.server`, and open the printed
   `localhost` URL.

## How it works

- **The 3D preview** (left panel) is a fast Three.js approximation for
  editing. **"Render TikZ when idle"** (checked by default) compiles your
  actual TikZ code through the bundled pdfTeX engine about 0.8 seconds
  after you stop interacting, and shows that exact result in place of the
  preview - so what you see settles on the real output, not just the
  approximation. Any further interaction snaps back to the fast preview.
- **Download TikZ** writes a plain `tikz-3dplot` `.tex` file matching
  your current camera angle and board state.
- **Download PDF** compiles that same file through
  [SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX)'s pdfTeX-in-WASM
  engine, bundled with this site - a genuine vector PDF, not a
  screenshot. The first compile in a session fetches `tikz-3dplot` and a
  few other packages from SwiftLaTeX's package server, so it needs
  network access and takes a few seconds; later compiles are faster.

### Known limitation

Both PDF compiling and "Render TikZ when idle" depend on SwiftLaTeX's
public package server being reachable - a small third-party project,
not something either of us controls. If a compile ever fails, "Download
TikZ" always works offline, and you can compile that file yourself
locally or on Overleaf as a fallback.

## Extending it

Everything reads from one plain-object `state` at the top of `app.js`
(grid size, theme, blocked cells and their face images, goal, pip
labels, traced path, dice, custom images, shading). `board.js`
re-renders the 3D scene from that object on every change, and `tikz.js`
reads the same object to build the export, so the two views can never
drift out of sync.

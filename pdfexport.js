/* pdfexport.js - compiles a .tex string to PDF fully in-browser using the
   SwiftLaTeX pdfTeX WebAssembly engine (bundled alongside this page as
   PdfTeXEngine.js / swiftlatexpdftex.js / swiftlatexpdftex.wasm). The first
   compile fetches tikz-3dplot and friends from SwiftLaTeX's package server,
   so it needs network access and is slower than later compiles. */

const PdfExport = (() => {
  let engine = null;
  let loadingPromise = null;

  function ensureEngine(onStatus) {
    if (engine) return Promise.resolve(engine);
    if (loadingPromise) return loadingPromise;
    onStatus && onStatus('Starting the LaTeX engine (first time only)…');
    engine = new PdfTeXEngine();
    loadingPromise = engine.loadEngine().then(() => engine).catch(err => {
      engine = null;
      loadingPromise = null;
      throw err;
    });
    return loadingPromise;
  }

  async function compile(texSource, onStatus, images) {
    const eng = await ensureEngine(onStatus);
    onStatus && onStatus('Compiling your board to PDF…');
    (images || []).forEach(img => {
      eng.writeMemFSFile(img.filename, img.bytes);
    });
    eng.writeMemFSFile('main.tex', texSource);
    eng.setEngineMainFile('main.tex');
    const result = await eng.compileLaTeX();
    if (result.status !== 0) {
      const tail = (result.log || '').split('\n').slice(-40).join('\n');
      throw new Error('pdfTeX did not finish cleanly:\n' + tail);
    }
    return new Blob([result.pdf], { type: 'application/pdf' });
  }

  return { compile };
})();

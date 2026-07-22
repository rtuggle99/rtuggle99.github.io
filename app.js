/* app.js - owns the board state, wires up the sidebar controls, and hooks
   the export buttons up to tikz.js / pdfexport.js. */

(() => {
  const state = {
    cols: 5,
    rows: 5,
    theme: 'wood',
    custom: {
      light: '#ff0000', dark: '#000000', border: '#600101',
      pipLight: '#000000', pipDark: '#ff0000', goal: '#0b7a0b',
      goalBorder: '#003300', goalPip: '#ffffff', block: '#ac796c'
    },
    // Default board matches the reference figure exactly (blocked spaces,
    // pip labels, and goal position/face all taken straight from the
    // source .tex file's own default \doblock / \squarelabel calls).
    blocked: new Set(['2,1', '0,3', '4,0', '0,4', '3,3', '4,3']),
    // Optional custom images on blocked-space faces, mirroring the die's
    // faceImages - a separate map (not folded into `blocked` itself) so
    // all the existing block add/remove/toggle logic stays untouched.
    // Keyed the same way as `blocked` ("c,r"), each value is
    // {top, front, right, back, left}, each of those either undefined or
    // {dataUrl, bytes, filename, opacity}. Which face is being edited
    // right now, per block, for the highlight-cycle UI.
    blockFaceImages: new Map(),
    blockSelectedFace: new Map(),
    goal: { c: 4, r: 4 },
    goalFace: 6,
    labels: new Map([
      ['0,1', 2], ['0,2', 6], ['1,2', 4], ['1,1', 2], ['1,0', 3],
      ['2,0', 1], ['3,0', 4], ['3,1', 3], ['4,1', 6], ['4,2', 3],
      ['3,2', 2], ['2,2', 4], ['2,3', 1], ['1,3', 5], ['1,4', 3],
      ['2,4', 1], ['3,4', 4]
    ]),
    // A list of separate route segments, so a path can be ended and a new
    // one started without joining them together.
    paths: [[]],
    pathStyle: { color: '#8c2f27', thickness: 2.2, endStyle: 'arrow' },
    // Global visibility toggle for all dice at once - independent of
    // actually removing individual dice from the array below.
    showDice: true,
    // Each die is fully independent: its own orientation, position,
    // colors, per-face pip rotation, and highlighted-face state. Full
    // die orientation (not just the top value) is kept per die -
    // back/left/bottom are always the opposite-face partner (7 minus
    // top/front/right), so a die can never end up invalid no matter how
    // it gets rotated.
    dice: [{
      id: 1,
      die: { top: 1, front: 2, right: 3 },
      position: { c: 0, r: 0 },
      colors: { body: '#ffffff', pip: '#1a1a1a' },
      // Tracks each numbered face's own visual rotation (0/90/180/270),
      // indexed by pip value (1-6) rather than position, since a
      // physical sticker keeps its own accumulated twist as it moves
      // between positions. Spin/tilt update this automatically so the
      // die visually behaves like it's actually rotating, not just
      // relabeling faces. Also directly editable via the "rotate this
      // face" control for a manual, one-off adjustment.
      faceRotation: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
      // Which numbered faces have their pips removed (blanked), indexed
      // by pip value for the same reason faceRotation is - a physical
      // sticker's blank status travels with it as the die rotates.
      blankFaces: {},
      // Optional custom image per numbered face, indexed by pip value.
      // {dataUrl, bytes, filename, opacity}. Drawn instead of (or with)
      // the pip pattern - see keepPipsWithImage.
      faceImages: {},
      // Which face is currently chosen in this die's "nudge one face's
      // pips" control, so the 3D preview can highlight it live.
      selectedFace: null
    }],
    // One consistent shading model applied to every object's own base
    // color (border, blocks, die alike) - front/right darker, back/left
    // lighter, matching the paper's own Right(85)/Back(93) values.
    // Bottom is omitted since no object's underside is ever rendered.
    shading: { front: 75, back: 92, left: 92, right: 75, top: 100 },
    // Optional: when true, the checkerboard's own light/dark squares
    // brighten/dim together with the Top shading slider too, instead of
    // always staying at their fixed theme colors regardless of shading.
    tieBoardToTopShading: false,
    // Set by clicking a direction's name in the Shading panel, to
    // highlight every matching face on the board at once.
    shadingHighlight: null,
    // A simple 0-4 layer scale shared by the path, pip labels/goal, and
    // every custom image, so any of them can be told to sit above or
    // below any of the others. Higher draws later (on top). Pips/goal
    // sit at a fixed baseline of 2; the path and each sticker can be
    // moved anywhere on the scale independently. Blocks and the die are
    // never part of this - they're raised 3D objects, so they always
    // cover flat content regardless of layer.
    pathLayer: 3,
    // Custom images placed on the board, each anchored at its top-left
    // cell and spanning wCols x hRows. bytes is a Uint8Array (used when
    // compiling to PDF), dataUrl is for the 3D preview and thumbnails.
    // layer follows the same 0-4 scale as pathLayer. rotation is in
    // degrees (0/90/180/270), applied on top of the image's natural
    // orientation. fit is 'stretch' (fill the whole wCols x hRows box,
    // distorting the image's own aspect ratio if it doesn't match) or
    // 'contain' (keep the image's natural proportions, centered in the
    // box with the leftover space as padding).
    stickers: [],
    pendingImage: null, // {dataUrl, bytes, filename, naturalW, naturalH} - set after upload, placed on next cell click
    stickerSize: { wCols: 1, hRows: 1 },
    pendingStickerLayer: 3,
    pendingStickerRotation: 0,
    pendingStickerFit: 'stretch',
    pendingStickerOpacity: 1,
    pendingStickerMirrored: false,
    // Also used for the global cell-color-override tool and border toggle.
    cellColors: new Map(),
    pendingCellColor: '#4a7c59',
    pipColors: new Map(),
    pendingPipColor: '#c0392b',
    showBorder: true,
    // Board height (the base slab/border's thickness) can go all the
    // way to 0 - a flat board with no visible thickness. Slab height is
    // how tall blocked-space markers stand above the board surface.
    boardHeight: 0.45,
    slabHeight: 0.3,
    tool: 'orbit',
    labelValue: 3
  };

  const CONTENT_LAYER = 2; // fixed baseline for pips/goal

  // How many distinct layerable things currently exist - content (pips
  // and the goal, always counts as one), the path (if it has any points),
  // and each placed image. Bounding the layer range to roughly this many
  // slots above/below content gives enough room to place anything
  // anywhere relative to everything else, without letting a "move up"
  // button run off to some arbitrarily large number that means nothing
  // once there's nowhere left to move past.
  function countLayerableItems() {
    const hasPath = state.paths.some(seg => seg.length > 0);
    return 1 + (hasPath ? 1 : 0) + state.stickers.length;
  }
  function layerBounds() {
    const n = countLayerableItems();
    return { min: CONTENT_LAYER - n, max: CONTENT_LAYER + n };
  }
  function clampLayer(value) {
    const { min, max } = layerBounds();
    return Math.max(min, Math.min(max, value));
  }

  function currentPath() { return state.paths[state.paths.length - 1]; }

  let nextStickerId = 1;
  function placeSticker(c, r) {
    if (!state.pendingImage) return;
    const { wCols, hRows } = state.stickerSize;
    if (c + wCols > state.cols || r + hRows > state.rows) return;
    state.stickers.push({
      id: nextStickerId++,
      dataUrl: state.pendingImage.dataUrl,
      bytes: state.pendingImage.bytes,
      filename: state.pendingImage.filename,
      naturalW: state.pendingImage.naturalW || 1,
      naturalH: state.pendingImage.naturalH || 1,
      c, r, wCols, hRows,
      layer: state.pendingStickerLayer,
      rotation: state.pendingStickerRotation,
      fit: state.pendingStickerFit,
      opacity: state.pendingStickerOpacity,
      mirrored: state.pendingStickerMirrored
    });
  }
  function removeSticker(id) {
    state.stickers = state.stickers.filter(s => s.id !== id);
  }
  function rotateSticker(id, delta) {
    const s = state.stickers.find(s => s.id === id);
    if (!s) return;
    s.rotation = ((s.rotation + delta) % 360 + 360) % 360;
  }
  function setStickerLayer(id, layer) {
    const s = state.stickers.find(s => s.id === id);
    if (!s) return;
    s.layer = layer;
  }
  function setStickerFit(id, fit) {
    const s = state.stickers.find(s => s.id === id);
    if (!s) return;
    s.fit = fit;
  }
  function setStickerMirrored(id, mirrored) {
    const s = state.stickers.find(s => s.id === id);
    if (!s) return;
    s.mirrored = mirrored;
  }
  function setStickerOpacity(id, opacity) {
    const s = state.stickers.find(s => s.id === id);
    if (!s) return;
    s.opacity = opacity;
  }
  function setCellColor(c, r, hex) {
    state.cellColors.set(`${c},${r}`, hex);
  }
  function clearCellColor(c, r) {
    state.cellColors.delete(`${c},${r}`);
  }
  function setPipColor(c, r, hex) {
    state.pipColors.set(`${c},${r}`, hex);
  }
  function clearPipColor(c, r) {
    state.pipColors.delete(`${c},${r}`);
  }

  let nextDieId = 2; // die id 1 is the default one already in state.dice
  function addDie(c, r) {
    state.dice.push({
      id: nextDieId++,
      die: { top: 1, front: 2, right: 3 },
      position: { c, r },
      colors: { body: '#ffffff', pip: '#1a1a1a' },
      faceRotation: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
      blankFaces: {},
      faceImages: {},
      selectedFace: null
    });
  }
  function removeDie(id) {
    state.dice = state.dice.filter(d => d.id !== id);
  }
  function findDie(id) {
    return state.dice.find(d => d.id === id);
  }

  function bumpFaceRotation(dieObj, value, delta) {
    const cur = dieObj.faceRotation[value] || 0;
    dieObj.faceRotation[value] = ((cur + delta) % 360 + 360) % 360;
  }
  function toggleBlankFace(dieObj, value) {
    dieObj.blankFaces[value] = !dieObj.blankFaces[value];
  }
  function setFaceImage(dieObj, value, imageData) {
    if (imageData) dieObj.faceImages[value] = imageData;
    else delete dieObj.faceImages[value];
  }
  function setBlockFaceImage(key, face, imageData) {
    let faces = state.blockFaceImages.get(key);
    if (!faces) {
      faces = {};
      state.blockFaceImages.set(key, faces);
    }
    if (imageData) faces[face] = imageData;
    else delete faces[face];
  }
  function cycleBlockSelectedFace(key) {
    const cycle = [null, 'top', 'front', 'right', 'back', 'left'];
    const cur = state.blockSelectedFace.get(key) || null;
    const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
    if (next) state.blockSelectedFace.set(key, next);
    else state.blockSelectedFace.delete(key);
    return next;
  }

  // Spinning rotates around the vertical axis: top/bottom stay in place
  // (so their own pip pattern visibly rotates in place, opposite
  // directions from each other since they face opposite ways) while
  // front/right/back/left values cycle between positions without
  // needing their own rotation touched, since carrying a sticker to an
  // adjacent side without twisting it leaves it looking the same.
  function spinDie(dieObj) {
    const d = dieObj.die;
    bumpFaceRotation(dieObj, d.top, 90);
    bumpFaceRotation(dieObj, 7 - d.top, -90);
    dieObj.die = { top: d.top, front: 7 - d.right, right: d.front };
  }
  // Tilting rotates around the left-right axis: left/right stay in
  // place and rotate, top/front/bottom/back cycle without needing their
  // own rotation touched, by the same logic as spinning.
  function tiltDie(dieObj) {
    const d = dieObj.die;
    bumpFaceRotation(dieObj, d.right, 90);
    bumpFaceRotation(dieObj, 7 - d.right, -90);
    dieObj.die = { top: 7 - d.front, front: d.top, right: d.right };
  }

  const $ = sel => document.querySelector(sel);
  const canvas = $('#board-canvas');

  function key(c, r) { return `${c},${r}`; }

  function clampToGrid() {
    const inRange = (c, r) => c >= 0 && c < state.cols && r >= 0 && r < state.rows;
    state.blocked = new Set([...state.blocked].filter(k => {
      const [c, r] = k.split(',').map(Number);
      return inRange(c, r);
    }));
    for (const k of [...state.blockFaceImages.keys()]) {
      const [c, r] = k.split(',').map(Number);
      if (!inRange(c, r)) { state.blockFaceImages.delete(k); state.blockSelectedFace.delete(k); }
    }
    if (state.goal && !inRange(state.goal.c, state.goal.r)) state.goal = null;
    for (const k of [...state.labels.keys()]) {
      const [c, r] = k.split(',').map(Number);
      if (!inRange(c, r)) state.labels.delete(k);
    }
    for (const k of [...state.cellColors.keys()]) {
      const [c, r] = k.split(',').map(Number);
      if (!inRange(c, r)) state.cellColors.delete(k);
    }
    for (const k of [...state.pipColors.keys()]) {
      const [c, r] = k.split(',').map(Number);
      if (!inRange(c, r)) state.pipColors.delete(k);
    }
    state.paths = state.paths
      .map(seg => seg.filter(p => inRange(p.c, p.r)))
      .filter(seg => seg.length > 0);
    if (state.paths.length === 0) state.paths = [[]];
    state.stickers = state.stickers.filter(s =>
      inRange(s.c, s.r) && s.c + s.wCols <= state.cols && s.r + s.hRows <= state.rows);
    state.dice = state.dice.filter(d => inRange(d.position.c, d.position.r));
  }

  function rebuild() {
    Board3D.rebuild(state);
    renderStickerList();
    refreshPathLayerButtons();
    refreshPendingLayerButtons();
  }

  // ---- board size ----
  $('#cols').addEventListener('input', e => {
    state.cols = Number(e.target.value);
    $('#cols-val').textContent = state.cols;
    clampToGrid();
    rebuild();
    renderDiceList();
  });
  $('#rows').addEventListener('input', e => {
    state.rows = Number(e.target.value);
    $('#rows-val').textContent = state.rows;
    clampToGrid();
    rebuild();
    renderDiceList();
  });

  // ---- theme ----
  $('#theme-segmented').addEventListener('click', e => {
    const btn = e.target.closest('button[data-theme]');
    if (!btn) return;
    state.theme = btn.dataset.theme;
    document.querySelectorAll('#theme-segmented button').forEach(b => b.classList.toggle('active', b === btn));
    $('#custom-colors').hidden = state.theme !== 'custom';
    rebuild();
  });

  const colorInputs = {
    '#c-light': 'light', '#c-dark': 'dark', '#c-border': 'border',
    '#c-piplight': 'pipLight', '#c-pipdark': 'pipDark', '#c-goal': 'goal',
    '#c-goalborder': 'goalBorder', '#c-goalpip': 'goalPip', '#c-block': 'block'
  };
  Object.entries(colorInputs).forEach(([sel, prop]) => {
    $(sel).addEventListener('input', e => {
      state.custom[prop] = e.target.value;
      if (state.theme === 'custom') rebuild();
    });
  });

  // ---- tools ----
  document.querySelectorAll('.tool').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tool = btn.dataset.tool;
      document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === btn));
    });
  });


  $('#pip-select').addEventListener('click', e => {
    const btn = e.target.closest('button[data-val]');
    if (!btn) return;
    state.labelValue = Number(btn.dataset.val);
    document.querySelectorAll('#pip-select button').forEach(b => b.classList.toggle('active', b === btn));
  });

  $('#btn-undo-path').addEventListener('click', () => {
    currentPath().pop();
    rebuild();
  });
  $('#btn-clear-path').addEventListener('click', () => {
    state.paths = [[]];
    rebuild();
  });
  $('#btn-new-path').addEventListener('click', () => {
    if (currentPath().length === 0) return;
    state.paths.push([]);
    rebuild();
  });

  $('#c-pathcolor').addEventListener('input', e => {
    state.pathStyle.color = e.target.value;
    rebuild();
  });
  $('#path-thickness').addEventListener('input', e => {
    state.pathStyle.thickness = Number(e.target.value) / 10;
    $('#path-thickness-val').textContent = state.pathStyle.thickness.toFixed(1);
    rebuild();
  });
  function refreshPathLayerButtons() {
    const { min, max } = layerBounds();
    $('#path-layer-down').disabled = state.pathLayer <= min;
    $('#path-layer-up').disabled = state.pathLayer >= max;
  }
  $('#path-layer-down').addEventListener('click', () => {
    state.pathLayer = clampLayer(state.pathLayer - 1);
    $('#path-layer-val').textContent = state.pathLayer;
    refreshPathLayerButtons();
    rebuild();
  });
  $('#path-layer-up').addEventListener('click', () => {
    state.pathLayer = clampLayer(state.pathLayer + 1);
    $('#path-layer-val').textContent = state.pathLayer;
    refreshPathLayerButtons();
    rebuild();
  });
  $('#path-endstyle').addEventListener('change', e => {
    state.pathStyle.endStyle = e.target.value;
    rebuild();
  });

  $('#btn-clear-board').addEventListener('click', () => {
    state.blocked = new Set();
    state.blockFaceImages = new Map();
    state.blockSelectedFace = new Map();
    state.labels = new Map();
    state.goal = null;
    state.paths = [[]];
    state.stickers = [];
    rebuild();
    renderBlockList();
  });

  // ---- custom images ----
  let nextFilenameSuffix = 1;
  function sanitizeBase(name) {
    const base = name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'image';
    return base.slice(0, 40);
  }

  $('#image-upload').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const dataUrl = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
    const naturalSize = await new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
      img.onerror = () => resolve({ w: 1, h: 1 }); // fall back to square if it can't be read
      img.src = dataUrl;
    });
    const ext = file.type === 'image/jpeg' ? 'jpg' : 'png';
    const filename = `${sanitizeBase(file.name)}_${nextFilenameSuffix++}.${ext}`;
    state.pendingImage = { dataUrl, bytes, filename, naturalW: naturalSize.w, naturalH: naturalSize.h };
    $('#image-pending-name').textContent = file.name;
    $('#image-pending-name').closest('.field').hidden = false;
  });

  $('#sticker-wcols').addEventListener('input', e => {
    state.stickerSize.wCols = Math.max(1, Number(e.target.value));
    $('#sticker-wcols-val').textContent = state.stickerSize.wCols;
  });
  $('#sticker-hrows').addEventListener('input', e => {
    state.stickerSize.hRows = Math.max(1, Number(e.target.value));
    $('#sticker-hrows-val').textContent = state.stickerSize.hRows;
  });
  $('#btn-sticker-rotate').addEventListener('click', () => {
    state.pendingStickerRotation = (state.pendingStickerRotation + 90) % 360;
    $('#sticker-rotation-val').textContent = state.pendingStickerRotation;
  });
  function pendingLayerBounds() {
    // +1 for the pending image itself, since it becomes one more
    // layerable thing the moment it's actually placed.
    const n = countLayerableItems() + 1;
    return { min: CONTENT_LAYER - n, max: CONTENT_LAYER + n };
  }
  function refreshPendingLayerButtons() {
    const { min, max } = pendingLayerBounds();
    $('#sticker-layer-down').disabled = state.pendingStickerLayer <= min;
    $('#sticker-layer-up').disabled = state.pendingStickerLayer >= max;
  }
  $('#sticker-layer-down').addEventListener('click', () => {
    const { min, max } = pendingLayerBounds();
    state.pendingStickerLayer = Math.max(min, Math.min(max, state.pendingStickerLayer - 1));
    $('#sticker-layer-val').textContent = state.pendingStickerLayer;
    refreshPendingLayerButtons();
  });
  $('#sticker-layer-up').addEventListener('click', () => {
    const { min, max } = pendingLayerBounds();
    state.pendingStickerLayer = Math.max(min, Math.min(max, state.pendingStickerLayer + 1));
    $('#sticker-layer-val').textContent = state.pendingStickerLayer;
    refreshPendingLayerButtons();
  });
  $('#sticker-fit').addEventListener('change', e => {
    state.pendingStickerFit = e.target.value;
  });
  $('#sticker-opacity').addEventListener('input', e => {
    state.pendingStickerOpacity = Number(e.target.value) / 100;
    $('#sticker-opacity-val').textContent = e.target.value;
  });
  $('#sticker-mirror').addEventListener('change', e => {
    state.pendingStickerMirrored = e.target.checked;
  });
  $('#cell-color').addEventListener('input', e => {
    state.pendingCellColor = e.target.value;
  });
  $('#pip-color').addEventListener('input', e => {
    state.pendingPipColor = e.target.value;
  });
  $('#show-border').addEventListener('change', e => {
    state.showBorder = e.target.checked;
    rebuild();
  });
  $('#board-height').addEventListener('input', e => {
    state.boardHeight = Number(e.target.value);
    $('#board-height-val').textContent = state.boardHeight.toFixed(2);
    rebuild();
  });
  $('#slab-height').addEventListener('input', e => {
    state.slabHeight = Number(e.target.value);
    $('#slab-height-val').textContent = state.slabHeight.toFixed(2);
    rebuild();
  });

  function renderStickerList() {
    const list = $('#sticker-list');
    list.innerHTML = '';
    if (state.stickers.length === 0) {
      list.innerHTML = '<p class="help">No images placed yet.</p>';
      return;
    }
    state.stickers.forEach(s => {
      const row = document.createElement('div');
      row.className = 'sticker-row';
      const thumb = document.createElement('img');
      thumb.src = s.dataUrl;
      thumb.alt = s.filename;
      thumb.style.transform = `rotate(${s.rotation}deg)`;
      const label = document.createElement('span');
      label.textContent = `${s.filename} (${s.wCols}\u00d7${s.hRows} at col ${s.c}, row ${s.r})`;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-small';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => { removeSticker(s.id); rebuild(); });
      row.append(thumb, label, removeBtn);

      const controls = document.createElement('div');
      controls.className = 'sticker-controls';
      const rotateBtn = document.createElement('button');
      rotateBtn.className = 'btn btn-small';
      rotateBtn.textContent = `Rotate 90\u00b0 (${s.rotation}\u00b0)`;
      rotateBtn.addEventListener('click', () => {
        rotateSticker(s.id, 90);
        rebuild();
        renderStickerList();
      });
      const layerLabel = document.createElement('span');
      layerLabel.style.cssText = 'display:flex;align-items:center;gap:0.3rem;';
      const layerVal = document.createElement('span');
      layerVal.textContent = `Layer ${s.layer}`;
      const layerDownBtn = document.createElement('button');
      layerDownBtn.className = 'btn btn-small';
      layerDownBtn.textContent = '\u25bc';
      layerDownBtn.title = 'Move down one layer';
      const layerUpBtn = document.createElement('button');
      layerUpBtn.className = 'btn btn-small';
      layerUpBtn.textContent = '\u25b2';
      layerUpBtn.title = 'Move up one layer';
      function refreshThisLayerButtons() {
        const { min, max } = layerBounds();
        layerDownBtn.disabled = s.layer <= min;
        layerUpBtn.disabled = s.layer >= max;
      }
      refreshThisLayerButtons();
      layerDownBtn.addEventListener('click', () => {
        setStickerLayer(s.id, clampLayer(s.layer - 1));
        layerVal.textContent = `Layer ${s.layer}`;
        refreshThisLayerButtons();
        rebuild();
      });
      layerUpBtn.addEventListener('click', () => {
        setStickerLayer(s.id, clampLayer(s.layer + 1));
        layerVal.textContent = `Layer ${s.layer}`;
        refreshThisLayerButtons();
        rebuild();
      });
      layerLabel.append(layerVal, layerDownBtn, layerUpBtn);
      const fitLabel = document.createElement('label');
      fitLabel.textContent = 'Fit ';
      const fitSelect = document.createElement('select');
      [['stretch', 'Stretch to fill'], ['contain', 'Fit and center'], ['cover', 'Crop to fill']].forEach(([value, text]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        if (s.fit === value) opt.selected = true;
        fitSelect.appendChild(opt);
      });
      fitSelect.addEventListener('change', e => {
        setStickerFit(s.id, e.target.value);
        rebuild();
      });
      fitLabel.appendChild(fitSelect);
      const opacityLabel = document.createElement('label');
      opacityLabel.textContent = 'Opacity ';
      const opacityInput = document.createElement('input');
      opacityInput.type = 'range';
      opacityInput.min = 0;
      opacityInput.max = 100;
      opacityInput.value = Math.round((s.opacity != null ? s.opacity : 1) * 100);
      opacityInput.addEventListener('input', e => {
        setStickerOpacity(s.id, Number(e.target.value) / 100);
        rebuild();
      });
      opacityLabel.appendChild(opacityInput);
      const mirrorBtn = document.createElement('button');
      mirrorBtn.className = 'btn btn-small';
      mirrorBtn.textContent = s.mirrored ? 'Mirrored' : 'Mirror';
      mirrorBtn.classList.toggle('active', !!s.mirrored);
      mirrorBtn.addEventListener('click', () => {
        setStickerMirrored(s.id, !s.mirrored);
        mirrorBtn.textContent = s.mirrored ? 'Mirrored' : 'Mirror';
        mirrorBtn.classList.toggle('active', !!s.mirrored);
        rebuild();
      });
      controls.append(rotateBtn, layerLabel, fitLabel, opacityLabel, mirrorBtn);
      list.appendChild(row);
      list.appendChild(controls);
    });
  }

  $('#show-die').addEventListener('change', e => {
    state.showDice = e.target.checked;
    rebuild();
  });

  const FACE_CYCLE = [null, 'top', 'front', 'right', 'back', 'left'];

  const DIE_COLOR_PRESETS = [
    { name: 'Classic', body: '#ffffff', pip: '#1a1a1a' },
    { name: 'Ebony', body: '#1a1a1a', pip: '#ffffff' },
    { name: 'Crimson', body: '#b3261e', pip: '#ffffff' },
    { name: 'Cobalt', body: '#1a56b0', pip: '#ffffff' },
    { name: 'Forest', body: '#2e7d32', pip: '#ffffff' },
    { name: 'Amber', body: '#e8a317', pip: '#1a1a1a' }
  ];

  function renderDiceList() {
    const list = $('#dice-list');
    list.innerHTML = '';
    if (state.dice.length === 0) {
      list.innerHTML = '<p class="help">No dice on the board. Use the Die tool to add one.</p>';
      return;
    }
    state.dice.forEach(dieObj => {
      const row = document.createElement('div');
      row.className = 'sticker-row';
      const label = document.createElement('span');
      label.textContent = `Die at col ${dieObj.position.c}, row ${dieObj.position.r}`;
      const bodyLabel = document.createElement('label');
      bodyLabel.textContent = 'Face ';
      const bodyInput = document.createElement('input');
      bodyInput.type = 'color';
      bodyInput.value = dieObj.colors.body;
      bodyInput.addEventListener('input', e => { dieObj.colors.body = e.target.value; rebuild(); });
      bodyLabel.appendChild(bodyInput);
      const pipLabel = document.createElement('label');
      pipLabel.textContent = 'Pip ';
      const pipInput = document.createElement('input');
      pipInput.type = 'color';
      pipInput.value = dieObj.colors.pip;
      pipInput.addEventListener('input', e => { dieObj.colors.pip = e.target.value; rebuild(); });
      pipLabel.appendChild(pipInput);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-small';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => { removeDie(dieObj.id); rebuild(); renderDiceList(); });
      row.append(label, bodyLabel, pipLabel, removeBtn);

      const presetRow = document.createElement('div');
      presetRow.className = 'die-preset-row';
      DIE_COLOR_PRESETS.forEach(preset => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'die-preset-swatch';
        swatch.title = preset.name;
        swatch.style.background = preset.body;
        swatch.style.setProperty('--pip-color', preset.pip);
        swatch.addEventListener('click', () => {
          dieObj.colors.body = preset.body;
          dieObj.colors.pip = preset.pip;
          bodyInput.value = preset.body;
          pipInput.value = preset.pip;
          rebuild();
        });
        presetRow.appendChild(swatch);
      });
      list.appendChild(row);
      list.appendChild(presetRow);

      const controls = document.createElement('div');
      controls.className = 'sticker-controls';
      const spinBtn = document.createElement('button');
      spinBtn.className = 'btn btn-small';
      spinBtn.textContent = 'Spin';
      spinBtn.addEventListener('click', () => { spinDie(dieObj); rebuild(); });
      const tiltBtn = document.createElement('button');
      tiltBtn.className = 'btn btn-small';
      tiltBtn.textContent = 'Tilt';
      tiltBtn.addEventListener('click', () => { tiltDie(dieObj); rebuild(); });
      const nextFaceBtn = document.createElement('button');
      nextFaceBtn.className = 'btn btn-small';
      nextFaceBtn.textContent = 'Highlight next face';
      nextFaceBtn.classList.toggle('active', !!dieObj.selectedFace);
      nextFaceBtn.addEventListener('click', () => {
        const i = FACE_CYCLE.indexOf(dieObj.selectedFace);
        dieObj.selectedFace = FACE_CYCLE[(i + 1) % FACE_CYCLE.length];
        nextFaceBtn.classList.toggle('active', !!dieObj.selectedFace);
        rebuild();
        refreshFaceOpacitySlider();
      });
      const rotateFaceBtn = document.createElement('button');
      rotateFaceBtn.className = 'btn btn-small';
      rotateFaceBtn.textContent = 'Rotate highlighted face';
      rotateFaceBtn.addEventListener('click', () => {
        const position = dieObj.selectedFace;
        if (!position) return;
        const d = dieObj.die;
        const valueAt = { top: d.top, front: d.front, right: d.right, back: 7 - d.front, left: 7 - d.right }[position];
        bumpFaceRotation(dieObj, valueAt, 90);
        rebuild();
      });
      function highlightedValue() {
        const position = dieObj.selectedFace;
        if (!position) return null;
        const d = dieObj.die;
        return { top: d.top, front: d.front, right: d.right, back: 7 - d.front, left: 7 - d.right }[position];
      }
      const togglePipsBtn = document.createElement('button');
      togglePipsBtn.className = 'btn btn-small';
      togglePipsBtn.textContent = 'Toggle pips on highlighted face';
      togglePipsBtn.title = 'Show or hide the pip dots on whichever face is currently highlighted';
      togglePipsBtn.addEventListener('click', () => {
        const value = highlightedValue();
        if (!value) return;
        toggleBlankFace(dieObj, value);
        rebuild();
      });
      const faceImageLabel = document.createElement('label');
      faceImageLabel.className = 'btn btn-small';
      faceImageLabel.style.cursor = 'pointer';
      faceImageLabel.textContent = 'Image on highlighted face';
      faceImageLabel.title = 'Place an image on whichever face is currently highlighted';
      const faceImageInput = document.createElement('input');
      faceImageInput.type = 'file';
      faceImageInput.accept = 'image/png,image/jpeg';
      faceImageInput.hidden = true;
      faceImageInput.addEventListener('change', async e => {
        const value = highlightedValue();
        if (!value) { e.target.value = ''; return; }
        const file = e.target.files[0];
        if (!file) return;
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const dataUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });
        const ext = file.type === 'image/jpeg' ? 'jpg' : 'png';
        const filename = `${sanitizeBase(file.name)}_${nextFilenameSuffix++}.${ext}`;
        setFaceImage(dieObj, value, { dataUrl, bytes, filename, opacity: 1 });
        e.target.value = '';
        rebuild();
        refreshFaceOpacitySlider();
      });
      faceImageLabel.appendChild(faceImageInput);
      const clearFaceImageBtn = document.createElement('button');
      clearFaceImageBtn.className = 'btn btn-small';
      clearFaceImageBtn.textContent = 'Clear face image';
      clearFaceImageBtn.addEventListener('click', () => {
        const value = highlightedValue();
        if (!value) return;
        setFaceImage(dieObj, value, null);
        rebuild();
        refreshFaceOpacitySlider();
      });
      const faceOpacityLabel = document.createElement('label');
      faceOpacityLabel.textContent = 'Face image opacity ';
      faceOpacityLabel.title = 'Adjusts the opacity of whichever face image is currently highlighted';
      const faceOpacityInput = document.createElement('input');
      faceOpacityInput.type = 'range';
      faceOpacityInput.min = 0;
      faceOpacityInput.max = 100;
      function refreshFaceOpacitySlider() {
        const value = highlightedValue();
        const img = value ? dieObj.faceImages[value] : null;
        faceOpacityInput.value = Math.round((img && img.opacity != null ? img.opacity : 1) * 100);
        faceOpacityInput.disabled = !img;
      }
      refreshFaceOpacitySlider();
      faceOpacityInput.addEventListener('input', e => {
        const value = highlightedValue();
        const img = value ? dieObj.faceImages[value] : null;
        if (!img) return;
        img.opacity = Number(e.target.value) / 100;
        rebuild();
      });
      faceOpacityLabel.appendChild(faceOpacityInput);
      controls.append(spinBtn, tiltBtn, nextFaceBtn, rotateFaceBtn, togglePipsBtn, faceImageLabel, clearFaceImageBtn, faceOpacityLabel);
      list.appendChild(controls);
    });
  }

  const BLOCK_FACE_CYCLE = [null, 'top', 'front', 'right', 'back', 'left'];
  function renderBlockList() {
    const list = $('#block-list');
    if (!list) return;
    list.innerHTML = '';
    if (state.blocked.size === 0) {
      list.innerHTML = '<p class="help">No blocked spaces yet. Use the Block tool to add one.</p>';
      return;
    }
    [...state.blocked].sort().forEach(k => {
      const [c, r] = k.split(',').map(Number);
      const row = document.createElement('div');
      row.className = 'sticker-row';
      const label = document.createElement('span');
      label.textContent = `Block at col ${c}, row ${r}`;
      row.append(label);

      const controls = document.createElement('div');
      controls.className = 'sticker-controls';

      function highlightedFace() { return state.blockSelectedFace.get(k) || null; }
      function currentFaces() { return state.blockFaceImages.get(k) || {}; }

      const nextFaceBtn = document.createElement('button');
      nextFaceBtn.className = 'btn btn-small';
      nextFaceBtn.textContent = 'Highlight face';
      nextFaceBtn.classList.toggle('active', !!highlightedFace());
      nextFaceBtn.addEventListener('click', () => {
        cycleBlockSelectedFace(k);
        nextFaceBtn.classList.toggle('active', !!highlightedFace());
        rebuild();
        refreshBlockOpacitySlider();
      });

      const faceImageLabel = document.createElement('label');
      faceImageLabel.className = 'btn btn-small';
      faceImageLabel.style.cursor = 'pointer';
      faceImageLabel.textContent = 'Image on highlighted face';
      const faceImageInput = document.createElement('input');
      faceImageInput.type = 'file';
      faceImageInput.accept = 'image/png,image/jpeg';
      faceImageInput.hidden = true;
      faceImageInput.addEventListener('change', async e => {
        const face = highlightedFace();
        if (!face) { e.target.value = ''; return; }
        const file = e.target.files[0];
        if (!file) return;
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const dataUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });
        const ext = file.type === 'image/jpeg' ? 'jpg' : 'png';
        const filename = `${sanitizeBase(file.name)}_${nextFilenameSuffix++}.${ext}`;
        setBlockFaceImage(k, face, { dataUrl, bytes, filename, opacity: 1 });
        e.target.value = '';
        rebuild();
        refreshBlockOpacitySlider();
      });
      faceImageLabel.appendChild(faceImageInput);

      const clearFaceImageBtn = document.createElement('button');
      clearFaceImageBtn.className = 'btn btn-small';
      clearFaceImageBtn.textContent = 'Clear face image';
      clearFaceImageBtn.addEventListener('click', () => {
        const face = highlightedFace();
        if (!face) return;
        setBlockFaceImage(k, face, null);
        rebuild();
        refreshBlockOpacitySlider();
      });

      const faceOpacityLabel = document.createElement('label');
      faceOpacityLabel.textContent = 'Face image opacity ';
      const faceOpacityInput = document.createElement('input');
      faceOpacityInput.type = 'range';
      faceOpacityInput.min = 0;
      faceOpacityInput.max = 100;
      function refreshBlockOpacitySlider() {
        const face = highlightedFace();
        const img = face ? currentFaces()[face] : null;
        faceOpacityInput.value = Math.round((img && img.opacity != null ? img.opacity : 1) * 100);
        faceOpacityInput.disabled = !img;
      }
      refreshBlockOpacitySlider();
      faceOpacityInput.addEventListener('input', e => {
        const face = highlightedFace();
        const img = face ? currentFaces()[face] : null;
        if (!img) return;
        img.opacity = Number(e.target.value) / 100;
        rebuild();
      });
      faceOpacityLabel.appendChild(faceOpacityInput);

      controls.append(nextFaceBtn, faceImageLabel, clearFaceImageBtn, faceOpacityLabel);
      list.appendChild(row);
      list.appendChild(controls);
    });
  }

  ['front', 'back', 'left', 'right', 'top'].forEach(dir => {
    const el = $(`#shade-${dir}`);
    if (!el) return;
    el.addEventListener('input', e => {
      state.shading[dir] = Number(e.target.value);
      $(`#shade-${dir}-val`).textContent = state.shading[dir];
      rebuild();
    });
  });

  document.querySelectorAll('.shade-dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.dir;
      state.shadingHighlight = state.shadingHighlight === dir ? null : dir;
      document.querySelectorAll('.shade-dir-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.dir === state.shadingHighlight);
      });
      rebuild();
    });
  });

  const DEFAULT_SHADING = { front: 75, back: 92, left: 92, right: 75, top: 100 };
  $('#btn-reset-shading').addEventListener('click', () => {
    state.shading = { ...DEFAULT_SHADING };
    ['front', 'back', 'left', 'right', 'top'].forEach(dir => {
      const el = $(`#shade-${dir}`);
      if (!el) return;
      el.value = state.shading[dir];
      $(`#shade-${dir}-val`).textContent = state.shading[dir];
    });
    rebuild();
  });
  $('#tie-board-shading').addEventListener('change', e => {
    state.tieBoardToTopShading = e.target.checked;
    rebuild();
  });

  // ---- camera view presets ----
  $('#btn-view-aerial').addEventListener('click', () => Board3D.goToPreset('aerial'));
  $('#btn-view-isometric').addEventListener('click', () => Board3D.goToPreset('isometric'));

  function clearBlockFaceData(k) {
    state.blockFaceImages.delete(k);
    state.blockSelectedFace.delete(k);
  }

  // ---- cell interactions ----
  Board3D.onCellClick((c, r) => {
    const k = key(c, r);
    switch (state.tool) {
      case 'blocked':
        if (state.blocked.has(k)) { state.blocked.delete(k); clearBlockFaceData(k); }
        else if (!state.dice.some(d => d.position.c === c && d.position.r === r)) {
          state.blocked.add(k);
          if (state.goal && state.goal.c === c && state.goal.r === r) state.goal = null;
          state.labels.delete(k);
        }
        renderBlockList();
        break;
      case 'goal':
        if (state.goal && state.goal.c === c && state.goal.r === r) state.goal = null;
        else {
          state.goal = { c, r };
          state.blocked.delete(k);
          clearBlockFaceData(k);
        }
        renderBlockList();
        break;
      case 'label':
        state.blocked.delete(k);
        clearBlockFaceData(k);
        renderBlockList();
        if (state.labelValue === 0) state.labels.delete(k);
        else state.labels.set(k, state.labelValue);
        break;
      case 'path': {
        const seg = currentPath();
        const last = seg[seg.length - 1];
        if (last && last.c === c && last.r === r) seg.pop();
        else seg.push({ c, r });
        break;
      }
      case 'image': {
        const existing = state.stickers.find(s =>
          c >= s.c && c < s.c + s.wCols && r >= s.r && r < s.r + s.hRows);
        if (existing) removeSticker(existing.id);
        else placeSticker(c, r);
        break;
      }
      case 'die': {
        const existingDie = state.dice.find(d => d.position.c === c && d.position.r === r);
        if (existingDie) removeDie(existingDie.id);
        else if (!state.blocked.has(k)) addDie(c, r);
        renderDiceList();
        break;
      }
      case 'cellcolor': {
        const existingColor = state.cellColors.get(key(c, r));
        if (existingColor === state.pendingCellColor) clearCellColor(c, r);
        else setCellColor(c, r, state.pendingCellColor);
        break;
      }
      case 'pipcolor': {
        const existingPipColor = state.pipColors.get(key(c, r));
        if (existingPipColor === state.pendingPipColor) clearPipColor(c, r);
        else setPipColor(c, r, state.pendingPipColor);
        break;
      }
      default:
        return;
    }
    rebuild();
  });

  // ---- export: TikZ ----
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  $('#btn-tikz').addEventListener('click', async () => {
    const angles = Board3D.getCameraAngles();
    const { tex, images } = TikzExport.generate(state, angles);
    if (images.length === 0) {
      downloadBlob(new Blob([tex], { type: 'text/plain' }), 'board.tex');
      return;
    }
    const zip = new JSZip();
    zip.file('board.tex', tex);
    images.forEach(img => zip.file(img.filename, img.bytes));
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, 'board.zip');
  });

  // ---- export: PDF ----
  const statusEl = $('#compile-status');
  function setStatus(msg, isError) {
    if (!msg) {
      statusEl.classList.add('hidden');
      return;
    }
    statusEl.textContent = msg;
    statusEl.classList.remove('hidden');
    statusEl.classList.toggle('error', !!isError);
  }

  $('#btn-pdf').addEventListener('click', async () => {
    const btn = $('#btn-pdf');
    btn.disabled = true;
    try {
      const angles = Board3D.getCameraAngles();
      const { tex, images } = TikzExport.generate(state, angles);
      const blob = await PdfExport.compile(tex, msg => setStatus(msg, false), images);
      downloadBlob(blob, 'board.pdf');
      setStatus('Done - check your downloads.', false);
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      console.error(err);
      setStatus('Could not compile a PDF. You can still use "Download TikZ" and compile it yourself (e.g. on Overleaf). ' + (err && err.message ? err.message.split('\n')[0] : ''), true);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- exact render: compiles your real TikZ and shows it, not an approximation ----
  const exactFrame = $('#exact-render-frame');
  const autoToggle = $('#auto-exact-toggle');
  let exactUrl = null;
  let showingExact = false;
  let compiling = false;
  let lastStateSignature = null;

  // Cheap signature of everything that affects the render, so the idle timer
  // doesn't recompile when nothing has actually changed since last time.
  function stateSignature(angles) {
    return JSON.stringify({
      cols: state.cols, rows: state.rows, theme: state.theme, custom: state.custom,
      blocked: [...state.blocked].sort(), goal: state.goal, goalFace: state.goalFace,
      blockFaceImages: [...state.blockFaceImages.entries()].sort().map(([k, faces]) =>
        [k, Object.keys(faces).sort().map(f => [f, faces[f].filename, faces[f].opacity]).join(';')]),
      labels: [...state.labels.entries()].sort(), paths: state.paths, pathStyle: state.pathStyle,
      pathLayer: state.pathLayer,
      showDice: state.showDice,
      showBorder: state.showBorder,
      boardHeight: state.boardHeight, slabHeight: state.slabHeight,
      cellColors: [...state.cellColors.entries()].sort(),
      pipColors: [...state.pipColors.entries()].sort(),
      dice: state.dice.map(d => [
        d.id, d.die.top, d.die.front, d.die.right, d.position.c, d.position.r, d.colors.body, d.colors.pip,
        JSON.stringify(d.faceRotation), JSON.stringify(d.blankFaces),
        Object.keys(d.faceImages).sort().map(k => [k, d.faceImages[k].filename, d.faceImages[k].opacity]).join(';')
      ]),
      shading: state.shading,
      tieBoardToTopShading: state.tieBoardToTopShading,
      stickers: state.stickers.map(s => [s.id, s.c, s.r, s.wCols, s.hRows, s.filename, s.layer, s.rotation, s.fit, s.naturalW, s.naturalH, s.opacity]),
      theta: Math.round(angles.theta * 10), phi: Math.round(angles.phi * 10)
    });
  }

  async function showExact() {
    if (compiling) return;
    compiling = true;
    try {
      const angles = Board3D.getCameraAngles();
      const sig = stateSignature(angles);
      const { tex, images } = TikzExport.generate(state, angles);
      const blob = await PdfExport.compile(tex, () => {}, images);
      if (exactUrl) URL.revokeObjectURL(exactUrl);
      exactUrl = URL.createObjectURL(blob);
      exactFrame.src = exactUrl;
      exactFrame.classList.remove('hidden');
      showingExact = true;
      lastStateSignature = sig;
      setStatus(null);
    } catch (err) {
      console.error(err);
      // Errors always surface now - there's no separate manual button to
      // retry and check status with, so silently swallowing a failure
      // here would leave no way to ever notice one happened.
      setStatus('Could not compile the exact render. ' + (err && err.message ? err.message.split('\n')[0] : ''), true);
    } finally {
      compiling = false;
    }
  }

  function hideExact() {
    if (!showingExact) return;
    exactFrame.classList.add('hidden');
    showingExact = false;
  }

  // Checking the toggle compiles right away rather than waiting for the
  // first idle cycle - this is also the only way to force an immediate
  // recompile now that there's no separate button for it.
  autoToggle.addEventListener('change', e => {
    autoEnabled = e.target.checked;
    lastInteraction = Date.now();
    if (autoEnabled) showExact();
    else hideExact();
  });

  // Auto-show the exact render a moment after the user stops interacting, so
  // the fast 3D approximation never gets mistaken for the final result.
  // Opt-in via the "Render TikZ when idle" toggle.
  const IDLE_MS = 800;
  let lastInteraction = Date.now();
  let autoEnabled = true;

  function markInteraction(e) {
    // Interacting with the toggle itself shouldn't immediately flip back
    // to 3D out from under the click.
    if (e.target.closest && e.target.closest('.auto-exact-toggle')) return;
    lastInteraction = Date.now();
    if (showingExact) hideExact();
  }
  ['pointerdown', 'wheel', 'keydown', 'input'].forEach(evt => {
    document.addEventListener(evt, markInteraction, { passive: true });
  });

  setInterval(() => {
    if (!autoEnabled || showingExact || compiling) return;
    if (Date.now() - lastInteraction < IDLE_MS) return;
    const angles = Board3D.getCameraAngles();
    if (stateSignature(angles) === lastStateSignature) return;
    showExact();
  }, 300);

  // ---- boot ----
  Board3D.init(canvas);
  rebuild();
  renderDiceList();
  renderBlockList();
})();

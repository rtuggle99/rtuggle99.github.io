/* board.js - the 3D scene: builds the board/die from state, handles orbit +
   click interaction, and exposes the current camera angle for TikZ export.
   Rendering is always the flat, outlined "TikZ view" style - unlit fills
   with per-face shading and black stroke edges, matching the source TikZ
   figures rather than a lit 3D model. */

const Board3D = (() => {
  let scene, camera, renderer, controls, canvas;
  let boardGroup, checkerMesh;
  let cellClickHandler = null;
  let currentState = null;
  let raf = null;
  const stickerTextureCache = new Map(); // dataUrl -> THREE.Texture, persists across rebuilds
  const dieFaceImageCache = new Map(); // dataUrl -> HTMLImageElement, persists across rebuilds

  const THEMES = {
    // Every value here was extracted by rendering the actual xcolor swatch
    // through pdflatex and sampling the resulting pixels - not computed
    // from an assumed base color, so these are exact, not approximated.
    classic: {
      light: '#ffffff', dark: '#bfbfff', pipLight: '#8080ff', pipDark: '#ffffff', goal: '#008000', goalPip: '#ffffff',
      borderFront: '#a6a6a6', borderRight: '#acacac', borderLeft: '#999999', borderBack: '#a6a6a6', borderTop: '#c6c6c6'
    },
    wood: {
      light: '#ecd9c6', dark: '#ac7339', pipLight: '#ac7339', pipDark: '#ecd9c6', goal: '#008000', goalPip: '#ffffff',
      borderFront: '#302010', borderRight: '#392613', borderLeft: '#432d16', borderBack: '#4c3319', borderTop: '#734c26'
    }
  };

  // colBlockFace1/2/3/4 + colBlockTop from the source: black!42, black!50,
  // black!38, black!41 (sides), black!32 (top) - light-to-medium grays,
  // not the much darker set used in an earlier pass.
  const BLOCK_SHADES = { front: '#949494', right: '#808080', left: '#9e9e9e', back: '#969696', top: '#adadad' };

  // Applies one consistent shading model to any base color: each of the
  // six directions is "percent of the base color kept" (higher = lighter,
  // mixed toward black otherwise) - the same formula for every object, so
  // border, blocks, and the die all shade the same way from their own
  // base color instead of each having its own separate, differently-
  // behaved scheme.
  function applyShading(baseHex, shading) {
    const out = {};
    Object.entries(shading).forEach(([dir, pct]) => {
      // shadeHex returns a THREE.js numeric hex (from Color.getHex()),
      // not a string - fine for the 3D preview since THREE.js material
      // colors accept numbers directly, but tikz.js's hexToTikz and
      // mixTowardBlack need an actual '#rrggbb' string (they call
      // .replace on it), so it has to be converted here before storing.
      out[dir] = '#' + shadeHex(baseHex, -(100 - pct)).toString(16).padStart(6, '0');
    });
    return out;
  }

  function colorsForState(state) {
    const shading = state.shading || { front: 75, back: 92, left: 92, right: 75, top: 100 };
    const custom = state.theme === 'custom';
    const c = state.custom;
    const themeVals = THEMES[state.theme] || THEMES.classic;
    // Border's shading base: the custom color picker under Custom theme,
    // otherwise the theme's own authentic top color (so at the default
    // shading values, Classic/Wood still read the same as before - the
    // shading only starts pulling them away from that as you move a
    // slider off its default).
    const borderBase = custom ? c.border : themeVals.borderTop;
    const blockBase = custom ? c.block : BLOCK_SHADES.top;
    const border = applyShading(borderBase, shading);
    const block = applyShading(blockBase, shading);
    // Optional: tie the checkerboard's own light/dark squares to the Top
    // shading value too, so the whole board (border, blocks, die, and
    // now the playing surface itself) brightens or dims together as one
    // piece instead of the squares always staying at their fixed theme
    // colors regardless of shading.
    const baseLight = custom ? c.light : themeVals.light;
    const baseDark = custom ? c.dark : themeVals.dark;
    const tieBoard = !!state.tieBoardToTopShading;
    const topPct = shading.top;
    const light = tieBoard ? shadeHex(baseLight, -(100 - topPct)) : baseLight;
    const dark = tieBoard ? shadeHex(baseDark, -(100 - topPct)) : baseDark;
    return {
      light, dark,
      pipLight: custom ? c.pipLight : themeVals.pipLight,
      pipDark: custom ? c.pipDark : themeVals.pipDark,
      goal: custom ? c.goal : themeVals.goal,
      goalBorder: custom ? c.goalBorder : '#003300',
      goalPip: custom ? c.goalPip : (themeVals.goalPip || '#ffffff'),
      borderFront: border.front, borderRight: border.right, borderLeft: border.left,
      borderBack: border.back, borderTop: border.top,
      blockShades: block
    };
  }

  // ---- pip texture generator (mirrors the \dicenum tikz macro) ----
  function makePipTexture(value, dotColor, bgColor) {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    if (bgColor) {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, size, size);
    } else {
      ctx.clearRect(0, 0, size, size);
    }
    ctx.fillStyle = dotColor;
    const r = size * 0.09;
    const pts = {
      c: [0.5, 0.5], tl: [0.28, 0.28], tr: [0.72, 0.28],
      bl: [0.28, 0.72], br: [0.72, 0.72], ml: [0.28, 0.5], mr: [0.72, 0.5]
    };
    const layouts = {
      1: ['c'], 2: ['tl', 'br'], 3: ['tl', 'c', 'br'],
      4: ['tl', 'tr', 'bl', 'br'], 5: ['tl', 'tr', 'c', 'bl', 'br'],
      6: ['tl', 'tr', 'ml', 'mr', 'bl', 'br']
    };
    (layouts[value] || []).forEach(k => {
      const [x, y] = pts[k];
      ctx.beginPath();
      ctx.arc(x * size, y * size, r, 0, Math.PI * 2);
      ctx.fill();
    });
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  // Mixes a hex color toward black (negative amt) or white (positive amt),
  // the same idea as xcolor's `color!X!black` / `!X!white` mixes. Used for
  // the "custom" theme, which only has one border color to derive from.
  function shadeHex(hex, amt) {
    const c = new THREE.Color(hex);
    const t = Math.min(1, Math.abs(amt) / 100);
    const target = amt < 0 ? new THREE.Color(0x000000) : new THREE.Color(0xffffff);
    return c.lerp(target, t).getHex();
  }

  function clearGroup(g) {
    while (g.children.length) {
      const child = g.children.pop();
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    }
  }

  function init(canvasEl) {
    canvas = canvasEl;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);

    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xffffff, 1);

    boardGroup = new THREE.Group();
    // Row axis is mirrored here to match the orientation-preserving camera
    // mapping above (tikz y -> three -Z, not +Z) - see tikzBasis for why.
    boardGroup.scale.z = -1;
    scene.add(boardGroup);

    // One controls setup for the whole session - no swapping, no
    // rebuilding. Polar angle is left almost fully open (just shy of the
    // exact top/bottom singularity) so rotation feels the same everywhere,
    // regardless of which preset you last used; the presets below are
    // just nice angles to jump to, not different rotation regimes.
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minZoom = 0.35;
    controls.maxZoom = 4;
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI - 0.02;
    controls.target.set(0, 0, 0);

    const start = VIEW_PRESETS.isometric;
    camera.position.copy(sphericalOffset(start.theta, start.phi, CAMERA_DIST));
    controls.update();

    const raycaster = new THREE.Raycaster();
    let down = null;
    renderer.domElement.addEventListener('pointerdown', e => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    renderer.domElement.addEventListener('pointerup', e => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dt = performance.now() - down.t;
      down = null;
      if (dist > 6 || dt > 500) return; // treat as a drag, not a click
      if (!checkerMesh || !cellClickHandler) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(checkerMesh.children);
      if (hits.length) {
        const { col, row } = hits[0].object.userData;
        cellClickHandler(col, row);
      }
    });

    window.addEventListener('resize', handleResize);
    handleResize();
    animate();
  }

  function applyFrustum() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const aspect = rect.width / Math.max(1, rect.height);
    camera.left = -viewSize * aspect;
    camera.right = viewSize * aspect;
    camera.top = viewSize;
    camera.bottom = -viewSize;
    camera.updateProjectionMatrix();
  }

  function handleResize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height, false);
    applyFrustum();
  }

  function animate() {
    raf = requestAnimationFrame(animate);
    if (cameraAnim) {
      const t = Math.min(1, (performance.now() - cameraAnim.start) / cameraAnim.duration);
      const ease = 1 - Math.pow(1 - t, 3);
      camera.position.lerpVectors(cameraAnim.from, cameraAnim.to, ease);
      if (t >= 1) cameraAnim = null;
    }
    controls.update();
    applyTikzOrientation();
    renderer.render(scene, camera);
  }

  let lastCols = null, lastRows = null;
  let cameraAnim = null; // {from:Vector3, to:Vector3, start:number, duration:number}
  let viewSize = 6; // half-height of the orthographic frustum, in board units
  const CAMERA_DIST = 30; // arbitrary - orthographic scale comes from viewSize, not distance

  const VIEW_PRESETS = {
    isometric: { theta: 55, phi: 135 },
    aerial: { theta: 0.5, phi: 90 }
  };

  function desiredViewSize(cols, rows) {
    const diagonal = Math.sqrt(cols * cols + rows * rows);
    return Math.max(3.4, diagonal * 0.62 + 1.1);
  }

  // These come directly from tikz-3dplot.sty's own source
  // (tdplotcalctransformmainscreen), not from memory or a guessed formula -
  // read the actual .sty file to get this exactly right after several
  // rounds of a subtly-wrong recollection causing mirror bugs:
  //   screen_x = (cosphi, sinphi, 0)
  //   screen_y = (-costheta*sinphi, costheta*cosphi, sintheta)
  //   depth    = (sintheta*sinphi, -sintheta*cosphi, costheta)
  // in tikz's own (x, y, height) space. Mapped into three.js space via
  // tikz(x,y,z) -> three(x, z, -y) - negating the row axis specifically
  // is what makes this mapping orientation-preserving (a plain axis swap
  // reverses handedness, which was the actual root cause of the mirror
  // bug: it silently flipped left/right at every angle except the
  // die/goal diagonal, which is symmetric and couldn't reveal it).
  function tikzBasis(thetaDeg, phiDeg) {
    const t = thetaDeg * Math.PI / 180, p = phiDeg * Math.PI / 180;
    const rightTikz = new THREE.Vector3(Math.cos(p), Math.sin(p), 0);
    const upTikz = new THREE.Vector3(-Math.cos(t) * Math.sin(p), Math.cos(t) * Math.cos(p), Math.sin(t));
    const dirTikz = new THREE.Vector3(Math.sin(t) * Math.sin(p), -Math.sin(t) * Math.cos(p), Math.cos(t));
    const toThree = v => new THREE.Vector3(v.x, v.z, -v.y);
    return { right: toThree(rightTikz), up: toThree(upTikz), dir: toThree(dirTikz) };
  }

  function sphericalOffset(thetaDeg, phiDeg, distance) {
    return tikzBasis(thetaDeg, phiDeg).dir.multiplyScalar(distance);
  }

  // Overrides the camera's rotation every frame to exactly match
  // tikz-3dplot's convention for whatever angle it's currently at -
  // OrbitControls' own lookAt-derived orientation doesn't match tikz's
  // roll in general (only accidentally at a few symmetric test points),
  // so this always wins after controls.update() runs.
  function applyTikzOrientation() {
    const angles = getCameraAngles();
    const { right, up, dir } = tikzBasis(angles.theta, angles.phi);
    const m = new THREE.Matrix4();
    m.makeBasis(right, up, dir);
    camera.quaternion.setFromRotationMatrix(m);
    camera.updateMatrixWorld(true);
  }

  function setView(thetaDeg, phiDeg, animated) {
    const target = controls.target;
    const toPos = target.clone().add(sphericalOffset(thetaDeg, phiDeg, CAMERA_DIST));
    if (animated === false) {
      camera.position.copy(toPos);
      return;
    }
    cameraAnim = { from: camera.position.clone(), to: toPos, start: performance.now(), duration: 700 };
  }

  function goToPreset(name) {
    const v = VIEW_PRESETS[name];
    if (!v) return;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    // Full reset, not just angle/zoom: if the user panned the view away
    // from the board, only fixing the angle would leave the camera
    // still orbiting around wherever they panned to, so the board could
    // still be out of frame. The board is always centered at the world
    // origin (see boardGroup.position in rebuild), so re-centering the
    // orbit target there brings it back into frame regardless of how
    // far the view was panned.
    controls.target.set(0, 0, 0);
    setView(v.theta, v.phi);
  }

  function fitCameraToBoard(cols, rows) {
    viewSize = desiredViewSize(cols, rows);
    applyFrustum();
  }

  function rectOutlineXZ(x0, z0, x1, z1, y, color) {
    const pts = [
      new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z0),
      new THREE.Vector3(x1, y, z1), new THREE.Vector3(x0, y, z1),
      new THREE.Vector3(x0, y, z0)
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
  }

  // A genuinely thick outline, built from real ribbon geometry rather
  // than THREE.Line - line width is a WebGL feature that's unreliable
  // across platforms and renders as ~1px on most of them regardless of
  // the value set, which is why an earlier version wasn't actually
  // showing up thick. corners must be 4 planar points in order; normal
  // is that plane's outward direction, used to keep each ribbon segment
  // properly within the face's own plane regardless of which of the
  // three wall orientations it is.
  function thickOutline(corners, normal, halfWidth, color) {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    for (let i = 0; i < corners.length; i++) {
      const p1 = corners[i], p2 = corners[(i + 1) % corners.length];
      const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
      const offset = new THREE.Vector3().crossVectors(normal, dir).normalize().multiplyScalar(halfWidth);
      const verts = new Float32Array([
        p1.x + offset.x, p1.y + offset.y, p1.z + offset.z,
        p1.x - offset.x, p1.y - offset.y, p1.z - offset.z,
        p2.x - offset.x, p2.y - offset.y, p2.z - offset.z,
        p2.x + offset.x, p2.y + offset.y, p2.z + offset.z
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      group.add(new THREE.Mesh(geo, mat));
    }
    return group;
  }

  const HIGHLIGHT_COLOR = 0xd9932e;
  // Picks the right-oriented outline for whichever direction is
  // currently highlighted, offset slightly outward from the actual
  // surface so it doesn't z-fight with the face it's marking.
  function wallHighlight(direction, x0, x1, y0, y1, z0, z1) {
    const o = 0.006, hw = 0.035;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    if (direction === 'front') {
      const z = z0 - o;
      return thickOutline([V(x0, y0, z), V(x1, y0, z), V(x1, y1, z), V(x0, y1, z)], V(0, 0, -1), hw, HIGHLIGHT_COLOR);
    }
    if (direction === 'back') {
      const z = z1 + o;
      return thickOutline([V(x0, y0, z), V(x1, y0, z), V(x1, y1, z), V(x0, y1, z)], V(0, 0, 1), hw, HIGHLIGHT_COLOR);
    }
    if (direction === 'left') {
      const x = x0 - o;
      return thickOutline([V(x, y0, z0), V(x, y0, z1), V(x, y1, z1), V(x, y1, z0)], V(-1, 0, 0), hw, HIGHLIGHT_COLOR);
    }
    if (direction === 'right') {
      const x = x1 + o;
      return thickOutline([V(x, y0, z0), V(x, y0, z1), V(x, y1, z1), V(x, y1, z0)], V(1, 0, 0), hw, HIGHLIGHT_COLOR);
    }
    if (direction === 'top') {
      const y = y1 + o;
      return thickOutline([V(x0, y, z0), V(x1, y, z0), V(x1, y, z1), V(x0, y, z1)], V(0, 1, 0), hw, HIGHLIGHT_COLOR);
    }
    return null;
  }

  function flatSegment(p1, p2, halfWidth, color) {
    const dx = p2.x - p1.x, dz = p2.z - p1.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const nx = (-dz / len) * halfWidth, nz = (dx / len) * halfWidth;
    const verts = new Float32Array([
      p1.x + nx, p1.y, p1.z + nz,
      p1.x - nx, p1.y, p1.z - nz,
      p2.x - nx, p2.y, p2.z - nz,
      p2.x + nx, p2.y, p2.z + nz
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    return new THREE.Mesh(geo, flatMat(color));
  }

  const flatMat = hex => new THREE.MeshBasicMaterial({
    color: hex, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
  });

  // Box geometry material groups are [+x,-x,+y,-y,+z,-z]. Mapped from the
  // source's tikz-space quads: Right(+x const)->+x, Left(-x const)->-x,
  // Back(+y const)->+z, Front(-y const, the face that actually renders is
  // "FrontOuter" which overpaints "Front")->-z. At the isometric (55°,135°)
  // angle, -x and +z are the two faces actually visible; +x and -z hidden.
  function boxFaceMats(shades) {
    return [
      flatMat(shades.right),  // +x (visible)
      flatMat(shades.left),   // -x (hidden)
      flatMat(shades.top),    // +y (top)
      flatMat(shades.left),   // -y (bottom, hidden)
      flatMat(shades.back),   // +z (hidden)
      flatMat(shades.front)   // -z (visible)
    ];
  }

  // ---- board building ----
  function rebuild(state) {
    currentState = state;
    clearGroup(boardGroup);

    const { cols, rows } = state;
    if (cols !== lastCols || rows !== lastRows) {
      fitCameraToBoard(cols, rows);
      lastCols = cols;
      lastRows = rows;
    }
    const col = colorsForState(state);
    const bh = state.boardHeight != null ? state.boardHeight : 0.45;
    const bw = state.showBorder !== false ? 0.55 : 0;
    const slabH = state.slabHeight != null ? state.slabHeight : 0.3;

    // Center the whole board at the origin for a nice orbit pivot.
    boardGroup.position.set(-cols / 2, 0, rows / 2);

    // ---- base slab, per-face shaded like the original hand-shaded border.
    // When the border is toggled off, bw collapses to 0 above, so this
    // slab shrinks to exactly the checkerboard's own footprint instead
    // of showing a wooden frame margin around it.
    const baseGeo = new THREE.BoxGeometry(cols + 2 * bw, bh, rows + 2 * bw);
    const base = new THREE.Mesh(baseGeo, boxFaceMats({
      front: col.borderFront, right: col.borderRight, left: col.borderLeft, back: col.borderBack, top: col.borderTop
    }));
    base.add(new THREE.LineSegments(new THREE.EdgesGeometry(baseGeo), new THREE.LineBasicMaterial({ color: 0x000000 })));
    base.position.set(cols / 2, bh / 2, rows / 2);
    boardGroup.add(base);

    if (state.shadingHighlight) {
      const h = wallHighlight(state.shadingHighlight, -bw, cols + bw, 0, bh, -bw, rows + bw);
      if (h) boardGroup.add(h);
    }

    // ---- checkerboard (one mesh per cell - simple and robust) ----
    const cellGeo = new THREE.BoxGeometry(0.96, 0.04, 0.96);
    const cellsGroup = new THREE.Group();
    const matCache = {};
    function matFor(hex) {
      if (!matCache[hex]) matCache[hex] = flatMat(hex);
      return matCache[hex];
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const isGoal = state.goal && state.goal.c === c && state.goal.r === r;
        const isLight = (c + r) % 2 === 0;
        const override = state.cellColors && state.cellColors.get(`${c},${r}`);
        const hex = override || (isGoal ? col.goal : (isLight ? col.light : col.dark));
        const cell = new THREE.Mesh(cellGeo, matFor(hex));
        cell.position.set(c + 0.5, bh + 0.02, r + 0.5);
        cell.userData = { col: c, row: r };
        cellsGroup.add(cell);
      }
    }
    boardGroup.add(cellsGroup);
    checkerMesh = cellsGroup;
    if (state.showBorder !== false) {
      boardGroup.add(rectOutlineXZ(0, 0, cols, rows, bh + 0.05, 0x000000));
    }

    // A simple 0-4 layer scale shared by the path, pip labels/goal, and
    // every custom image. Higher layer = greater height above the board
    // surface = wins normal depth testing = appears on top. Blocks and
    // the die are raised 3D geometry (not part of this scale at all) so
    // they always cover flat content regardless of anyone's layer value.
    // Layering is about render order now, not physical height - all flat
    // content (pips, goal, path, images) sits at essentially the same
    // height, and which one wins where they overlap is controlled by
    // renderOrder + disabling depth testing on their materials below,
    // not by actually being physically higher or lower. This also fixes
    // pips disappearing in the aerial 3D view, which was Z-fighting
    // caused by those tiny height differences becoming imperceptible
    // (and so unstable) when the camera looks straight down.
    const FLAT_CONTENT_Y = bh + 0.02;
    const CONTENT_LAYER = 2; // fixed baseline for pips/goal
    const CONTENT_Y = FLAT_CONTENT_Y;
    const pathLayer = state.pathLayer != null ? state.pathLayer : 3;
    const PATH_Y = FLAT_CONTENT_Y;

    // goal border - inset dark-green rectangle (colGoalBorder = green!20!black), matching the source
    if (state.goal) {
      const { c, r } = state.goal;
      const inset = 0.03, size = 0.94;
      boardGroup.add(rectOutlineXZ(c + inset, r + inset, c + inset + size, r + inset + size, bh + 0.05, new THREE.Color(col.goalBorder).getHex()));
    }

    // ---- blocked slabs - exact per-face shading from the source files ----
    state.blocked.forEach(key => {
      const [c, r] = key.split(',').map(Number);
      const geo = new THREE.BoxGeometry(BLOCK_FOOTPRINT, slabH, BLOCK_FOOTPRINT);
      const m = new THREE.Mesh(geo, boxFaceMats(col.blockShades));
      m.position.set(c + 0.5, bh + slabH / 2, r + 0.5);
      m.renderOrder = 1000; // always after flat content - raised geometry always covers it
      boardGroup.add(m);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000 }));
      edges.position.copy(m.position);
      boardGroup.add(edges);
      if (state.shadingHighlight) {
        const half = BLOCK_FOOTPRINT / 2;
        const h = wallHighlight(
          state.shadingHighlight,
          c + 0.5 - half, c + 0.5 + half, bh, bh + slabH,
          r + 0.5 - half, r + 0.5 + half
        );
        if (h) boardGroup.add(h);
      }
      // ---- optional face images, one flat overlay plane per face that
      // has one set - a decal on the block's surface, the same idea as
      // a die's face image but simpler since there's no pip pattern to
      // composite underneath it.
      const faceImages = state.blockFaceImages.get(key);
      if (faceImages) {
        const half = BLOCK_FOOTPRINT / 2;
        const cx = c + 0.5, cz = r + 0.5, topY = bh + slabH;
        const faceDefs = {
          top: { pos: [cx, topY + 0.003, cz], rotX: -Math.PI / 2, rotY: 0 },
          front: { pos: [cx, topY - slabH / 2, cz - half - 0.003], rotX: 0, rotY: Math.PI },
          back: { pos: [cx, topY - slabH / 2, cz + half + 0.003], rotX: 0, rotY: 0 },
          left: { pos: [cx - half - 0.003, topY - slabH / 2, cz], rotX: 0, rotY: -Math.PI / 2 },
          right: { pos: [cx + half + 0.003, topY - slabH / 2, cz], rotX: 0, rotY: Math.PI / 2 }
        };
        Object.keys(faceImages).forEach(face => {
          const imgData = faceImages[face];
          const def = faceDefs[face];
          if (!imgData || !def) return;
          const cached = stickerTextureCache.get(imgData.dataUrl);
          if (cached) {
            const size = face === 'top' ? BLOCK_FOOTPRINT : Math.min(BLOCK_FOOTPRINT, slabH);
            const geo2 = new THREE.PlaneGeometry(size * 0.99, size * 0.99);
            const mat2 = new THREE.MeshBasicMaterial({
              map: cached, transparent: true,
              opacity: imgData.opacity != null ? imgData.opacity : 1, side: THREE.DoubleSide
            });
            const mesh2 = new THREE.Mesh(geo2, mat2);
            mesh2.rotation.set(def.rotX, def.rotY, 0);
            mesh2.position.set(...def.pos);
            boardGroup.add(mesh2);
          } else {
            new THREE.TextureLoader().load(imgData.dataUrl, tex => {
              stickerTextureCache.set(imgData.dataUrl, tex);
              if (currentState === state) rebuild(state);
            });
          }
        });
      }
    });

    // ---- pip labels - works the same on the goal space as any other,
    // just with its own color there so the number stays legible against
    // the goal's own background color. A custom per-cell pip color (set
    // via the Pip color tool) takes priority over both. ----
    state.labels.forEach((value, key) => {
      if (!value) return;
      const [c, r] = key.split(',').map(Number);
      const isGoalCell = state.goal && state.goal.c === c && state.goal.r === r;
      const isLight = (c + r) % 2 === 0;
      const override = state.pipColors && state.pipColors.get(key);
      const dotColor = override || (isGoalCell ? col.goalPip : (isLight ? col.pipLight : col.pipDark));
      const tex = makePipTexture(value, dotColor);
      const geo = new THREE.PlaneGeometry(0.6, 0.6);
      const labelMat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: false
      });
      const plane = new THREE.Mesh(geo, labelMat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(c + 0.5, CONTENT_Y, r + 0.5);
      plane.renderOrder = CONTENT_LAYER;
      boardGroup.add(plane);
    });

    // ---- path(s) - flat ribbons embedded on the surface, not raised tubes ----
    {
      const z = PATH_Y;
      const style = state.pathStyle || { color: '#8c2f27', thickness: 2.2, endStyle: 'arrow' };
      const pathHex = new THREE.Color(style.color).getHex();
      const halfWidth = 0.09 * (style.thickness / 2.2);
      function flatContentMesh(mesh) {
        mesh.material.depthTest = false;
        mesh.material.depthWrite = false;
        mesh.renderOrder = pathLayer;
        return mesh;
      }
      (state.paths || []).forEach(seg => {
        if (seg.length < 1) return;
        const pts = seg.map(p => new THREE.Vector3(p.c + 0.5, z, p.r + 0.5));
        for (let i = 0; i < pts.length - 1; i++) {
          boardGroup.add(flatContentMesh(flatSegment(pts[i], pts[i + 1], halfWidth, pathHex)));
        }
        if (style.endStyle === 'closed' && pts.length >= 3) {
          boardGroup.add(flatContentMesh(flatSegment(pts[pts.length - 1], pts[0], halfWidth, pathHex)));
        }
        if (style.endStyle === 'arrow' && pts.length >= 2) {
          // A flat triangular arrowhead at the final point, oriented along
          // the last segment - matches the exported TikZ's Stealth tip
          // without needing any marker circles.
          const tip = pts[pts.length - 1];
          const prev = pts[pts.length - 2];
          const dx = tip.x - prev.x, dz = tip.z - prev.z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          const ux = dx / len, uz = dz / len;
          const headLen = halfWidth * 4.2, headWidth = halfWidth * 2.6;
          const backX = tip.x - ux * headLen, backZ = tip.z - uz * headLen;
          const nx = -uz, nz = ux;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            tip.x, tip.y, tip.z,
            backX + nx * headWidth, tip.y, backZ + nz * headWidth,
            backX - nx * headWidth, tip.y, backZ - nz * headWidth
          ]), 3));
          geo.setIndex([0, 1, 2]);
          boardGroup.add(flatContentMesh(new THREE.Mesh(geo, flatMat(pathHex))));
        }
      });
    }

    // ---- custom images - each has its own layer, rotation, and fit style ----
    function computeStickerFitSize(s) {
      const rot = s.rotation || 0;
      const swapped = rot === 90 || rot === 270;
      if (s.fit === 'contain') {
        // Contain: fit the image's own proportions inside the box, in
        // WORLD space first - a sideways rotation visually swaps which of
        // the image's natural dimensions acts as "width" there, so the
        // apparent aspect ratio swaps too when comparing against the
        // (unswapped) world-space box.
        const naturalW = s.naturalW || 1, naturalH = s.naturalH || 1;
        const apparentAspect = swapped ? naturalH / naturalW : naturalW / naturalH;
        const boxAspect = s.wCols / s.hRows;
        const fitWorld = apparentAspect > boxAspect
          ? { w: s.wCols, h: s.wCols / apparentAspect }
          : { w: s.hRows * apparentAspect, h: s.hRows };
        // Convert back to the pre-rotation geometry frame.
        return swapped ? { w: fitWorld.h, h: fitWorld.w } : fitWorld;
      }
      // Stretch and cover both fill the box exactly - cover crops the
      // texture itself instead (see computeStickerUV), the geometry is
      // the same full-box size either way.
      return swapped ? { w: s.hRows, h: s.wCols } : { w: s.wCols, h: s.hRows };
    }
    // For 'cover': which portion of the source image to sample so it
    // fills the box with no padding, cropping the excess off whichever
    // axis overflows, centered - the classic "object-fit: cover" crop.
    function computeStickerUV(s) {
      const rot = s.rotation || 0;
      const swapped = rot === 90 || rot === 270;
      const naturalW = s.naturalW || 1, naturalH = s.naturalH || 1;
      const apparentAspect = swapped ? naturalH / naturalW : naturalW / naturalH;
      const boxAspect = s.wCols / s.hRows;
      if (apparentAspect > boxAspect) {
        // Image is relatively wider than the box - crop the sides.
        const repeatX = boxAspect / apparentAspect;
        return { repeatX, repeatY: 1, offsetX: (1 - repeatX) / 2, offsetY: 0 };
      }
      // Image is relatively taller than the box - crop top/bottom.
      const repeatY = apparentAspect / boxAspect;
      return { repeatX: 1, repeatY, offsetX: 0, offsetY: (1 - repeatY) / 2 };
    }
    (state.stickers || []).forEach(s => {
      const cx = s.c + s.wCols / 2, cz = s.r + s.hRows / 2;
      const y = FLAT_CONTENT_Y;
      const cached = stickerTextureCache.get(s.dataUrl);
      if (cached) {
        const { w, h } = computeStickerFitSize(s);
        const geo = new THREE.PlaneGeometry(w * 0.98, h * 0.98);
        // Cloned per instance - repeat/offset below are per-sticker, and
        // the same source image can be used by multiple stickers with
        // different crop boxes, so the shared cached texture itself must
        // never be mutated directly.
        const map = s.fit === 'cover' ? cached.clone() : cached;
        if (s.fit === 'cover') {
          const uv = computeStickerUV(s);
          map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
          map.repeat.set(uv.repeatX, uv.repeatY);
          map.offset.set(uv.offsetX, uv.offsetY);
          map.needsUpdate = true;
        }
        const mat = new THREE.MeshBasicMaterial({
          map, transparent: true, opacity: s.opacity != null ? s.opacity : 1,
          depthTest: false, depthWrite: false
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.z = (s.rotation || 0) * Math.PI / 180;
        if (s.mirrored) mesh.scale.x = -1;
        mesh.renderOrder = s.layer != null ? s.layer : 3;
        const wrapper = new THREE.Group();
        wrapper.add(mesh);
        wrapper.rotation.x = -Math.PI / 2;
        wrapper.position.set(cx, y, cz);
        boardGroup.add(wrapper);
      } else {
        new THREE.TextureLoader().load(s.dataUrl, tex => {
          stickerTextureCache.set(s.dataUrl, tex);
          if (currentState === state) rebuild(state); // still current - show it now that it's loaded
        });
      }
    });

    // ---- dice ----
    if (state.showDice !== false) {
      (state.dice || []).forEach(dieObj => {
        const group = buildDie(
          dieObj.die || { top: 1, front: 2, right: 3 },
          dieObj.colors,
          state.shading,
          dieObj.faceRotation,
          dieObj.selectedFace,
          dieObj.blankFaces,
          dieObj.faceImages,
          () => { if (currentState === state) rebuild(state); }
        );
        group.traverse(obj => { if (obj.isMesh) obj.renderOrder = 1000; });
        const pos = dieObj.position || { c: 0, r: 0 };
        group.position.set(pos.c + 0.5, bh + DIE_SIZE / 2, pos.r + 0.5);
        boardGroup.add(group);
        if (state.shadingHighlight) {
          const half = DIE_SIZE / 2;
          const h = wallHighlight(
            state.shadingHighlight,
            pos.c + 0.5 - half, pos.c + 0.5 + half, bh, bh + DIE_SIZE,
            pos.r + 0.5 - half, pos.r + 0.5 + half
          );
          if (h) boardGroup.add(h);
        }
      });
    }

    handleResize();
  }

  const DIE_SIZE = 0.96;
  const BLOCK_FOOTPRINT = 0.97;

  function makeDieFaceTexture(value, bgColor, dotColor, isSelected, blank, faceImage, faceImageOpacity) {
    // margin=0 so the drawn face extends all the way to the plane's edge -
    // a nonzero margin here was the actual cause of the "gaps between
    // faces" look: the 3D geometry tiles the cube exactly, but a margin
    // pulls the *visible* content away from each shared edge on both
    // sides, which reads as a gap even though nothing is geometrically
    // wrong. Some corner rounding is still fine - it only nibbles the 4
    // cube corners, not the edges between faces.
    const size = 512, margin = 0, radius = 34;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const x = margin, y = margin, w = size - margin * 2, h = size - margin * 2;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    ctx.fillStyle = bgColor;
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    // Selected-face highlight: an inset amber ring drawn entirely inside
    // the existing black border rather than past the plane's edge, so it
    // can't reintroduce the old "gap between faces" illusion - that was
    // specifically caused by pulling drawn content *away* from the edge,
    // and this only adds an accent strictly inward from an edge that's
    // already fully drawn.
    if (isSelected) {
      const inset = 40;
      ctx.lineWidth = 32;
      ctx.strokeStyle = '#d9932e';
      ctx.beginPath();
      ctx.moveTo(x + radius, y + inset);
      ctx.arcTo(x + w - inset, y + inset, x + w - inset, y + h - inset, radius);
      ctx.arcTo(x + w - inset, y + h - inset, x + inset, y + h - inset, radius);
      ctx.arcTo(x + inset, y + h - inset, x + inset, y + inset, radius);
      ctx.arcTo(x + inset, y + inset, x + w - inset, y + inset, radius);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.save();
    ctx.clip();
    if (faceImage) {
      // Fit the image within the face, centered, preserving its own
      // aspect ratio (same "contain" logic used for board images).
      const imgAspect = faceImage.naturalWidth / faceImage.naturalHeight;
      let dw = w, dh = h;
      if (imgAspect > 1) dh = w / imgAspect; else dw = h * imgAspect;
      const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
      ctx.globalAlpha = faceImageOpacity != null ? faceImageOpacity : 1;
      ctx.drawImage(faceImage, dx, dy, dw, dh);
      ctx.globalAlpha = 1;
    } else if (!blank) {
      ctx.fillStyle = dotColor;
      const r = size * 0.09;
      const pts = {
        c: [0.5, 0.5], tl: [0.28, 0.28], tr: [0.72, 0.28],
        bl: [0.28, 0.72], br: [0.72, 0.72], ml: [0.28, 0.5], mr: [0.72, 0.5]
      };
      const layouts = {
        1: ['c'], 2: ['tl', 'br'], 3: ['tl', 'c', 'br'],
        4: ['tl', 'tr', 'bl', 'br'], 5: ['tl', 'tr', 'c', 'bl', 'br'],
        6: ['tl', 'tr', 'ml', 'mr', 'bl', 'br']
      };
      (layouts[value] || []).forEach(k => {
        const [px, py] = pts[k];
        ctx.beginPath();
        ctx.arc(px * size, py * size, r, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    ctx.restore();
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  function buildDie(dieState, dieColors, shading, faceRotation, selectedFace, blankFaces, faceImages, onImageLoaded) {
    // Matches the source's actual construction: five independent flat,
    // rounded-corner tiles positioned around a cube, not a solid textured
    // box. This is what gives the TikZ die its distinctive "papercraft"
    // look - visible gaps at the seams where two rounded corners meet,
    // rather than sharp joined edges. Which pip value lands on which face
    // now comes from the die's actual orientation state so rotating it
    // always keeps a physically valid die (opposite faces sum to 7).
    const hs = DIE_SIZE / 2;
    const group = new THREE.Group();
    const body = (dieColors && dieColors.body) || '#ffffff';
    const pip = (dieColors && dieColors.pip) || '#1a1a1a';
    const sh = shading || { front: 75, back: 92, left: 92, right: 75, top: 100 };
    const fr = faceRotation || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    const blanks = blankFaces || {};
    const images = faceImages || {};
    const shade = pct => '#' + shadeHex(body, -(100 - pct)).toString(16).padStart(6, '0');
    // Pips get the same per-face shading treatment as the face
    // background - a pip on the darker front/right faces reads slightly
    // darker itself, matching how the face around it darkened, rather
    // than staying a single fixed color regardless of which face it's on.
    const pipShade = pct => '#' + shadeHex(pip, -(100 - pct)).toString(16).padStart(6, '0');
    const top = dieState.top, front = dieState.front, right = dieState.right;
    const back = 7 - front, left = 7 - right;
    const selectedValue = selectedFace
      ? { top, front, right, back, left }[selectedFace]
      : null;
    const faceDefs = [
      { v: left, bg: shade(sh.left), pip: pipShade(sh.left), axis: 'x', sign: -1 },
      { v: front, bg: shade(sh.front), pip: pipShade(sh.front), axis: 'z', sign: -1 },
      { v: right, bg: shade(sh.right), pip: pipShade(sh.right), axis: 'x', sign: 1 },
      { v: back, bg: shade(sh.back), pip: pipShade(sh.back), axis: 'z', sign: 1 },
      { v: top, bg: shade(sh.top), pip: pipShade(sh.top), axis: 'y', sign: 1 }
    ];
    // Corner fill: the 5 face tiles below are flat rounded-corner
    // squares (papercraft style, matching the source), which leaves a
    // small gap at each of the 4 top vertices where the rounded corners
    // of top and its two adjacent side faces don't quite meet. Rather
    // than a full rectangular panel along each vertical edge (which
    // doesn't match the actual shape of the gap and can peek out past
    // the die's own silhouette), this fills exactly the triangular
    // region cut by a plane passing through the three faces meeting at
    // each top vertex - colored to match the top face, and added to the
    // group before the face tiles so the opaque tiles naturally cover it
    // everywhere except in the actual gap.
    const topColorHex = shade(sh.top);
    const chamferMat = new THREE.MeshBasicMaterial({ color: topColorHex, side: THREE.DoubleSide });
    const chamferD = 0.28 * DIE_SIZE;
    [[1, -1], [1, 1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => {
      const p1 = [sx * hs, hs - chamferD, sz * hs];       // down the vertical edge
      const p2 = [sx * (hs - chamferD), hs, sz * hs];     // along the top face's edge (x direction)
      const p3 = [sx * hs, hs, sz * (hs - chamferD)];     // along the top face's edge (z direction)
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...p1, ...p2, ...p3]), 3));
      geo.setIndex([0, 1, 2]);
      group.add(new THREE.Mesh(geo, chamferMat));
    });
    faceDefs.forEach(f => {
      const geo = new THREE.PlaneGeometry(DIE_SIZE, DIE_SIZE);
      const imgData = images[f.v];
      let faceImageEl = null;
      if (imgData) {
        faceImageEl = dieFaceImageCache.get(imgData.dataUrl);
        if (!faceImageEl) {
          const img = new Image();
          img.onload = () => { dieFaceImageCache.set(imgData.dataUrl, img); if (onImageLoaded) onImageLoaded(); };
          img.src = imgData.dataUrl;
          faceImageEl = null; // not ready this frame - falls back to pips/blank below until it loads
        }
      }
      const mat = new THREE.MeshBasicMaterial({
        map: makeDieFaceTexture(f.v, f.bg, f.pip, f.v === selectedValue, !!blanks[f.v], faceImageEl, imgData && imgData.opacity),
        transparent: true, side: THREE.FrontSide
      });
      // The wrapper handles laying the face flat in its position around
      // the cube; the mesh's own rotation.z (applied before the wrapper's
      // transform) spins the texture within its own plane, which is what
      // both the physics-tracked spin/tilt rotation and the manual
      // per-face nudge control operate on - kept separate from the
      // wrapper transform so the two never interact via Euler-order
      // surprises.
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.z = (fr[f.v] || 0) * Math.PI / 180;
      const wrapper = new THREE.Group();
      wrapper.add(mesh);
      if (f.axis === 'x') {
        wrapper.position.x = f.sign * hs;
        wrapper.rotation.y = f.sign * Math.PI / 2;
      } else if (f.axis === 'z') {
        wrapper.position.z = f.sign * hs;
        wrapper.rotation.y = f.sign > 0 ? 0 : Math.PI;
      } else {
        wrapper.position.y = f.sign * hs;
        wrapper.rotation.x = -Math.PI / 2;
      }
      group.add(wrapper);
    });
    return group;
  }

  function getCameraAngles() {
    const target = controls.target;
    const p = camera.position.clone().sub(target);
    const horiz = Math.sqrt(p.x * p.x + p.z * p.z);
    let elevation = Math.atan2(p.y, horiz) * 180 / Math.PI;
    let theta = 90 - elevation;
    // The floor here must match VIEW_PRESETS.aerial's own theta exactly -
    // otherwise the camera's *position* sits at the preset's theta while
    // its *orientation* (derived from this clamped value, every frame,
    // via applyTikzOrientation) sits at a different one, and the two
    // disagreeing is what caused aerial view to render very slightly off
    // vertical - asymmetric-looking border thickness - despite the
    // camera being positioned as if perfectly overhead. OrbitControls'
    // own minPolarAngle already prevents interactive dragging below
    // 0.02, so this only needs to protect the reverse phi extraction
    // near vertical from added camera-shake, not guard some
    // hard mathematical degeneracy in the basis itself (there isn't
    // one at theta=0).
    theta = Math.min(179, Math.max(0.5, theta));
    let phi = Math.atan2(p.x, p.z) * 180 / Math.PI;
    if (phi < 0) phi += 360;
    return { theta, phi };
  }

  function onCellClick(fn) { cellClickHandler = fn; }

  return { init, rebuild, onCellClick, getCameraAngles, colorsForState, THEMES, BLOCK_SHADES, goToPreset };
})();

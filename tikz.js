/* tikz.js - turns the current board state + camera angle into a standalone,
   plain tikz-3dplot document. Coordinates are drawn in the same (col, row,
   height) space the 3D scene uses, so the exported picture matches the
   angle you left the board rotated to. Structurally this mirrors the
   source TikZ files as closely as possible (each face individually
   filled *and* stroked, top faces drawn inside a "canvas is xy plane"
   scope rather than with raw 3D rectangle coordinates, which tikz does
   not resolve correctly). */

const TikzExport = (() => {

  function hexToTikz(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return h.toUpperCase();
  }

  // Mixes a hex color toward black by (100-percent)%, matching the
  // source's white!X!black style shading but with a user-chosen base
  // color instead of always white.
  function mixTowardBlack(hex, percent) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const f = percent / 100;
    const channel = i => Math.round(parseInt(h.substr(i, 2), 16) * f);
    return [channel(0), channel(2), channel(4)]
      .map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0'))
      .join('').toUpperCase();
  }

  function fmt(n) {
    return (Math.round(n * 1000) / 1000).toString();
  }

  function filldrawQuad(fill, stroke, p1, p2, p3, p4) {
    return `\\filldraw[fill=${fill},draw=${stroke},line width=0.5pt,line join=round] ` +
      `(${fmt(p1[0])},${fmt(p1[1])},${fmt(p1[2])}) -- ` +
      `(${fmt(p2[0])},${fmt(p2[1])},${fmt(p2[2])}) -- ` +
      `(${fmt(p3[0])},${fmt(p3[1])},${fmt(p3[2])}) -- ` +
      `(${fmt(p4[0])},${fmt(p4[1])},${fmt(p4[2])}) -- cycle;\n`;
  }

  // TikZ has no depth buffer - it just paints shapes in source order. So
  // two things have to be handled manually: (1) which faces of a given
  // box actually point toward the camera at the current angle (backface
  // culling), and (2) which separate objects (a block vs. the die) are
  // nearer the camera and so should be painted after - and therefore on
  // top of - the ones behind them. Both derive from the same camera
  // direction vector, verified empirically against real pdflatex compiles
  // (tikz-3dplot's phi turned out to be rotated 90° from what a naive
  // standard-spherical-coordinates formula would assume).
  function cameraDirection(thetaDeg, phiDeg) {
    const elevRad = (90 - thetaDeg) * Math.PI / 180;
    const phiRad = phiDeg * Math.PI / 180;
    const horiz = Math.cos(elevRad);
    return { x: horiz * Math.sin(phiRad), y: Math.sin(elevRad), z: -horiz * Math.cos(phiRad) };
  }

  function visibleSides(thetaDeg, phiDeg) {
    const dir = cameraDirection(thetaDeg, phiDeg);
    const eps = 0.02;
    return {
      right: dir.x > eps,   // +x outward normal
      left: dir.x < -eps,   // -x outward normal
      back: dir.z > eps,    // +z outward normal
      front: dir.z < -eps   // -z outward normal
    };
  }

  function generate(state, angles) {
    const { cols, rows } = state;
    const col = Board3D.colorsForState(state);
    const block = col.blockShades;
    const bh = state.boardHeight != null ? state.boardHeight : 0.45;
    const bw = state.showBorder !== false ? 0.55 : 0;
    const slabH = state.slabHeight != null ? state.slabHeight : 0.3;
    const theta = fmt(angles.theta), phi = fmt(angles.phi);

    let out = '';
    out += '\\documentclass[tikz,border=4mm]{standalone}\n';
    out += '\\usepackage{tikz-3dplot}\n';
    out += '\\usetikzlibrary{arrows.meta}\n';
    if (state.stickers && state.stickers.length) out += '\\usepackage{graphicx}\n';
    out += '\n';

    const sh = state.shading || { front: 75, back: 92, left: 92, right: 75, top: 100 };
    out += `\\definecolor{cLight}{HTML}{${hexToTikz(col.light)}}\n`;
    out += `\\definecolor{cDark}{HTML}{${hexToTikz(col.dark)}}\n`;
    out += `\\definecolor{cBorderFront}{HTML}{${hexToTikz(col.borderFront)}}\n`;
    out += `\\definecolor{cBorderRight}{HTML}{${hexToTikz(col.borderRight)}}\n`;
    out += `\\definecolor{cBorderLeft}{HTML}{${hexToTikz(col.borderLeft)}}\n`;
    out += `\\definecolor{cBorderBack}{HTML}{${hexToTikz(col.borderBack)}}\n`;
    out += `\\definecolor{cBorderTop}{HTML}{${hexToTikz(col.borderTop)}}\n`;
    out += `\\definecolor{cGoalFill}{HTML}{${hexToTikz(col.goal)}}\n`;
    out += `\\definecolor{cGoalBorder}{HTML}{${hexToTikz(col.goalBorder)}}\n`;
    out += `\\definecolor{cGoalPip}{HTML}{${hexToTikz(col.goalPip || '#ffffff')}}\n`;
    out += `\\definecolor{cBlockFront}{HTML}{${hexToTikz(block.front)}}\n`;
    out += `\\definecolor{cBlockRight}{HTML}{${hexToTikz(block.right)}}\n`;
    out += `\\definecolor{cBlockLeft}{HTML}{${hexToTikz(block.left)}}\n`;
    out += `\\definecolor{cBlockBack}{HTML}{${hexToTikz(block.back)}}\n`;
    out += `\\definecolor{cBlockTop}{HTML}{${hexToTikz(block.top)}}\n`;
    out += `\\definecolor{cBlockLine}{HTML}{404040}\n`;
    out += `\\definecolor{cPipLight}{HTML}{${hexToTikz(col.pipLight)}}\n`;
    out += `\\definecolor{cPipDark}{HTML}{${hexToTikz(col.pipDark)}}\n`;
    out += `\\definecolor{cPathColor}{HTML}{${mixTowardBlack(state.pathStyle.color, sh.top)}}\n\n`;
    // Each die defines its own uniquely-suffixed color macros further
    // down (cDie0Left, cDie0Pip, cDie1Left, ...) since different dice
    // can have completely different colors - there's no single shared
    // "the die" palette anymore.

    out += '\\newcommand{\\dicenum}[1]{%\n' +
      '  \\pgfmathparse{#1==2||#1==4||#1==5||#1==6}\\ifnum\\pgfmathresult>0\\relax\n' +
      '    \\fill(0.5,0.5)circle[radius=1/6];\\fill(-0.5,-0.5)circle[radius=1/6];\\fi\n' +
      '  \\pgfmathparse{#1==3||#1==4||#1==5||#1==6}\\ifnum\\pgfmathresult>0\\relax\n' +
      '    \\fill(-0.5,0.5)circle[radius=1/6];\\fill(0.5,-0.5)circle[radius=1/6];\\fi\n' +
      '  \\pgfmathparse{#1==1||#1==3||#1==5}\\ifnum\\pgfmathresult>0\\relax\n' +
      '    \\fill(0,0)circle[radius=1/6];\\fi\n' +
      '  \\ifnum#1=6\\relax\\fill(0.5,0)circle[radius=1/6];\\fill(-0.5,0)circle[radius=1/6];\\fi\n' +
      '}\n\n';

    out += '\\begin{document}\n\\begin{tikzpicture}\n';
    out += `\\tdplotsetmaincoords{${theta}}{${phi}}\n`;
    out += '\\begin{scope}[tdplot_main_coords]\n\n';

    // ---- border: only the side walls actually facing the camera at this
    // angle get drawn (backface culling - see visibleSides above), plus a
    // top drawn inside a "canvas is xy plane" scope (a raw 3-coordinate
    // \fill...rectangle does not render correctly in tikz-3dplot) ----
    out += '% board border\n';
    const bx0 = -bw, bx1 = cols + bw, bz0 = -bw, bz1 = rows + bw;
    const sides = visibleSides(angles.theta, angles.phi);
    if (sides.front) out += filldrawQuad('cBorderFront', 'black', [bx0, bz0, 0], [bx1, bz0, 0], [bx1, bz0, bh], [bx0, bz0, bh]);
    if (sides.right) out += filldrawQuad('cBorderRight', 'black', [bx1, bz0, 0], [bx1, bz1, 0], [bx1, bz1, bh], [bx1, bz0, bh]);
    if (sides.left) out += filldrawQuad('cBorderLeft', 'black', [bx0, bz0, 0], [bx0, bz1, 0], [bx0, bz1, bh], [bx0, bz0, bh]);
    if (sides.back) out += filldrawQuad('cBorderBack', 'black', [bx0, bz1, 0], [bx1, bz1, 0], [bx1, bz1, bh], [bx0, bz1, bh]);
    out += `\\begin{scope}[canvas is xy plane at z=${bh}]\n` +
      `  \\fill[cBorderTop] (${bx0},${bz0}) rectangle (${bx1},${bz1});\n` +
      `  \\draw[black,line width=0.8pt,line join=round] (${bx0},${bz0}) rectangle (${bx1},${bz1});\n` +
      '\\end{scope}\n\n';

    // ---- checkerboard ----
    out += '% checkerboard\n';
    out += `\\begin{scope}[canvas is xy plane at z=${bh}]\n`;
    const cellColors = state.cellColors || new Map();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const isGoal = state.goal && state.goal.c === c && state.goal.r === r;
        const isLight = (c + r) % 2 === 0;
        const override = cellColors.get(`${c},${r}`);
        let fillColor;
        if (override) {
          fillColor = `cCellC${c}R${r}`;
          out += `  \\definecolor{${fillColor}}{HTML}{${hexToTikz(override)}}\n`;
        } else {
          fillColor = isGoal ? 'cGoalFill' : (isLight ? 'cLight' : 'cDark');
        }
        out += `  \\fill[${fillColor}] (${c},${r}) rectangle ++(1,1);\n`;
        if (isGoal) {
          out += `  \\draw[cGoalBorder,line width=2pt] (${c + 0.03},${r + 0.03}) rectangle ++(0.94,0.94);\n`;
        }
      }
    }
    if (state.showBorder !== false) {
      out += `  \\draw[black,line width=1pt,line join=round] (0,0) rectangle (${cols},${rows});\n`;
    }
    out += '\\end{scope}\n\n';

    // ---- everything below is "flat content": custom images, the
    // goal/pip labels, and the path. Each gets a layer number (0-4,
    // pips/goal fixed at 2) and they're all concatenated in ascending
    // layer order so higher layers paint later = end up on top. Blocks
    // and the die are never part of this - they're painted afterward,
    // in their own always-on-top depth-sorted pass below.
    const CONTENT_LAYER = 2;
    const layeredBlocks = []; // {layer, order, text}
    let blockOrder = 0;
    const images = [];

    if (state.stickers && state.stickers.length) {
      state.stickers.forEach(s => {
        const cx = s.c + s.wCols / 2, cz = s.r + s.hRows / 2;
        // transform shape is required here - unlike raw \fill/\draw path
        // commands, a \node (which is what \includegraphics needs to sit
        // inside) is NOT skewed by "canvas is xy plane" unless this is
        // set, which is exactly why an earlier version looked pasted flat
        // on top instead of embedded in the isometric perspective.
        // The base rotate=90 compensates for that same coordinate-frame
        // quirk; the image's own rotation (0/90/180/270, user-set) is
        // added on top of it. Whichever total lands on an odd multiple
        // of 90 needs width/height swapped to keep the aspect ratio
        // correct in the rendered frame - only the base 90 needed that
        // before user rotation existed, so this generalizes it.
        const userRot = s.rotation || 0;
        const totalRot = (90 + userRot) % 360;
        const totalSwapped = totalRot === 90 || totalRot === 270;
        // fit='contain': compute the fitted size in world space first
        // (the user's own rotation, not the frame-compensating one,
        // determines whether the image's natural dimensions appear
        // swapped there), then convert to the node's local (pre-rotation)
        // frame via the same swap the stretch case already uses.
        let w, h, trimClip = '';
        if (s.fit === 'contain') {
          const userSwapped = userRot === 90 || userRot === 270;
          const naturalW = s.naturalW || 1, naturalH = s.naturalH || 1;
          const apparentAspect = userSwapped ? naturalH / naturalW : naturalW / naturalH;
          const boxAspect = s.wCols / s.hRows;
          const fitWorld = apparentAspect > boxAspect
            ? { w: s.wCols, h: s.wCols / apparentAspect }
            : { w: s.hRows * apparentAspect, h: s.hRows };
          w = totalSwapped ? fitWorld.h : fitWorld.w;
          h = totalSwapped ? fitWorld.w : fitWorld.h;
        } else if (s.fit === 'cover') {
          // Fills the box with no padding, cropping the excess off
          // whichever axis overflows. trim+clip crop the source image's
          // own pixels *before* scaling, so the target crop aspect is
          // computed in the image's natural (pre-rotation) space - if
          // the user's rotation will swap width/height when it's
          // finally drawn, the crop computed here is pre-swapped to
          // compensate, the same way the box dimensions are below.
          w = totalSwapped ? s.hRows : s.wCols;
          h = totalSwapped ? s.wCols : s.hRows;
          const userSwapped = userRot === 90 || userRot === 270;
          const naturalW = s.naturalW || 1, naturalH = s.naturalH || 1;
          const boxAspect = s.wCols / s.hRows;
          const targetNaturalAspect = userSwapped ? 1 / boxAspect : boxAspect;
          if (naturalW / naturalH > targetNaturalAspect) {
            const keepW = naturalH * targetNaturalAspect;
            const trimLR = fmt((naturalW - keepW) / 2);
            trimClip = `trim=${trimLR} 0 ${trimLR} 0, clip, `;
          } else {
            const keepH = naturalW / targetNaturalAspect;
            const trimTB = fmt((naturalH - keepH) / 2);
            trimClip = `trim=0 ${trimTB} 0 ${trimTB}, clip, `;
          }
        } else {
          w = totalSwapped ? s.hRows : s.wCols;
          h = totalSwapped ? s.wCols : s.hRows;
        }
        const op = s.opacity != null ? s.opacity : 1;
        const mirrorOpt = s.mirrored ? ', xscale=-1' : '';
        // Darkens the image toward black proportionally to the Top
        // shading percentage, matching the same "everything on the
        // board shades together" treatment used for the checkerboard,
        // pips, and path - TikZ has no direct multiply-tint for
        // includegraphics, so this approximates it with a black
        // rectangle at the same position, scaled by the image's own
        // opacity so a mostly-transparent image doesn't get an
        // oddly-strong overlay.
        const darkAmount = Math.max(0, Math.min(1, 1 - sh.top / 100)) * op;
        const darkenOverlay = darkAmount > 0.004
          ? `  \\node[inner sep=0pt, rotate=${totalRot}${mirrorOpt}, opacity=${fmt(darkAmount)}] at (${cx},${cz}) {\\color{black}\\rule{${fmt(w)}cm}{${fmt(h)}cm}};\n`
          : '';
        const text = `\\begin{scope}[canvas is xy plane at z=${bh}, transform shape]\n` +
          `  \\node[inner sep=0pt, rotate=${totalRot}${mirrorOpt}, opacity=${fmt(op)}] at (${cx},${cz}) {\\includegraphics[${trimClip}width=${fmt(w)}cm,height=${fmt(h)}cm]{${s.filename}}};\n` +
          darkenOverlay +
          '\\end{scope}\n';
        layeredBlocks.push({ layer: s.layer != null ? s.layer : 3, order: blockOrder++, text });
        images.push({ filename: s.filename, bytes: s.bytes });
      });
    }

    // ---- pip labels - works the same on the goal space as any other,
    // just with its own color there so the number stays legible against
    // the goal's own background color. The goal marker itself (drawn
    // earlier, in the checkerboard block) no longer forces any
    // particular pip value - it's purely a colored space now.
    let contentText = '';
    if (state.labels.size) {
      contentText += '% pip labels\n';
      state.labels.forEach((value, key) => {
        if (!value) return;
        const [c, r] = key.split(',').map(Number);
        const isGoalCell = state.goal && state.goal.c === c && state.goal.r === r;
        const isLight = (c + r) % 2 === 0;
        const override = state.pipColors && state.pipColors.get(key);
        let pipColor;
        if (override) {
          pipColor = `cPipC${c}R${r}`;
          contentText += `\\definecolor{${pipColor}}{HTML}{${hexToTikz(override)}}\n`;
        } else {
          pipColor = isGoalCell ? 'cGoalPip' : (isLight ? 'cPipLight' : 'cPipDark');
        }
        contentText += `\\begin{scope}[canvas is xy plane at z=${bh + 0.02}, shift={(${c + 0.5},${r + 0.5})}, scale=0.4, rotate=90, ${pipColor}]\n  \\dicenum{${value}}\n\\end{scope}\n`;
      });
      contentText += '\n';
    }
    if (contentText) layeredBlocks.push({ layer: CONTENT_LAYER, order: blockOrder++, text: contentText });

    // ---- path(s) - flat, embedded strokes, not raised tubes. Always
    // drawn before the blocks and die (below) so a raised object can
    // correctly paint over any part of a path that passes behind it -
    // that part is not affected by pathLayer, which only controls
    // ordering relative to the other flat content above ----
    let pathText = '';
    const activePaths = (state.paths || []).filter(seg => seg.length >= 1);
    if (activePaths.length) {
      pathText += '% traced path(s)\n';
      const z = bh + 0.03;
      const style = state.pathStyle || { thickness: 2.2, endStyle: 'arrow' };
      const thickness = fmt(style.thickness || 2.2);
      activePaths.forEach(seg => {
        const pts = seg.map(p => `(${p.c + 0.5},${p.r + 0.5},${z})`);
        if (pts.length >= 2) {
          if (style.endStyle === 'arrow') {
            pathText += `\\draw[-{Stealth[length=${thickness}mm]}, line width=${thickness}pt, draw=cPathColor, line cap=round, line join=round, rounded corners=4pt]\n  ${pts.join(' -- ')};\n`;
          } else if (style.endStyle === 'closed' && seg.length >= 3) {
            pathText += `\\draw[draw=cPathColor, opacity=1, line width=${thickness}pt, line cap=round, line join=round]\n  ${pts.join(' -- ')} -- cycle;\n`;
          } else {
            pathText += `\\draw[draw=cPathColor, opacity=1, line width=${thickness}pt, line cap=round, line join=round]\n  ${pts.join(' -- ')};\n`;
          }
        }
      });
      pathText += '\n';
    }
    if (pathText) layeredBlocks.push({ layer: state.pathLayer != null ? state.pathLayer : 3, order: blockOrder++, text: pathText });

    // Stable sort by layer (ties keep their original relative order,
    // via the explicit "order" field, since Array.sort's stability
    // can't be relied on for objects created across separate pushes
    // in every environment).
    layeredBlocks.sort((a, b) => (a.layer - b.layer) || (a.order - b.order));
    layeredBlocks.forEach(b => { out += b.text; });

    // ---- blocked slabs and the die - painted in back-to-front order
    // relative to each other (not just internally), so a nearer block can
    // correctly cover part of the die or another block behind it ----
    const dir = cameraDirection(angles.theta, angles.phi);
    const depthOf = (x, y, z) => x * dir.x + y * dir.y + z * dir.z;
    const raised = [];

    state.blocked.forEach(key => {
      const [c, r] = key.split(',').map(Number);
      let text = '';
      if (sides.front) text += filldrawQuad('cBlockFront', 'cBlockLine', [c, r, bh], [c + 1, r, bh], [c + 1, r, bh + slabH], [c, r, bh + slabH]);
      if (sides.right) text += filldrawQuad('cBlockRight', 'cBlockLine', [c + 1, r, bh], [c + 1, r + 1, bh], [c + 1, r + 1, bh + slabH], [c + 1, r, bh + slabH]);
      if (sides.left) text += filldrawQuad('cBlockLeft', 'cBlockLine', [c, r, bh], [c, r + 1, bh], [c, r + 1, bh + slabH], [c, r, bh + slabH]);
      if (sides.back) text += filldrawQuad('cBlockBack', 'cBlockLine', [c, r + 1, bh], [c + 1, r + 1, bh], [c + 1, r + 1, bh + slabH], [c, r + 1, bh + slabH]);
      text += `\\begin{scope}[canvas is xy plane at z=${bh + slabH}]\n` +
        `  \\fill[cBlockTop] (${c},${r}) rectangle ++(1,1);\n` +
        `  \\draw[cBlockLine,line width=0.5pt,line join=round] (${c},${r}) rectangle ++(1,1);\n` +
        '\\end{scope}\n';
      // ---- optional face images, one flat overlay per face that has
      // one set - same idea as a die's face image, using the same
      // canvas-plane + transform-shape node technique, just against
      // each of the block's own side/top planes instead of a die's.
      const faceImages = state.blockFaceImages ? state.blockFaceImages.get(key) : null;
      if (faceImages) {
        const topSize = fmt(0.99);
        const sideSize = fmt(Math.min(1, slabH) * 0.99);
        const faceScopes = {
          top: { plane: 'xy', coord: 'z', val: bh + slabH, cx: c + 0.5, cy: r + 0.5, size: topSize },
          front: { plane: 'xz', coord: 'y', val: r, cx: c + 0.5, cy: bh + slabH / 2, size: sideSize },
          back: { plane: 'xz', coord: 'y', val: r + 1, cx: c + 0.5, cy: bh + slabH / 2, size: sideSize },
          left: { plane: 'yz', coord: 'x', val: c, cx: r + 0.5, cy: bh + slabH / 2, size: sideSize },
          right: { plane: 'yz', coord: 'x', val: c + 1, cx: r + 0.5, cy: bh + slabH / 2, size: sideSize }
        };
        Object.keys(faceImages).forEach(face => {
          const img = faceImages[face];
          const def = faceScopes[face];
          if (!img || !def) return;
          const op = img.opacity != null ? img.opacity : 1;
          text += `\\begin{scope}[canvas is ${def.plane} plane at ${def.coord}=${fmt(def.val)}, transform shape]\n` +
            `  \\node[inner sep=0pt, opacity=${fmt(op)}] at (${fmt(def.cx)},${fmt(def.cy)}) {\\includegraphics[width=${def.size}cm,height=${def.size}cm]{${img.filename}}};\n` +
            '\\end{scope}\n';
          images.push({ filename: img.filename, bytes: img.bytes });
        });
      }
      raised.push({ depth: depthOf(c + 0.5, bh + slabH / 2, r + 0.5), text });
    });

    (state.dice || []).forEach((dieObj, idx) => {
      if (state.showDice === false) return;
      const diePos = dieObj.position || { c: 0, r: 0 };
      const hs = 0.45;
      const cx = diePos.c + 0.5, cz = diePos.r + 0.5;
      const d = dieObj.die || { top: 1, front: 2, right: 3 };
      const fr = dieObj.faceRotation || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
      const blanks = dieObj.blankFaces || {};
      const faceImgs = dieObj.faceImages || {};
      const top = d.top, front = d.front, right = d.right;
      const back = 7 - front, left = 7 - right;
      const dieBody = (dieObj.colors && dieObj.colors.body) || '#ffffff';
      const diePip = (dieObj.colors && dieObj.colors.pip) || '#1a1a1a';
      // Each die gets its own uniquely-suffixed macros, since different
      // dice can have completely different colors.
      const P = `Die${idx}`;
      let text = `\\definecolor{c${P}Left}{HTML}{${mixTowardBlack(dieBody, sh.left)}}\n`;
      text += `\\definecolor{c${P}Front}{HTML}{${mixTowardBlack(dieBody, sh.front)}}\n`;
      text += `\\definecolor{c${P}Right}{HTML}{${mixTowardBlack(dieBody, sh.right)}}\n`;
      text += `\\definecolor{c${P}Back}{HTML}{${mixTowardBlack(dieBody, sh.back)}}\n`;
      text += `\\definecolor{c${P}Top}{HTML}{${mixTowardBlack(dieBody, sh.top)}}\n`;
      // Pips get the same per-face shading treatment as the face
      // background - a pip on the darker front/right faces reads
      // slightly darker itself, rather than staying one fixed color
      // regardless of which face it's on.
      text += `\\definecolor{c${P}PipLeft}{HTML}{${mixTowardBlack(diePip, sh.left)}}\n`;
      text += `\\definecolor{c${P}PipFront}{HTML}{${mixTowardBlack(diePip, sh.front)}}\n`;
      text += `\\definecolor{c${P}PipRight}{HTML}{${mixTowardBlack(diePip, sh.right)}}\n`;
      text += `\\definecolor{c${P}PipBack}{HTML}{${mixTowardBlack(diePip, sh.back)}}\n`;
      text += `\\definecolor{c${P}PipTop}{HTML}{${mixTowardBlack(diePip, sh.top)}}\n`;
      text += `\\begin{scope}[shift={(${cx},${cz},${bh + hs})}]\n`;
      // Corner fill: the 5 face tiles below are flat rounded-corner
      // squares (papercraft style, matching the source), which leaves a
      // small gap at each of the 4 top vertices where the rounded
      // corners of top and its two adjacent side faces don't quite
      // meet. Rather than a rectangular panel along each vertical edge
      // (which doesn't match the actual shape of the gap and can peek
      // out past the die's own silhouette), this fills exactly the
      // triangular region cut by a plane passing through the three
      // faces meeting at each top vertex - colored to match the top
      // face (reusing its own macro), and drawn *before* the face tiles
      // below so painter's-algorithm ordering makes the opaque tiles
      // naturally cover it everywhere except in the actual gap.
      const chamferD = 0.28 * (2 * hs);
      [[1, -1], [1, 1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => {
        const p1 = [sx * hs, hs - chamferD, sz * hs];
        const p2 = [sx * (hs - chamferD), hs, sz * hs];
        const p3 = [sx * hs, hs, sz * (hs - chamferD)];
        const pts = [p1, p2, p3].map(([x, y, z]) => `(${fmt(x)},${fmt(z)},${fmt(y)})`).join(' -- ');
        text += `  \\filldraw[fill=c${P}Top, draw=none] ${pts} -- cycle;\n`;
      });
      const face = (plane, coord, sign, fill, pip, pipMacro) => {
        let s = `  \\begin{scope}[canvas is ${plane} plane at ${coord}=${sign}${hs},xscale=${hs},yscale=${hs},rounded corners=0.06cm]\n` +
          `    \\filldraw[fill=${fill},draw=black,line width=0.5pt] (-1,-1) rectangle (1,1);\n`;
        const img = faceImgs[pip];
        if (img) {
          const op = img.opacity != null ? img.opacity : 1;
          // transform shape is required for the same reason it is for
          // board images: without it, the includegraphics doesn't pick
          // up the surrounding canvas-plane's 3D orientation at all.
          s += `    \\begin{scope}[transform shape]\\node[inner sep=0pt,opacity=${fmt(op)}] at (0,0) {\\includegraphics[width=1.7cm,height=1.7cm]{${img.filename}}};\\end{scope}\n`;
          images.push({ filename: img.filename, bytes: img.bytes });
        } else if (!blanks[pip]) {
          s += `    \\begin{scope}[${pipMacro}, rotate=${fr[pip] || 0}]\\dicenum{${pip}}\\end{scope}\n`;
        }
        s += '  \\end{scope}\n';
        return s;
      };
      if (sides.left) text += face('yz', 'x', '-', `c${P}Left`, left, `c${P}PipLeft`);
      if (sides.front) text += face('xz', 'y', '-', `c${P}Front`, front, `c${P}PipFront`);
      if (sides.right) text += face('yz', 'x', '', `c${P}Right`, right, `c${P}PipRight`);
      if (sides.back) text += face('xz', 'y', '', `c${P}Back`, back, `c${P}PipBack`);
      text += face('xy', 'z', '', `c${P}Top`, top, `c${P}PipTop`); // top - always visible
      text += '\\end{scope}\n';
      raised.push({ depth: depthOf(cx, bh + hs, cz), text });
    });

    raised.sort((a, b) => a.depth - b.depth); // farthest first, nearest last (painted on top)
    if (raised.length) {
      out += '% blocked spaces and die, back-to-front\n';
      raised.forEach(item => { out += item.text; });
      out += '\n';
    }

    out += '\\end{scope}\n\\end{tikzpicture}\n\\end{document}\n';
    return { tex: out, images };
  }

  return { generate };
})();

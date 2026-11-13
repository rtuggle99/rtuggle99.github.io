// machine-sim.js — shared pieces of the "run it" side of the explorers: the step player,
// the moving dots, computation trees for nondeterministic machines, the "test many strings"
// panel, and exact algorithms for pushdown automata. Load it after machine-builder.js.
(function(){
  'use strict';
  const U = MachineBuilder.util;
  const {$, el, esc, chars, labelHTML, shortlex, plural, setSvgLabel, splitLabel, SVG_NS} = U;
  const EPS = 'ε';

  // ======================================================================
  //  step player: ⏮ ◀ ▶Play ▶ ⏭, the scrubber, the step count and the speed button
  // ======================================================================
  // o: {last() → number of the final step, render(i, animate), isLocked() → bool, stepText(i, last) optional,
  //     speed: 'slow' | 'normal' | 'fast' to start at (default 'slow')}
  // Uses the page's elements with ids resetBtn, backBtn, playBtn, stepBtn, endBtn, scrub, stepCount, speedBtn.
  function player(o){
    const resetBtn = $('resetBtn'), backBtn = $('backBtn'), playBtn = $('playBtn'), stepBtn = $('stepBtn'), endBtn = $('endBtn');
    const scrub = $('scrub'), stepCountEl = $('stepCount'), speedBtn = $('speedBtn');
    const SPEEDS = [['slow', 1000], ['normal', 450], ['fast', 120]];
    let speedIdx = Math.max(0, SPEEDS.findIndex(x=>x[0]===(o.speed || 'slow'))), idx = 0, playing = false, timer = null, ok = false;
    const P = {
      get idx(){ return idx; }, get stepMs(){ return SPEEDS[speedIdx][1]; },
      // a fresh run (ok=false when the input can't be run, e.g. a symbol outside Σ)
      reset(valid){ stop(); ok = valid!==false; idx = 0; draw(false); },
      go, stop, start, toggle: ()=> playing ? stop() : start(), stepForward,
      refresh(){ draw(false); }
    };
    function draw(animate){
      document.documentElement.style.setProperty('--step-ms', P.stepMs+'ms');
      const last = ok ? o.last() : 0;
      scrub.max = last; scrub.value = idx;
      stepCountEl.textContent = ok ? (o.stepText ? o.stepText(idx, last) : `step ${idx.toLocaleString()} of ${last.toLocaleString()}`) : '';
      updateButtons();
      o.render(idx, animate, ok);
    }
    function go(i, animate){ if(!ok) return; idx = Math.max(0, Math.min(i, o.last())); draw(animate); }
    function stepForward(){ if(!ok || idx >= o.last()) return false; go(idx+1, true); return true; }
    function start(){
      if(!ok) return;
      if(idx >= o.last()) go(0, false);
      playing = true; updateButtons(); tick();
    }
    function tick(){
      if(!playing) return;
      timer = setTimeout(()=>{
        if(!playing) return;
        if(!stepForward() || idx >= o.last()){ stop(); return; }
        tick();
      }, idx===0 ? 150 : P.stepMs);
    }
    function stop(){ playing = false; clearTimeout(timer); updateButtons(); }
    function updateButtons(){
      const last = ok ? o.last() : 0, atEnd = !ok || idx >= last, atStart = !ok || idx===0;
      playBtn.textContent = playing ? '❚❚ Pause' : (ok && atEnd && last>0 ? '↻ Replay' : '▶ Play');
      playBtn.disabled = !ok || last===0;
      resetBtn.disabled = atStart; backBtn.disabled = atStart;
      stepBtn.disabled = atEnd; endBtn.disabled = atEnd;
      scrub.disabled = !ok || last===0;
    }
    resetBtn.addEventListener('click', ()=>{ stop(); go(0,false); });
    backBtn.addEventListener('click', ()=>{ stop(); go(idx-1,false); });
    stepBtn.addEventListener('click', ()=>{ stop(); stepForward(); });
    endBtn.addEventListener('click', ()=>{ stop(); go(o.last(),false); });
    playBtn.addEventListener('click', P.toggle);
    scrub.addEventListener('input', ()=>{ stop(); go(+scrub.value,false); });
    const applySpeed = ()=>{ speedBtn.textContent = 'Speed: '+SPEEDS[speedIdx][0]; document.documentElement.style.setProperty('--step-ms', P.stepMs+'ms'); };
    speedBtn.addEventListener('click', ()=>{ speedIdx = (speedIdx+1) % SPEEDS.length; applySpeed(); });
    applySpeed();
    document.addEventListener('keydown', e=>{
      const tag = (e.target.tagName||'').toLowerCase();
      if(tag==='input' || tag==='textarea' || tag==='select') return;
      if(e.ctrlKey||e.metaKey||e.altKey) return;
      if(e.key==='Escape' || !o.isLocked()) return;
      if(e.key===' ' && tag!=='button'){ e.preventDefault(); P.toggle(); }
      else if(e.key==='ArrowRight'){ e.preventDefault(); stop(); stepForward(); }
      else if(e.key==='ArrowLeft'){ e.preventDefault(); stop(); go(idx-1,false); }
      else if(e.key==='r' || e.key==='R'){ stop(); go(0,false); }
    });
    return P;
  }

  // dots travelling along the arrows taken in one step (several at once for nondeterministic machines)
  let tokenRaf = null;
  function animateTokens(svg, paths, ms){
    cancelAnimationFrame(tokenRaf);
    if(!paths || !paths.length) return;
    if(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const runs = [];
    paths.forEach(path=>{ let len; try{ len = path.getTotalLength(); }catch(e){ return; }
      const dot = el('circle',{class:'token', r:6}); svg.appendChild(dot); runs.push({path, len, dot}); });
    const dur = Math.max(100, ms*0.7), t0 = performance.now();
    const frame = now=>{
      const k = Math.min(1, (now-t0)/dur), e = k<0.5 ? 2*k*k : 1-Math.pow(-2*k+2,2)/2;
      runs.forEach(r=>{ const p = r.path.getPointAtLength(e*r.len); r.dot.setAttribute('cx', p.x); r.dot.setAttribute('cy', p.y); });
      if(k<1) tokenRaf = requestAnimationFrame(frame); else runs.forEach(r=>r.dot.remove());
    };
    tokenRaf = requestAnimationFrame(frame);
  }
  // fits a read-only copy of the diagram to its drawing once per lock-in
  function fitCopy(svg, holder){
    if(!holder.box){ try{ const b = svg.getBBox(); if(b.width) holder.box = `${b.x-16} ${b.y-12} ${b.width+32} ${b.height+24}`; }catch(e){} }
    if(holder.box) svg.setAttribute('viewBox', holder.box);
  }

  // ======================================================================
  //  computation trees
  // ======================================================================
  // Each node is a configuration; each edge is one move. Built breadth-first so that every level is one step.
  // o: {root, key(cfg) → string, accepting(cfg) → bool, expand(cfg) → [{cfg, edgeId, ruleIdx, label}], maxNodes, maxDepth}
  // A node's status ends up as: 'inner' (it has children), 'accept' (✓, not expanded further),
  // 'dead' (× no move applies), 'repeat' (↻ same configuration as one of its ancestors, so this branch only loops),
  // or 'cut' (… not expanded because the tree got too big).
  function buildTree(o){
    const nodes = [];
    const mk = (cfg, parent, via)=>{
      const n = {id:nodes.length, cfg, parent, via, depth: parent ? parent.depth+1 : 0, children:[], status:'open', key:o.key(cfg)};
      nodes.push(n); return n;
    };
    const root = mk(o.root, null, null);
    let frontier = [root], firstAccept = null, cut = false;
    while(frontier.length){
      const next = [];
      for(const n of frontier){
        if(o.accepting(n.cfg)){ n.status = 'accept'; if(!firstAccept) firstAccept = n; continue; }
        let a = n.parent, rep = false;
        while(a){ if(a.key===n.key){ rep = true; break; } a = a.parent; }
        if(rep){ n.status = 'repeat'; continue; }
        const kids = o.expand(n.cfg);
        if(!kids.length){ n.status = 'dead'; continue; }
        if(nodes.length + kids.length > o.maxNodes || n.depth >= o.maxDepth){ n.status = 'cut'; cut = true; continue; }
        n.status = 'inner';
        kids.forEach(c=>{ const ch = mk(c.cfg, n, c); n.children.push(ch); next.push(ch); });
      }
      frontier = next;
    }
    const depth = Math.max(...nodes.map(n=>n.depth));
    const path = new Set();
    for(let a = firstAccept; a; a = a.parent) path.add(a.id);
    // steps: one per level, plus one more to show what happened to the deepest branches
    const ends = nodes.filter(n=>n.depth===depth).some(n=>n.status!=='accept');
    return {nodes, root, firstAccept, cut, depth, last: depth + (ends ? 1 : 0), path};
  }

  // Draws the tree into `svg` (inside a scrolling box). Positions are fixed for the whole tree, and
  // levels deeper than `upto` stay hidden, so the tree grows in place as you step.
  // d: {state(n) → label, stack(n) → [top … bottom] or null, read(n) → input read so far, rest(n) → unread input, edge(n) → move label}
  function layoutTree(T, d){
    const hasStack = !!d.stack;
    const CELL = 15, STACK_MAX = 8, boxW = hasStack ? 66 : 46;
    const stackShown = n => { const s = d.stack(n); return s.length > STACK_MAX ? s.slice(0, STACK_MAX-1).concat(['⋮']) : s; };
    const boxH = n => hasStack ? Math.max(30, Math.max(1, stackShown(n).length)*CELL + 8) : 30;
    // leaves left to right; a parent sits centered over its children
    let slot = 0;
    const SLOT = boxW + 34;
    (function place(n){
      if(!n.children.length){ n.x = slot*SLOT + SLOT/2; slot++; return; }
      n.children.forEach(place);
      n.x = (n.children[0].x + n.children[n.children.length-1].x)/2;
    })(T.root);
    const levelH = [];
    T.nodes.forEach(n=>{ levelH[n.depth] = Math.max(levelH[n.depth]||0, boxH(n)); });
    const levelY = []; let y = 14;
    levelH.forEach((h,i)=>{ levelY[i] = y; y += h + 16 + 58; });   // box, its unread-input line, then room for the edge label
    // every box in a level is as tall as the tallest, so the stacks all rest on the same floor
    T.nodes.forEach(n=>{ n.y = levelY[n.depth]; n.w = boxW; n.h = levelH[n.depth]; });
    T.width = Math.max(slot*SLOT, SLOT); T.height = y - 40;
    T.hasStack = hasStack; T.stackShown = stackShown; T.CELL = CELL; T.SLOT = SLOT;
  }
  // animate: the newest level grows in (edges draw downward, then their arrowheads, labels and boxes fade in)
  function drawTree(svg, T, upto, d, animate){
    if(!T.laidOut){ layoutTree(T, d); T.laidOut = true; }
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${T.width} ${T.height}`);
    svg.setAttribute('width', T.width); svg.setAttribute('height', T.height);
    const showPath = T.firstAccept && upto >= T.firstAccept.depth;
    const onPath = n => showPath && T.path.has(n.id);
    const vis = T.nodes.filter(n=>n.depth<=upto);
    // edges first, labelled with the move
    vis.forEach(n=>{
      if(!n.parent) return;
      const p = n.parent, good = onPath(n), fresh = n.depth===upto, grow = animate && fresh;
      const x1 = p.x, y1 = p.y + p.h + 16, x2 = n.x, y2 = n.y - 2;
      const len = Math.hypot(x2-x1, y2-y1) || 1, ux = (x2-x1)/len, uy = (y2-y1)/len, AL = 8, AW = 4;
      const cls = 'tree-edge'+(good?' good':'')+(fresh?' fresh':'');
      // the line stops at the arrowhead's base; the arrowhead is its own triangle so it can fade in after the line has drawn
      svg.appendChild(el('line',{class:cls+(grow?' grow':''), x1, y1, x2:x2-ux*AL, y2:y2-uy*AL, pathLength:1}));
      const bx = x2-ux*AL, by = y2-uy*AL;
      svg.appendChild(el('path',{class:'tree-arrow'+(good?' good':'')+(fresh?' fresh':'')+(grow?' enter':''),
        d:`M ${x2} ${y2} L ${bx-uy*AW} ${by+ux*AW} L ${bx+uy*AW} ${by-ux*AW} Z`}));
      const t = 0.55, lx = x1 + (x2-x1)*t, ly = y1 + (y2-y1)*t;
      const g = el('g',{class:grow?'enter':''});
      const txt = el('text',{class:'tree-edge-label'+(good?' good':''), x:lx, y:ly+4}); txt.textContent = d.edge(n);
      g.appendChild(txt); svg.appendChild(g);
      // the move sits in a small tag on its edge, so it can't be mistaken for input
      try{ const bb = txt.getBBox(); g.insertBefore(el('rect',{class:'tree-edge-label-bg'+(good?' good':''), x:bb.x-5, y:bb.y-2, width:bb.width+10, height:bb.height+4, rx:(bb.height+4)/2}), txt); }catch(e){}
    });
    vis.forEach(n=>{
      const current = n.depth===upto, good = onPath(n);
      const ended = n.status!=='inner' && n.status!=='open' && (n.status==='accept' || upto > n.depth);
      let cls = 'tree-node';
      if(good) cls += ' good'; else if(current) cls += ' current';
      if(animate && current && n.parent) cls += ' enter drop';
      if(ended && n.status==='dead') cls += ' dead';
      const g = el('g',{class:cls});
      const x = n.x - n.w/2, y = n.y;
      g.appendChild(el('rect',{class:'tree-box', x, y, width:n.w, height:n.h, rx:4}));
      // the state
      const sx = T.hasStack ? x + 23 : n.x;
      const sub = splitLabel(d.state(n))[1];
      const st = el('text',{class:'tree-state', x:sx, y:y + n.h/2 + (sub ? 2.5 : 4.5)});
      setSvgLabel(st, d.state(n)); g.appendChild(st);
      // the stack, top first, drawn as a little column of cells
      if(T.hasStack){
        const cells = T.stackShown(n), cx = x + 44, cw = 16;
        g.appendChild(el('line',{class:'tree-divider', x1:x+40, y1:y+4, x2:x+40, y2:y+n.h-4}));
        // the stack rests on the bottom of the box: its bottom symbol lowest, pushes stacking upward
        const floor = y + n.h - 4;
        if(!cells.length){
          g.appendChild(el('rect',{class:'tree-cell empty', x:cx, y:floor - 14, width:cw, height:14}));
        }
        const top = floor - cells.length*T.CELL;
        cells.forEach((c,i)=>{
          g.appendChild(el('rect',{class:'tree-cell', x:cx, y:top + i*T.CELL, width:cw, height:T.CELL}));
          const ct = el('text',{class:'tree-cell-text', x:cx + cw/2, y:top + i*T.CELL + 11}); ct.textContent = c; g.appendChild(ct);
        });
      }
      // the input: the part already read grayed out, the part still to read in ink (long inputs lose their oldest symbols to "…")
      let read = d.read ? d.read(n) : '', rest = d.rest(n);
      const rt = el('text',{class:'tree-input', x:n.x, y:y + n.h + 12});
      if(!read && !rest){ rt.classList.add('none'); rt.textContent = 'ε'; }
      else {
        const MAXC = Math.max(4, Math.floor((T.SLOT - 8) / 6.4));
        const r = [...read], u = [...rest];
        if(r.length + u.length > MAXC){ const keep = Math.max(0, MAXC - 1 - u.length); read = '…' + r.slice(r.length - keep).join(''); }
        if(read){ const a = document.createElementNS(SVG_NS,'tspan'); a.setAttribute('class','tree-read'); a.textContent = read; rt.appendChild(a); }
        if(rest){ const b2 = document.createElementNS(SVG_NS,'tspan'); b2.setAttribute('class','tree-rest'); b2.textContent = rest; rt.appendChild(b2); }
        const ti = document.createElementNS(SVG_NS,'title');
        ti.textContent = rest ? `Read so far: ${d.read ? d.read(n) || 'nothing' : ''}. Still to read: ${rest}.` : 'All of the input has been read.';
        rt.appendChild(ti);
      }
      g.appendChild(rt);
      // what became of a branch that ended
      if(ended){
        const mark = {accept:'✓', dead:'×', repeat:'↻', cut:'…'}[n.status];
        const tip = {accept:'All input read in an accept state: accepted', dead:'No move applies: this branch dies',
          repeat:'Same configuration as earlier on this branch, so it only loops', cut:'Not explored further (the tree is too big to draw)'}[n.status];
        const mt = el('text',{class:'tree-mark '+n.status, x:x + n.w + 4, y:y + n.h/2 + 5}); mt.textContent = mark;
        const ti = document.createElementNS(SVG_NS, 'title'); ti.textContent = tip; mt.appendChild(ti);
        g.appendChild(mt);
      }
      svg.appendChild(g);
    });
  }
  // scrolls the tree's box so the newest level is in view
  function scrollTreeTo(box, T, upto, smooth){
    const row = T.nodes.filter(n=>n.depth===Math.min(upto, T.depth));
    if(!row.length) return;
    const minX = Math.min(...row.map(n=>n.x - n.w/2)), maxX = Math.max(...row.map(n=>n.x + n.w/2));
    const y = row[0].y, h = Math.max(...row.map(n=>n.h));
    let left = box.scrollLeft, top = box.scrollTop;
    const W = box.clientWidth, Hh = box.clientHeight;
    if(maxX - minX < W - 40){ if(minX < left + 20 || maxX > left + W - 20) left = (minX + maxX)/2 - W/2; }
    else left = minX - 20;
    if(y + h + 30 > top + Hh || y < top) top = y + h + 40 - Hh;
    box.scrollTo({left:Math.max(0,left), top:Math.max(0,top), behavior: smooth ? 'smooth' : 'auto'});
  }

  // ======================================================================
  //  "test many strings": two columns, accepted and rejected
  // ======================================================================
  // o: {sigma() → [sym], decide(w) → bool, pick(w)}; uses ids countSeg, countNote, countN, customBox, stringsIn, testBtn, testSummary, testCols
  function tester(o){
    const stringsIn = $('stringsIn'), testCols = $('testCols'), testSummary = $('testSummary'), countSeg = $('countSeg'), customBox = $('customBox');
    let count = '50';
    const listText = ws => ws.map(w=>w===''?'ε':w).join('\n');
    const readCustom = () => stringsIn.value.split('\n').map(s=>s.trim()).filter(Boolean)
      .map(s=> (s==='ε' || s==='-' || s.toLowerCase()==='eps') ? '' : s.replace(/\s+/g,''));
    function set(c){
      if(c==='custom' && count!=='custom' && !stringsIn.value.trim()) stringsIn.value = listText(U.firstStrings(o.sigma(), +count || 50));
      count = c;
      countSeg.querySelectorAll('button').forEach(x=>{ x.classList.toggle('on', x.dataset.n===c); x.setAttribute('aria-pressed', x.dataset.n===c); });
      customBox.hidden = c!=='custom';
      $('countNote').hidden = c==='custom';
      if(c!=='custom') $('countN').textContent = c;
      run();
    }
    function run(){
      const S = o.sigma();
      const all = [...new Set(count==='custom' ? readCustom() : U.firstStrings(S, +count))].sort(shortlex);
      const words = all.filter(w=>chars(w).every(c=>S.includes(c)));
      const skipped = all.filter(w=>!words.includes(w));
      const groups = {accept:[], reject:[]};
      words.forEach(w=>groups[o.decide(w) ? 'accept' : 'reject'].push(w));
      const chips = ws => ws.map(w=>`<button class="chip${w?'':' eps'}" data-w="${esc(w)}" title="${w ? esc(w)+' (click to watch it run)' : 'Click to watch it run'}">${w?U.shortWord(w):'ε'}</button>`).join('');
      const col = (key, title)=>{
        const n = groups[key].length;
        return `<div class="col ${key}"><h3><span>${title}</span><span>${n}</span></h3>${n ? `<div class="chips">${chips(groups[key])}</div>` : '<span class="none">none</span>'}</div>`;
      };
      testCols.innerHTML = col('accept','Accepted') + col('reject','Rejected');
      let msg = words.length ? `Tested ${plural(words.length,'string')}. Click any string to watch it run.` : 'Add some strings, one per line.';
      if(skipped.length) msg += ` Skipped ${skipped.slice(0,3).map(w=>`“${esc(w)}”`).join(', ')}${skipped.length>3?'…':''}: not over Σ.`;
      testSummary.innerHTML = msg;
    }
    countSeg.addEventListener('click', e=>{ const x = e.target.closest('button'); if(x) set(x.dataset.n); });
    $('testBtn').addEventListener('click', run);
    testCols.addEventListener('click', e=>{ const c = e.target.closest('.chip'); if(c) o.pick(c.dataset.w); });
    return {refresh: ()=>set(count)};
  }

  // ======================================================================
  //  pushdown automata
  // ======================================================================
  // A PDA here: {states:[id], start:id, accept:Set(id), rules:[{from, to, read, pop, push}]} with '' for ε.
  // It starts with an empty stack and accepts if some computation reads all of the input and is then in an
  // accept state (Sipser's definition; the stack may hold anything at that point).

  // one move from a configuration {q, i, stack:[bottom … top]} on input w (an array of symbols)
  function pdaMoves(P, w, c){
    const out = [], top = c.stack.length ? c.stack[c.stack.length-1] : null;
    P.rules.forEach(r=>{
      if(r.from!==c.q) return;
      if(r.read && !(c.i < w.length && w[c.i]===r.read)) return;
      if(r.pop && r.pop!==top) return;
      const stack = r.pop ? c.stack.slice(0,-1) : c.stack.slice();
      if(r.push) stack.push(r.push);
      out.push({cfg:{q:r.to, i:c.i + (r.read ? 1 : 0), stack}, rule:r});
    });
    return out;
  }

  // Split every move into steps that each push one symbol, pop one symbol, or leave the stack alone
  // (a pop-then-push move goes through a fresh in-between state).
  function pdaCore(P){
    const sid = new Map(); P.states.forEach((id,i)=>sid.set(id,i));
    let nS = P.states.length;
    const plain = [], push = [], pop = [];
    P.rules.forEach(r=>{
      const p = sid.get(r.from), q = sid.get(r.to);
      if(r.pop && r.push){ const m = nS++; pop.push({p, q:m, a:r.read, X:r.pop}); push.push({p:m, q, a:'', X:r.push}); }
      else if(r.pop) pop.push({p, q, a:r.read, X:r.pop});
      else if(r.push) push.push({p, q, a:r.read, X:r.push});
      else plain.push({p, q, a:r.read});
    });
    return {nS, plain, push, pop, start:sid.get(P.start), accept:[...P.accept].filter(id=>sid.has(id)).map(id=>sid.get(id))};
  }

  // Exact membership, even when the stack can grow without bound. On the product of the states with the
  // input positions, first find every pair (u, v) where the machine can get from u to v with the stack ending
  // where it started and never dipping below it ("same level"); then search from the start, also allowing
  // pushes that are never popped. Accept if an accept state with all input read is reachable.
  // With open=true it answers instead "is w the start of some accepted string?": an extra position n+1
  // stands for "past w", where any symbol may be read.
  function pdaAccepts(C, w, open){
    const n = w.length, L = n + (open ? 2 : 1), N = C.nS*L, node = (s,i)=>s*L+i;
    const adv = (a,i) => a==='' ? i : i<n ? (w[i]===a ? i+1 : -1) : (open ? n+1 : -1);
    const plainOut = Array.from({length:N}, ()=>[]), pushOut = Array.from({length:N}, ()=>[]);
    const pushIn = Array.from({length:N}, ()=>[]), popOut = Array.from({length:N}, ()=>[]);
    for(let i=0;i<L;i++){
      C.plain.forEach(e=>{ const j = adv(e.a,i); if(j>=0) plainOut[node(e.p,i)].push(node(e.q,j)); });
      C.push.forEach(e=>{ const j = adv(e.a,i); if(j>=0){ pushOut[node(e.p,i)].push(node(e.q,j)); pushIn[node(e.q,j)].push({t:node(e.p,i), X:e.X}); } });
      C.pop.forEach(e=>{ const j = adv(e.a,i); if(j>=0) popOut[node(e.p,i)].push({v:node(e.q,j), X:e.X}); });
    }
    const out = Array.from({length:N}, ()=>new Set()), inn = Array.from({length:N}, ()=>new Set()), work = [];
    const add = (u,v)=>{ if(out[u].has(v)) return; out[u].add(v); inn[v].add(u); work.push(u, v); };
    for(let u=0;u<N;u++){ add(u,u); plainOut[u].forEach(v=>add(u,v)); }
    while(work.length){
      const v = work.pop(), u = work.pop();
      for(const x of [...out[v]]) add(u, x);
      for(const t of [...inn[u]]) add(t, v);
      if(pushIn[u].length && popOut[v].length)
        for(const a of pushIn[u]) for(const b of popOut[v]) if(a.X===b.X) add(a.t, b.v);
    }
    const seen = new Uint8Array(N), s0 = node(C.start, 0), st = [s0]; seen[s0] = 1;
    while(st.length){
      const u = st.pop();
      for(const v of out[u]) if(!seen[v]){ seen[v] = 1; st.push(v); }
      for(const v of pushOut[u]) if(!seen[v]){ seen[v] = 1; st.push(v); }
    }
    return C.accept.some(f=>seen[node(f, n)] || (open && seen[node(f, n+1)]));
  }

  // Is the language finite, and if so how long can its strings be? Uses the context-free grammar of the
  // PDA (A_pq: from p to q leaving the stack as it was; B_q: from the start to q with anything left on the stack).
  function pdaGrammarFacts(C){
    const nS = C.nS, A = (p,q)=>p*nS+q, B = q=>nS*nS+q, START = nS*nS+nS, NV = START+1;
    const rules = [];   // {lhs, vars:[v], t: number of terminals}
    const rule = (lhs, vars, t)=>rules.push({lhs, vars, t});
    for(let p=0;p<nS;p++){
      rule(A(p,p), [], 0);
      for(let q=0;q<nS;q++) for(let r=0;r<nS;r++) rule(A(p,q), [A(p,r), A(r,q)], 0);
      for(let q=0;q<nS;q++) rule(B(q), [B(p), A(p,q)], 0);
    }
    C.plain.forEach(e=>rule(A(e.p,e.q), [], e.a ? 1 : 0));
    C.push.forEach(u=>C.pop.forEach(o=>{ if(u.X===o.X) rule(A(u.p,o.q), [A(u.q,o.p)], (u.a?1:0) + (o.a?1:0)); }));
    C.push.forEach(u=>rule(B(u.q), [B(u.p)], u.a ? 1 : 0));   // a push that is never popped
    rule(B(C.start), [], 0);
    C.accept.forEach(f=>rule(START, [B(f)], 0));
    // which variables derive some string, and which derive a nonempty one
    const prod = new Uint8Array(NV), nonEmpty = new Uint8Array(NV);
    for(let changed = true; changed; ){
      changed = false;
      for(const r of rules){
        if(!prod[r.lhs] && r.vars.every(v=>prod[v])){ prod[r.lhs] = 1; changed = true; }
        if(!nonEmpty[r.lhs] && r.vars.every(v=>prod[v]) && (r.t>0 || r.vars.some(v=>nonEmpty[v]))){ nonEmpty[r.lhs] = 1; changed = true; }
      }
    }
    if(!prod[START]) return {empty:true, finite:true, maxLen:-1};
    const good = rules.filter(r=>prod[r.lhs] && r.vars.every(v=>prod[v]));
    const by = Array.from({length:NV}, ()=>[]); good.forEach(r=>by[r.lhs].push(r));
    const useful = new Uint8Array(NV), st = [START]; useful[START] = 1;
    while(st.length){ const v = st.pop(); by[v].forEach(r=>r.vars.forEach(x=>{ if(!useful[x]){ useful[x] = 1; st.push(x); } })); }
    // edges V → W, marked "growing" when the rest of the rule can derive something nonempty;
    // the language is infinite exactly when a growing edge lies on a cycle of useful variables
    const adj = Array.from({length:NV}, ()=>[]), growing = [];
    good.forEach(r=>{ if(!useful[r.lhs]) return;
      r.vars.forEach((w,k)=>{ adj[r.lhs].push(w);
        if(r.t>0 || r.vars.some((x,j)=>j!==k && nonEmpty[x])) growing.push([r.lhs, w]); }); });
    const comp = sccs(NV, adj, useful);
    const finite = !growing.some(([v,w])=>comp[v]===comp[w]);
    let maxLen = Infinity;
    if(finite){
      const len = new Float64Array(NV).fill(-Infinity);
      for(let round=0; round<=NV; round++){
        let changed = false;
        for(const r of good){
          let s = r.t; for(const v of r.vars){ s += len[v]; }
          if(s > len[r.lhs]){ len[r.lhs] = s; changed = true; }
        }
        if(!changed) break;
      }
      maxLen = len[START];
    }
    return {empty:false, finite, maxLen};
  }
  function sccs(n, adj, keep){
    const index = new Int32Array(n).fill(-1), low = new Int32Array(n), on = new Uint8Array(n), comp = new Int32Array(n).fill(-1);
    let next = 0, c = 0; const stack = [];
    for(let s=0;s<n;s++){
      if(!keep[s] || index[s]>=0) continue;
      const call = [[s, 0]]; index[s] = low[s] = next++; stack.push(s); on[s] = 1;
      while(call.length){
        const fr = call[call.length-1], v = fr[0];
        if(fr[1] < adj[v].length){
          const w = adj[v][fr[1]++];
          if(!keep[w]) continue;
          if(index[w]<0){ index[w] = low[w] = next++; stack.push(w); on[w] = 1; call.push([w, 0]); }
          else if(on[w]) low[v] = Math.min(low[v], index[w]);
        } else {
          call.pop();
          if(call.length){ const u = call[call.length-1][0]; low[u] = Math.min(low[u], low[v]); }
          if(low[v]===index[v]){ let w; do{ w = stack.pop(); on[w] = 0; comp[w] = c; } while(w!==v); c++; }
        }
      }
    }
    return comp;
  }
  // the language listed like the regex explorer's: all of it if finite, else the first `max` strings.
  // Goes length by length, but only extends prefixes that can still lead to an accepted string,
  // so sparse languages like 0ⁿ1ⁿ list quickly too.
  function pdaLanguage(P, sigma, max){
    max = max || 15;
    const C = pdaCore(P), facts = pdaGrammarFacts(C);
    if(facts.empty) return {strings:[], finite:true, truncated:false};
    const strings = [], t0 = performance.now(), S = sigma.slice().sort();
    let level = [[]], truncated = false;
    while(level.length){
      for(const w of level){
        if(pdaAccepts(C, w)){ strings.push(w.join('')); if(!facts.finite && strings.length>=max) return {strings, finite:false, truncated}; }
      }
      const next = [];
      for(const w of level){
        for(const c of S){
          if(performance.now() - t0 > 2000){ truncated = true; return {strings, finite:facts.finite, truncated}; }
          const v = w.concat([c]);
          if(pdaAccepts(C, v, true)) next.push(v);
        }
      }
      level = next;
    }
    return {strings, finite:facts.finite, truncated};
  }

  // the PDA in a builder's machine (rules {read, pop, push} with 'ε' or '' meaning nothing)
  function pdaFromMachine(M){
    const e = s => (s==='ε' || !s) ? '' : s;
    const rules = [];
    M.edges.forEach(ed=>ed.rules.forEach((r,k)=>rules.push({from:ed.from, to:ed.to, read:e(r.read), pop:e(r.pop), push:e(r.push), edgeId:ed.id, ruleIdx:k})));
    return {states:M.states.map(s=>s.id), start:M.startId, accept:new Set(M.states.filter(s=>s.kind==='accept').map(s=>s.id)), rules};
  }

  // what the PDA and DPDA builders share: rules "read, pop → push", where an empty box (or _) means ε
  const pdaRuleText = r => `${r.read}, ${r.pop} → ${r.push}`;
  function pdaParseRules(text){
    const rules = [];
    String(text).split(/[;\n]/).map(x=>x.trim()).filter(Boolean).forEach(part=>{
      const [lhs, rhs] = part.replace(/->/g,'→').split('→');
      const [read, pop] = lhs.split(',').map(x=>x.trim());
      const fix = x => (!x || x==='_' || x==='ε') ? EPS : x;
      rules.push({read:fix(read), pop:fix(pop), push:fix(rhs && rhs.trim())});
    });
    return {rules};
  }
  const pdaEditor = {
    columns: [
      {key:'read', type:'sym', label:'read', placeholder:EPS, dflt:()=>EPS},
      {type:'sep', text:','},
      {key:'pop', type:'sym', label:'pop', placeholder:EPS, dflt:()=>EPS},
      {type:'sep', text:'→'},
      {key:'push', type:'sym', label:'push', placeholder:EPS, dflt:()=>EPS}
    ],
    ruleNoun: 'rule',
    editorTitle: 'Rules for',
    editorHint: 'An empty box means ε; type <b>_</b> for a rule that is all ε (ε, ε → ε).<span class="kbd-tip"> Enter adds a rule, and Enter on an empty rule finishes.</span>',
    ruleText: pdaRuleText,
    parseRules: pdaParseRules,
    symInput: v => /_/.test(v) ? v.replace(/_/g, EPS) : v,
    plainAccept: true
  };
  // Σ is what the rules read; Γ is what they pop and push
  const pdaSigma = M => { const s = new Set(); M.edges.forEach(e=>e.rules.forEach(r=>{ if(r.read!==EPS) s.add(r.read); })); return [...s].sort(); };
  const pdaGamma = M => { const s = new Set(); M.edges.forEach(e=>e.rules.forEach(r=>{ [r.pop, r.push].forEach(x=>{ if(x!==EPS) s.add(x); }); })); return [...s].sort(); };
  // two moves clash in a DPDA when some configuration allows both
  const pdaClash = (r1, r2) => (r1.read===r2.read || r1.read===EPS || r2.read===EPS) && (r1.pop===r2.pop || r1.pop===EPS || r2.pop===EPS);

  // δ written out, one line per (state, read, pop) that has a move: δ(q, a, x) = {(r, y), …}
  function pdaDeltaHTML(M, findState, deterministic){
    const lab = id => `<span class="qq">${labelHTML(findState(id).label)}</span>`;
    const groups = new Map();
    M.edges.forEach(e=>e.rules.forEach(r=>{
      const k = e.from+'\u0000'+r.read+'\u0000'+r.pop;
      if(!groups.has(k)) groups.set(k, {from:e.from, read:r.read, pop:r.pop, to:[]});
      groups.get(k).to.push({to:e.to, push:r.push});
    }));
    const order = M.states.map(s=>s.id);
    const rows = [...groups.values()].sort((a,b)=> order.indexOf(a.from)-order.indexOf(b.from) || a.read.localeCompare(b.read) || a.pop.localeCompare(b.pop));
    if(!rows.length) return '<p class="tbl-note">There are no moves, so δ gives ∅ everywhere.</p>';
    let html = '<div class="tbl-wrap"><table class="delta pda-delta"><thead><tr><th class="corner">state, reads, pops</th><th>goes to, pushes</th></tr></thead><tbody>';
    rows.forEach(g=>{
      const pairs = g.to.map(t=>`(${lab(t.to)}, ${esc(t.push)})`);
      const acc = g.to.some(t=>findState(t.to).kind==='accept');
      html += `<tr><th>δ(${lab(g.from)}, ${esc(g.read)}, ${esc(g.pop)})</th><td${acc?' class="to-acc"':''}>= ${deterministic && pairs.length===1 ? pairs[0] : '{' + pairs.join(', ') + '}'}</td></tr>`;
    });
    html += '</tbody></table></div><p class="tbl-note">Every combination not listed gives ∅.</p>';
    return html;
  }

  MachineBuilder.sim = {pdaRuleText, pdaParseRules, pdaEditor, pdaSigma, pdaGamma, pdaClash, pdaDeltaHTML,EPS, player, animateTokens, fitCopy, buildTree, drawTree, scrollTreeTo, tester,
    pdaMoves, pdaCore, pdaAccepts, pdaGrammarFacts, pdaLanguage, pdaFromMachine};
})();

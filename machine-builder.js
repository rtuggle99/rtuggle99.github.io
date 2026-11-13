// machine-builder.js — the shared "draw your machine, then lock it in" editor used by the
// DFA, NFA, PDA and Turing machine explorers. A page describes its kind of machine with a
// spec (see the explorers for examples) and gets back the builder panel, already wired up.
(function(){
  'use strict';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const W = 900, H = 470, R = 24;
  const $ = id => document.getElementById(id);

  // ======================================================================
  //  helpers (shared with the pages through MachineBuilder.util)
  // ======================================================================
  function el(tag, attrs){ const e = document.createElementNS(SVG_NS, tag); for(const k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
  function esc(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  // a symbol with a combining dot above (0̇) is drawn with our own dot, since fonts place the combining one unreliably
  const DOT = '̇';
  function symHTML(s){ return esc(s).replace(/([^̇])̇/g, '<span class="dotted">$1</span>'); }
  // split into symbols as people see them, so a dotted 0̇ (0 plus a combining dot) counts as one symbol
  const graphemes = typeof Intl!=='undefined' && Intl.Segmenter ? new Intl.Segmenter() : null;
  function chars(s){ return graphemes ? Array.from(graphemes.segment(s), g=>g.segment) : Array.from(s); }
  function splitLabel(label){
    let m = /^(.*?)_\{?([^}]*)\}?$/.exec(label);
    if(m && m[1]) return [m[1], m[2]];
    m = /^(.*?)(\d+)$/.exec(label);
    if(m && m[1]) return [m[1], m[2]];
    return [label, ''];
  }
  function labelHTML(label){ const [a,b] = splitLabel(label); return esc(a) + (b ? '<sub>'+esc(b)+'</sub>' : ''); }
  function qHTML(label){ return `<span class="q">${labelHTML(label)}</span>`; }
  function setSvgLabel(t, label){
    const [a,b] = splitLabel(label);
    const main = document.createElementNS(SVG_NS,'tspan'); main.textContent = a; t.appendChild(main);
    if(b){
      const sub = document.createElementNS(SVG_NS,'tspan');
      sub.setAttribute('class','sub'); sub.setAttribute('dy','0.3em');
      sub.setAttribute('font-size', b.length>2 ? '0.68em' : '0.74em');
      sub.textContent = b; t.appendChild(sub);
    }
  }
  function shortlex(a, b){
    const A = chars(a), B = chars(b);
    if(A.length !== B.length) return A.length - B.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function plural(n, w){ return `${n.toLocaleString()} ${w}${n===1?'':'s'}`; }
  function setList(arr){ return '{' + arr.join(', ') + '}'; }
  const qi = l => `<i>${labelHTML(l)}</i>`;
  function plainLabel(l){ const [a,b]=splitLabel(l); return b ? a+b : a; }
  function emptyMachine(){ return {states:[], edges:[], startId:null, nextS:0, nextE:0}; }
  // the open spot on the canvas farthest from every state
  function freeSpot(m){
    let best = {x:W-90, y:H-60}, bestD = -1;
    for(let x=80; x<=W-80; x+=40) for(let y=60; y<=H-60; y+=40){
      const d = m.states.length ? Math.min(...m.states.map(s=>Math.hypot(s.x-x, s.y-y))) : 9999;
      if(d > bestD){ bestD = d; best = {x, y}; }
    }
    return best;
  }
  // startId is the machine's start state once exactly one state is marked
  function syncStart(m){
    const st = m.states.filter(s=>s.isStart);
    m.startId = st.length===1 ? st[0].id : null;
  }
  // machines from examples and share links may only carry startId
  function defaultRepair(m){
    m.states.forEach(s=>{ if(s.isStart===undefined) s.isStart = s.id===m.startId; });
    syncStart(m);
    return m;
  }
  // the first n strings over sigma, shortest first and then in alphabetical order (ε, 0, 1, 00, 01, …)
  function firstStrings(sigma, n){
    const out = [''];
    let layer = [''];
    while(out.length < n && sigma.length){
      const next = [];
      for(const w of layer){ for(const c of sigma){ next.push(w+c); if(out.length + next.length >= n) break; } if(out.length + next.length >= n) break; }
      out.push(...next); layer = next;
    }
    return out.slice(0, n);
  }
  // runs of 5+ of the same symbol are written with an exponent: 0000000 → 0⁷
  function shortWord(w){
    let out = '', cs = chars(w);
    for(let i=0;i<cs.length;){
      let j = i; while(j < cs.length && cs[j]===cs[i]) j++;
      const n = j - i;
      out += n >= 5 ? `${esc(cs[i])}<sup>${n}</sup>` : esc(cs[i]).repeat(n);
      i = j;
    }
    return out;
  }

  // ======================================================================
  //  the language of a finite automaton (DFA or NFA): is it finite, and its first strings
  // ======================================================================
  // fa: {states:[id], start:[id], accept:Set(id), trans:Map(id → Map(sym → [id])), eps:Map(id → [id]) (optional), sigma:[sym]}
  // Returns {strings, finite, truncated}: every string if the language is finite, otherwise the first
  // `max` (shortest first, then alphabetically), the same way the regex explorer lists L(R).
  function faLanguage(fa, max){
    max = max || 15;
    const eps = fa.eps || new Map(), trans = fa.trans;
    const out = id => { const o = []; (eps.get(id)||[]).forEach(t=>o.push({to:t, sym:false}));
      const m = trans.get(id); if(m) m.forEach(ts=>ts.forEach(t=>o.push({to:t, sym:true}))); return o; };
    const reach = (from, next) => { const seen = new Set(from), st = [...from];
      while(st.length){ const id = st.pop(); next(id).forEach(t=>{ if(!seen.has(t)){ seen.add(t); st.push(t); } }); } return seen; };
    const rev = new Map(fa.states.map(id=>[id, []]));
    fa.states.forEach(id=>out(id).forEach(e=>rev.get(e.to).push(id)));
    const reachable = reach(fa.start, id=>out(id).map(e=>e.to));
    const live = reach([...fa.accept], id=>rev.get(id));               // states that can still reach acceptance
    const useful = new Set([...reachable].filter(id=>live.has(id)));
    // infinite exactly when some symbol-reading arrow between useful states lies on a cycle
    let finite = true;
    for(const u of useful){
      for(const e of out(u)){
        if(!e.sym || !useful.has(e.to)) continue;
        if(reach([e.to], id=>out(id).map(x=>x.to).filter(t=>useful.has(t))).has(u)){ finite = false; break; }
      }
      if(!finite) break;
    }
    const closure = ids => reach(ids, id=>eps.get(id)||[]);
    const accepts = set => [...set].some(id=>fa.accept.has(id));
    const strings = [];
    let truncated = false, budget = 200000;
    const first = closure(fa.start);
    if([...first].some(id=>live.has(id))){
      if(accepts(first)) strings.push('');
      const queue = [{set:first, w:''}];
      for(let qi = 0; qi < queue.length; qi++){
        if(!finite && strings.length >= max) break;
        if(--budget <= 0){ truncated = true; break; }
        const {set, w} = queue[qi];
        for(const c of fa.sigma){
          const moved = [];
          set.forEach(id=>{ const m = trans.get(id); if(m && m.has(c)) moved.push(...m.get(c)); });
          if(!moved.length) continue;
          const next = closure(moved);
          if(![...next].some(id=>live.has(id))) continue;            // can never accept from here
          if(accepts(next)){ strings.push(w + c); if(!finite && strings.length >= max) break; }
          queue.push({set:next, w:w + c});
        }
      }
    }
    return {strings, finite, truncated};
  }
  // shows a language the way the regex explorer does: {ε, 0, 01, …} plus a note underneath
  function renderLanguage(boxEl, flagEl, lang, what){
    const {strings, finite, truncated} = lang;
    boxEl.textContent = !strings.length && finite ? '{} (this language contains no strings)'
      : '{' + strings.map(w=>w==='' ? 'ε' : w).join(', ') + (!finite ? ', …' : '') + '}';
    flagEl.textContent = finite
      ? `This language is finite (${plural(strings.length, 'string')}), listed shortest-first, then alphabetically.`
      : `This language is infinite: the first ${strings.length} strings are shown, listed shortest-first, then alphabetically.`;
    if(truncated) flagEl.textContent += ` (Listing stopped early: this ${what || 'machine'} is very complex.)`;
  }

  const util = {SVG_NS, W, H, R, $, el, clamp, esc, DOT, symHTML, chars, splitLabel, labelHTML, qHTML, setSvgLabel,
    shortlex, plural, setList, qi, plainLabel, emptyMachine, freeSpot, syncStart, defaultRepair, firstStrings, shortWord,
    faLanguage, renderLanguage};

  // collapsible sections (closed on every visit)
  function initCollapsibles(){
    document.querySelectorAll('.panel-toggle[data-body]').forEach(btn=>{
      const body = $(btn.dataset.body);
      const set = open => { btn.setAttribute('aria-expanded', open); body.hidden = !open; };
      set(false);
      btn.addEventListener('click', ()=>{
        const now = btn.getAttribute('aria-expanded')!=='true';
        set(now);
      });
    });
  }

  const DEFAULT_HINTS = {
    move: 'Drag a state to move it, or drag an arrow to bend it. Tap an arrow to edit it.',
    state: 'Tap empty space to place a new state.',
    arrow: 'Tap a state, then tap another (or the same one again) to draw a new arrow.',
    start: 'Tap a state to toggle whether it is a start state.',
    accept: 'Tap a state to toggle whether it is an accept state.',
    delete: 'Tap a state or an arrow to delete it.'
  };
  const TOOL_LABELS = {move:'Move', state:'Add state', arrow:'Draw arrow', start:'Toggle start', accept:'Toggle accept', delete:'Delete'};

  // ======================================================================
  //  the builder
  // ======================================================================
  // spec — everything that differs between kinds of machines:
  //   hashKey        share links look like page.html#<hashKey>=…
  //   title, aName   panel title ("Your DFA") and "A DFA" for messages
  //   tools          ['move','state','arrow','start','accept','delete'] in toolbar order
  //   hints          per-tool hint text (falls back to DEFAULT_HINTS)
  //   exampleMenu    [{group, items:[[key,label],…]} | [key,label], …];  example(key) → {build, input, sigma}
  //   starter()      the machine "Start from scratch" gives;  repair(m) fixes up loaded machines
  //   columns        the arrow editor's row layout, e.g. [{key:'read',type:'sym',label:'read',required:true}, {type:'sep',text:'→'}, …]
  //   ruleNoun, editorTitle, editorHint
  //   ruleText(rule), labelLines(rules), parseRules(text) → {rules}|{error};  optional rulesToShare/rulesFromShare
  //   symInput(value) rewrites what's typed in a symbol box (e.g. _ → ⊔)
  //   checkRule(rule, {seen, others, edge}) → {msg, key} | null   (seen: earlier rules on this arrow; others: [{edge, rule}] leaving the same state)
  //   analyze(m) → {problems:[text], conflictEdges:Set}   (shown live while building)
  //   lockCheck(sigma) → html message | null              (checked only when locking in)
  //   canStart(s), canLeave(s), canDelete(s), canAccept(s) → html message | null
  //   sigma: {mode:'input', guess(m), typeError(c), lockError(S)} or {mode:'infer', infer(m), emptyMsg}
  //   lockedPanels   ids of the sections shown once the machine is locked in
  //   onLock(), onUnlock(), beforeLoad(), getExtra() → {…}, setExtra(obj)
  function create(spec){
    const B = {};
    const HINTS = Object.assign({}, DEFAULT_HINTS, spec.hints||{});
    const sigmaMode = spec.sigma ? spec.sigma.mode : 'none';
    const collapsible = spec.collapsible!==false;          // locking in folds the builder away (otherwise it stays, grayed out)
    const hasMenu = !!(spec.exampleMenu && spec.exampleMenu.length);
    const canShare = spec.share!==false && !!spec.hashKey;      // the Share button
    const readsLinks = !!spec.hashKey;                            // links made earlier (page.html#key=…) still open
    const warnOnLeave = spec.warnOnLeave!=null ? spec.warnOnLeave : canShare;
    const columns = spec.columns.map(c=>Object.assign({width: c.type==='sep' ? (c.text===',' ? '0.6rem' : '1.2rem') : '4.6rem'}, c));
    const fieldCols = columns.filter(c=>c.type!=='sep');
    const symCols = columns.filter(c=>c.type==='sym');
    const ruleNoun = spec.ruleNoun || 'rule';
    const labelLines = spec.labelLines || (rules=>rules.map(spec.ruleText));
    const save = ()=>{ if(spec.save) spec.save(); };
    // 'rows': one row of boxes per rule (Turing machines, PDAs); 'list': one box of comma-separated symbols (DFAs, NFAs)
    const listMode = spec.editorKind==='list';

    let M = spec.starter();
    const findState = id => M.states.find(s=>s.id===id);
    const findEdge = id => M.edges.find(e=>e.id===id);
    const edgeBetween = (a,b) => M.edges.find(e=>e.from===a && e.to===b);
    const repair = m => spec.repair ? spec.repair(m) : defaultRepair(m);

    // ---------- the panel's markup ----------
    const panel = $(spec.panelId || 'buildPanel');
    const menuHTML = (spec.exampleMenu||[]).map(g=> Array.isArray(g)
      ? `<option value="${esc(g[0])}">${esc(g[1])}</option>`
      : `<optgroup label="${esc(g.group)}">${g.items.map(([k,l])=>`<option value="${esc(k)}">${esc(l)}</option>`).join('')}</optgroup>`).join('');
    const colHeads = columns.map(c=> c.type==='sep' ? '<span></span>' : `<span>${esc(c.label||'')}</span>`).join('');
    const gridCols = columns.map(c=>c.width).join(' ') + ' 1fr';
    const sigmaRowHTML = sigmaMode==='none' || (sigmaMode!=='input' && !spec.sigma.show) ? '' : sigmaMode==='input'
      ? `<div class="row sigma-row" id="sigmaRow">
          <label class="label sigma-label" for="sigmaType" title="The input alphabet"><span class="sym">Σ =</span></label>
          <div class="set-input" id="sigmaBox"><span class="brace">{</span><span id="sigmaSyms"></span><span class="ghost" id="sigmaGhost"></span><input id="sigmaType" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="Input alphabet Σ: type a symbol to add it"><span class="brace">}</span></div>
          <span class="note" id="sigmaHint"></span>
          <input type="hidden" id="sigmaIn">
        </div>`
      : `<div class="row sigma-row" id="sigmaRow">
          <span class="label sigma-label" title="The input alphabet"><span class="sym">Σ =</span></span>
          <div class="set-input disabled" id="sigmaBox"><span class="brace">{</span><span id="sigmaSyms"></span><span class="brace">}</span></div>
          <span class="note" id="sigmaHint"></span>
        </div>`;
    panel.innerHTML = `
      <div id="lockZone">
      <div class="panel-head">
        ${collapsible ? `<button class="panel-toggle" type="button" id="buildToggle" aria-expanded="true"><span class="chev" aria-hidden="true">▸</span><h2>${esc(spec.title)}</h2></button>` : `<h2>${esc(spec.title)}</h2>`}
        <span class="spacer"></span>
        <div class="row head-actions" style="gap:8px;">
          <span class="toast" id="toast" role="status" hidden></span>
          ${hasMenu ? `<select class="btn small" id="exampleSelect" aria-label="Load an example"><option value="">Examples…</option>${menuHTML}</select>` : ''}
          ${canShare ? '<button class="btn small" id="shareBtn" title="Copy a link to this machine">Share</button>' : ''}
          <span class="lock-icon" aria-label="Locked" title="Locked in. Press “Edit machine” to change it.">🔒</span>
        </div>
      </div>
      ${canShare ? `<div class="share-fallback" id="shareFallback" hidden>
        <label for="shareUrl">Your browser blocked automatic copying. Copy this link instead:</label>
        <input class="text-in" id="shareUrl" type="text" readonly>
      </div>` : ''}
      <div id="lockable">
        <div class="row" id="toolRow">
          <div class="tools" id="tools">${spec.tools.map((t,i)=>`<button class="tool${i===0?' active':''}" data-tool="${t}">${TOOL_LABELS[t]}</button>`).join('')}</div>
          <span class="spacer"></span>
          <button class="btn small" id="undoBtn" title="Undo (Ctrl+Z)">↶ Undo</button>
        </div>
        <p class="hint" id="hint"></p>
        <div class="stage-wrap" id="stageWrap">
        <svg class="stage mode-move" id="builderSvg" viewBox="0 0 ${W} ${H}"></svg>
        ${listMode ? `<div class="editor popover list-editor" id="edgeEditor" role="dialog" hidden>
          <div class="re-head" title="Drag to move this box"><label class="te-label" id="edgeLabel" for="listIn"></label><span class="grip" aria-hidden="true" title="Drag to move this box">⠿</span></div>
          <div class="te-row"><input class="text-in te-input" id="listIn" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="${esc(spec.listPlaceholder||'e.g. 0, 1')}">${spec.epsilonButton ? '<button class="btn small te-eps" id="epsBtn" type="button" title="Insert ε">ε</button>' : ''}</div>
          <span class="te-error" id="edgeError" hidden></span>
          <span class="te-hint">${spec.editorHint||''}</span>
          <div class="re-actions">
            <span class="spacer"></span>
            <button class="btn small danger" id="edgeDelete" type="button">Delete arrow</button>
            <button class="btn small primary" id="edgeSave" type="button">Done</button>
          </div>
        </div>` : `<div class="editor rules-editor popover" id="edgeEditor" role="dialog" hidden>
          <div class="re-head" title="Drag to move this box"><span class="te-label" id="edgeLabel"></span><span class="grip" aria-hidden="true" title="Drag to move this box">⠿</span></div>
          <div class="rule-cols" aria-hidden="true" style="grid-template-columns:${gridCols}">${colHeads}</div>
          <div id="ruleRows"></div>
          <div class="re-actions">
            <button class="btn small" id="addRule" type="button">+ Add ${esc(ruleNoun)}</button>
            <span class="spacer"></span>
            <button class="btn small danger" id="edgeDelete" type="button">Delete arrow</button>
            <button class="btn small primary" id="edgeSave" type="button">Done</button>
          </div>
          <span class="te-hint">${spec.editorHint||''}</span>
          <span class="te-error" id="edgeError" hidden></span>
        </div>`}
        </div>
        <ul class="problems" id="problems" hidden></ul>
      </div>
      ${sigmaRowHTML}
      </div>
      <div class="row lock-row">
        <span class="spacer"></span>
        <div class="row" style="gap:8px;">
          ${spec.clearButton ? '<button class="btn" id="clearBtn" type="button" title="Remove every state and arrow (you can undo this)">Clear</button>' : ''}
          <span class="note lock-err" id="lockErr" style="color:var(--danger)"></span>
          <button class="btn primary" id="lockBtn">${esc(spec.lockLabel || 'Lock in machine')}</button>
          <button class="btn primary" id="editBtn" hidden>${esc(spec.editLabel || 'Edit machine')}</button>
        </div>
      </div>`;

    const builderSvg = $('builderSvg'), hintEl = $('hint'), problemsEl = $('problems'), lockErr = $('lockErr');
    const edgeEditor = $('edgeEditor'), edgeLabel = $('edgeLabel'), edgeError = $('edgeError'), ruleRows = $('ruleRows'), listIn = $('listIn');
    let editingEdge = null, editingIsNew = false;
    if(window.ResizeObserver) new ResizeObserver(()=>placeEditor()).observe(edgeEditor);
    // drag the box by its title bar, e.g. to uncover part of the drawing
    edgeEditor.querySelector('.re-head').addEventListener('pointerdown', e=>{
      if(e.button!==0) return;
      e.preventDefault();
      const head = e.currentTarget, wrap = stageWrap.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY, left0 = edgeEditor.offsetLeft, top0 = edgeEditor.offsetTop;
      head.setPointerCapture(e.pointerId); head.classList.add('dragging');
      const move = ev=>{
        editorMoved = true;
        const pw = edgeEditor.offsetWidth, ph = edgeEditor.offsetHeight;
        edgeEditor.style.left = clamp(left0 + ev.clientX - startX, -pw + 60, wrap.width - 60) + 'px';
        edgeEditor.style.top = clamp(top0 + ev.clientY - startY, -ph + 40, wrap.height + 120) + 'px';
      };
      const up = ()=>{ head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); head.classList.remove('dragging'); };
      head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
    });
    window.addEventListener('resize', ()=>placeEditor());
    let tool = spec.tools[0], pendingFrom = null, snapX = null, snapY = null;
    let locked = false;

    // ======================================================================
    //  diagram drawing (shared by the builder and the page's read-only copies)
    // ======================================================================
    const MARKERS = {arrow:'#3d5a75', 'arrow-info':'#2f6690', 'arrow-danger':'#a8384a', 'arrow-ink':'#16324f'};
    function addDefs(svg, prefix){
      const defs = el('defs',{});
      for(const id in MARKERS){
        const m = el('marker',{id:prefix+id, viewBox:'0 0 10 10', refX:'9', refY:'5', markerWidth:'7', markerHeight:'7', orient:'auto-start-reverse'});
        m.appendChild(el('path',{d:'M0,0 L10,5 L0,10 z', fill:MARKERS[id]}));
        defs.appendChild(m);
      }
      svg.appendChild(defs);
    }
    // Edges as arcs of circles (madebyevan-style). `curve` keeps its meaning: the arc's peak sits
    // curve/2 off the straight line between the states, the same spot the old curves peaked at.
    function edgeGeometry(x1,y1,x2,y2,curve,side){
      const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy)||1, ux=dx/len, uy=dy/len, nxs=-uy, nys=ux;
      const h = curve/2;
      if(Math.abs(h) < 0.5){
        const sx=x1+ux*R, sy=y1+uy*R, ex=x2-ux*(R+1), ey=y2-uy*(R+1), sign=side||1;
        return {d:`M ${sx} ${sy} L ${ex} ${ey}`, px:(sx+ex)/2, py:(sy+ey)/2, nx:nxs*sign, ny:nys*sign};
      }
      const x3=(x1+x2)/2+nxs*h, y3=(y1+y2)/2+nys*h;
      const D = 2*(x1*(y2-y3)+x2*(y3-y1)+x3*(y1-y2));
      const cx = ((x1*x1+y1*y1)*(y2-y3)+(x2*x2+y2*y2)*(y3-y1)+(x3*x3+y3*y3)*(y1-y2))/D;
      const cy = ((x1*x1+y1*y1)*(x3-x2)+(x2*x2+y2*y2)*(x1-x3)+(x3*x3+y3*y3)*(x2-x1))/D;
      const r = Math.hypot(x1-cx, y1-cy);
      const TAU = 2*Math.PI, norm = a => ((a % TAU) + TAU) % TAU;
      const a1 = Math.atan2(y1-cy, x1-cx), a2 = Math.atan2(y2-cy, x2-cx), a3 = Math.atan2(y3-cy, x3-cx);
      const dir = norm(a3-a1) < norm(a2-a1) ? 1 : -1;            // which way round the circle passes the peak
      const s0 = a1 + dir*R/r, e0 = a2 - dir*(R+1)/r;              // trim to the state circles
      const sx=cx+r*Math.cos(s0), sy=cy+r*Math.sin(s0), ex=cx+r*Math.cos(e0), ey=cy+r*Math.sin(e0);
      const span = dir>0 ? norm(e0-s0) : norm(s0-e0);
      const d = `M ${sx} ${sy} A ${r} ${r} 0 ${span>Math.PI?1:0} ${dir>0?1:0} ${ex} ${ey}`;
      return {d, px:x3, py:y3, nx:(x3-cx)/r, ny:(y3-cy)/r};
    }
    // Self-loops as most of a small circle sitting on the state, like madebyevan's designer.
    function loopGeometry(x,y,angleDeg,h){
      const a = angleDeg*Math.PI/180, rl = 0.75*R, cx = x+Math.cos(a)*1.5*R, cy = y+Math.sin(a)*1.5*R;
      const s0 = a - 0.8*Math.PI, e0 = a + 0.8*Math.PI;
      const sx=cx+rl*Math.cos(s0), sy=cy+rl*Math.sin(s0), ex=cx+rl*Math.cos(e0), ey=cy+rl*Math.sin(e0);
      // arrowhead: tip on the loop's end point, turned 0.4π past the circle's direction there (as madebyevan does)
      return {d:`M ${sx} ${sy} A ${rl} ${rl} 0 1 1 ${ex} ${ey}`, loop:true, tipX:ex, tipY:ey, tipAngle:e0 + 0.4*Math.PI,
        px:cx+Math.cos(a)*rl, py:cy+Math.sin(a)*rl, nx:Math.cos(a), ny:Math.sin(a)};
    }
    function obstructed(ax, ay, bx, by, aId, bId){
      const lx=bx-ax, ly=by-ay, len2=lx*lx+ly*ly;
      if(len2<1) return false;
      return M.states.some(p=>{
        if(p.id===aId || p.id===bId) return false;
        const t=((p.x-ax)*lx+(p.y-ay)*ly)/len2;
        if(t<=0.08 || t>=0.92) return false;
        return Math.hypot(p.x-(ax+t*lx), p.y-(ay+t*ly)) < R+14;
      });
    }
    function drawLabel(svg, x, y, lines, nx, ny, edgeId, usedIdx, placeholder){
      const g = el('g', edgeId ? {'data-edge-id':edgeId} : {});
      const t = el('text',{class: placeholder ? 'edge-label-placeholder' : 'edge-label', x, y});
      const LH = 15;
      lines.forEach((line,i)=>{
        const ts = document.createElementNS(SVG_NS,'tspan');
        ts.setAttribute('x', x); ts.setAttribute('dy', i===0 ? 0 : LH);
        if(i===usedIdx) ts.setAttribute('class','rule-used');
        ts.textContent = line.split(DOT).join(''); t.appendChild(ts);
      });
      g.appendChild(t); svg.appendChild(g);
      let bb; try{ bb = t.getBBox(); }catch(e){ bb = null; }
      if(!bb || !bb.width){ const w = 7*Math.max(...lines.map(l=>l.length)); bb = {x:x-w/2, y:y-11, width:w, height:LH*lines.length}; }
      const off = 7 + Math.abs(nx)*bb.width/2 + Math.abs(ny)*bb.height/2;
      const dx = x + nx*off - (bb.x + bb.width/2), dy = y + ny*off - (bb.y + bb.height/2);
      t.setAttribute('y', y+dy);
      [...t.children].forEach(ts=>ts.setAttribute('x', x+dx));
      g.insertBefore(el('rect',{class:'edge-label-bg', x:bb.x+dx-3, y:bb.y+dy-3, width:bb.width+6, height:bb.height+6, rx:4}), t);
      // dots over dotted symbols, placed over the character they belong to
      let base = 0;
      lines.forEach((line,i)=>{
        let k = 0;
        for(const ch of line){
          if(ch===DOT){
            try{ const ex = t.getExtentOfChar(base + k - 1);
              g.appendChild(el('circle',{class:'edge-dot'+(i===usedIdx?' rule-used':''), cx:ex.x+ex.width/2, cy:ex.y+ex.height*0.085, r:1.3})); }catch(e){}
          } else k += ch.length;
        }
        base += k;
      });
    }
    // opts: {interactive, prefix, cur, used, haltCls, conflictEdges, selected, pending}
    //   cur may be a single state id or a Set of ids (for nondeterministic machines);
    //   used may be one {edgeId, ruleIdx} or an array of them
    function drawMachine(svg, opts){
      svg.innerHTML = '';
      svg.classList.toggle('plain-accept', !!spec.plainAccept);
      const P = opts.prefix;
      addDefs(svg, P);
      const usedList = !opts.used ? [] : Array.isArray(opts.used) ? opts.used : [opts.used];
      const usedPaths = [];
      M.edges.forEach(edge=>{
        const a = findState(edge.from), b = findState(edge.to);
        if(!a||!b) return;
        const uses = usedList.filter(u=>u.edgeId===edge.id);
        const isUsed = uses.length>0;
        let g;
        if(edge.from===edge.to){
          g = loopGeometry(a.x, a.y, edge.loopAngle!=null ? edge.loopAngle : -90, edge.loopRadius!=null ? edge.loopRadius : 66);
        } else {
          let def = 0;
          if(edgeBetween(edge.to, edge.from)) def = 32;
          else {
            const ob = obstructed(a.x,a.y,b.x,b.y,edge.from,edge.to);
            if(opts.interactive){
              if(ob && !edge.lastObstructed) edge.curveManual = false;
              edge.lastObstructed = ob;
            }
            if(ob) def = 50;
          }
          g = edgeGeometry(a.x,a.y,b.x,b.y, edge.curveManual ? edge.curve : def, edge.labelSide);
        }
        if(opts.interactive) svg.appendChild(el('path',{class:'edge-hit', d:g.d, 'data-edge-id':edge.id}));
        const bad = opts.conflictEdges && opts.conflictEdges.has(edge.id);
        const editing = opts.editing===edge.id;
        const markerId = isUsed || editing ? 'arrow-info' : bad ? 'arrow-danger' : 'arrow';
        const p = el('path',{class:'edge-path'+(isUsed?' used':'')+(bad?' conflict':'')+(editing?' editing':''), d:g.d});
        if(!g.loop) p.setAttribute('marker-end', `url(#${P}${markerId})`);
        svg.appendChild(p);
        if(g.loop){
          const L = isUsed ? 13 : 11, Wd = isUsed ? 6.5 : 5.5, ux = Math.cos(g.tipAngle), uy = Math.sin(g.tipAngle);
          const bx = g.tipX - ux*L, by = g.tipY - uy*L;
          svg.appendChild(el('path',{d:`M ${g.tipX} ${g.tipY} L ${bx - uy*Wd} ${by + ux*Wd} L ${bx + uy*Wd} ${by - ux*Wd} Z`, fill:MARKERS[markerId], 'pointer-events':'none'}));
        }
        if(isUsed){ usedPaths.push(p); if(opts.tagUsed) p.setAttribute('data-edge', edge.id); }
        const lines = edge.rules.length ? labelLines(edge.rules) : [`add ${ruleNoun}s`];
        const usedIdx = isUsed ? (spec.usedLine ? spec.usedLine(uses[0].ruleIdx, edge.rules) : uses[0].ruleIdx) : -1;
        drawLabel(svg, g.px, g.py, lines, g.nx, g.ny, opts.interactive ? edge.id : null, usedIdx, edge.rules.length===0);
      });
      M.states.filter(s=>s.isStart).forEach(s0=>{
        const ang = (s0.startAngle!=null ? s0.startAngle : 180)*Math.PI/180;
        const fx=s0.x+Math.cos(ang)*(R+44), fy=s0.y+Math.sin(ang)*(R+44), nx=s0.x+Math.cos(ang)*(R+2), ny=s0.y+Math.sin(ang)*(R+2);
        if(opts.interactive) svg.appendChild(el('line',{class:'start-hit', 'data-start-id':s0.id, x1:fx, y1:fy, x2:nx, y2:ny}));
        svg.appendChild(el('line',{class:'start-arrow', x1:fx, y1:fy, x2:nx, y2:ny, 'marker-end':`url(#${P}arrow-ink)`}));
      });
      const isCur = id => opts.cur instanceof Set ? opts.cur.has(id) : id===opts.cur;
      M.states.forEach(s=>{
        let cls = 'st st-'+s.kind;
        if(isCur(s.id)) cls += ' ' + (opts.haltCls || 'st-current');
        if(opts.selected===s.id || opts.pending===s.id) cls += ' st-selected';
        if(opts.classes && opts.classes.has(s.id)) cls += ' ' + opts.classes.get(s.id);
        const g = el('g',{class:cls});
        if(opts.interactive){
          g.setAttribute('data-state-id', s.id);
          g.setAttribute('style', 'cursor:'+(tool==='move'?'grab':'pointer'));
          g.appendChild(el('circle',{class:'state-hit', cx:s.x, cy:s.y, r:R+12}));
        }
        g.appendChild(el('circle',{class:'state-circle', cx:s.x, cy:s.y, r:R}));
        if(s.kind==='accept') g.appendChild(el('circle',{class:'state-inner', cx:s.x, cy:s.y, r:R-(spec.plainAccept ? 6 : 5)}));
        const sub = splitLabel(s.label)[1];
        // baseline placed explicitly (not dominant-baseline, which Safari positions differently) so the whole label (letter, tail and subscript) is centered
        const t = el('text',{class:'state-label', x:s.x, y:s.y + (sub ? 2.2 : 4)});
        if(sub && sub.length>2) t.setAttribute('font-size','16');
        setSvgLabel(t, s.label);
        g.appendChild(t);
        svg.appendChild(g);
      });
      return Array.isArray(opts.used) ? usedPaths : (usedPaths[0] || null);
    }

    // ======================================================================
    //  builder
    // ======================================================================
    function renderBuilder(){
      const {conflictEdges} = spec.analyze(M);
      drawMachine(builderSvg, {interactive:true, prefix:'b-', conflictEdges, pending:pendingFrom, editing:editingEdge});
      if(snapX!=null) builderSvg.appendChild(el('line',{class:'snap-guide', x1:snapX, y1:0, x2:snapX, y2:H}));
      if(snapY!=null) builderSvg.appendChild(el('line',{class:'snap-guide', x1:0, y1:snapY, x2:W, y2:snapY}));
      placeEditor();
    }
    // The arrow editor floats over the canvas next to the arrow's label (below it if there's room
    // on the canvas, otherwise above), so opening it never moves the drawing.
    const stageWrap = $('stageWrap');
    let editorMoved = false;   // once dragged by its title bar, the box stays where it was put until it closes
    function placeEditor(){
      if(!edgeEditor || edgeEditor.hidden || !editingEdge || editorMoved) return;
      const wrap = stageWrap.getBoundingClientRect();
      const lab = builderSvg.querySelector(`g[data-edge-id="${editingEdge}"]`);
      const r = lab ? lab.getBoundingClientRect() : wrap;
      const pw = edgeEditor.offsetWidth, ph = edgeEditor.offsetHeight, gap = 10;
      const left = clamp(r.left + r.width/2 - wrap.left - pw/2, 4, Math.max(4, wrap.width - pw - 4));
      const below = r.bottom - wrap.top + gap, above = r.top - wrap.top - gap - ph;
      const top = (below + ph <= wrap.height - 4 || above < 4) ? below : above;
      edgeEditor.style.left = left + 'px'; edgeEditor.style.top = top + 'px';
    }
    let noteTimer = null;
    function setTool(t){
      tool = t; pendingFrom = null;
      document.querySelectorAll('#tools .tool').forEach(b=>b.classList.toggle('active', b.dataset.tool===t));
      builderSvg.classList.toggle('mode-move', t==='move');
      clearTimeout(noteTimer); hintEl.classList.remove('warn'); hintEl.textContent = HINTS[t];
      if(t!=='move') closeEditors();
      renderBuilder();
    }
    $('tools').addEventListener('click', e=>{ const b = e.target.closest('.tool'); if(b) setTool(b.dataset.tool); });

    const undoStack = [];
    function pushUndo(){ undoStack.push(JSON.stringify(M)); if(undoStack.length>100) undoStack.shift(); }
    function undo(){ if(locked || !undoStack.length) return; M = JSON.parse(undoStack.pop()); closeEditors(); changed(); }
    $('undoBtn').addEventListener('click', undo);

    function changed(){
      syncStart(M);
      const {problems} = spec.analyze(M);
      problemsEl.hidden = problems.length===0;
      problemsEl.innerHTML = problems.map(p=>`<li>${esc(p)}</li>`).join('');
      lockErr.textContent = '';
      renderBuilder();
      renderSigma();
      save();
    }

    function svgPoint(evt){
      const pt = builderSvg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
      const loc = pt.matrixTransform(builderSvg.getScreenCTM().inverse());
      return {x:loc.x, y:loc.y};
    }
    function freshNumberedLabel(){
      const used = new Set(M.states.map(s=>s.label));
      let i = 0; while(used.has('q'+i)) i++;
      return 'q'+i;
    }
    function addStateAt(x,y){
      pushUndo();
      const id = 's'+(M.nextS++);
      M.states.push({id, x:clamp(x,R+4,W-R-4), y:clamp(y,R+4,H-R-4), label:freshNumberedLabel(), kind:'normal', startAngle:null});
      if(!M.states.some(s=>s.isStart)) M.states[M.states.length-1].isStart = true;
      changed();
    }
    function deleteState(id){
      const s = findState(id); if(!s) return;
      const why = spec.canDelete && spec.canDelete(s);
      if(why){ note(why); return; }
      pushUndo();
      M.states = M.states.filter(x=>x.id!==id);
      M.edges = M.edges.filter(e=>e.from!==id && e.to!==id);
      closeEditors(); changed();
    }
    function deleteEdge(id){ pushUndo(); M.edges = M.edges.filter(e=>e.id!==id); closeEditors(); changed(); }

    let pointer = null, downX=0, downY=0, dragKind=null, dragId=null, dragMoved=false, dragUndo=false;
    builderSvg.addEventListener('pointerdown', e=>{
      if(locked) return;
      const sT = e.target.closest('[data-state-id]');
      const eT = !sT ? e.target.closest('[data-edge-id]') : null;
      const stT = !sT && !eT ? e.target.closest('[data-start-id]') : null;
      if(!edgeEditor.hidden && !(eT && eT.dataset.edgeId===editingEdge)){ if(!saveEdge()) return; }
      downX = e.clientX; downY = e.clientY; dragMoved = false; dragUndo = false;
      if(sT||eT||stT){
        dragKind = sT ? 'state' : eT ? 'edge' : 'start';
        dragId = sT ? sT.dataset.stateId : eT ? eT.dataset.edgeId : stT.dataset.startId;
        pointer = e.pointerId; e.preventDefault();
        window.addEventListener('pointermove', onMove, {passive:false});
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      } else { dragKind = null; dragId = null; }
    });
    builderSvg.addEventListener('pointerup', e=>{ if(!locked && !dragKind) tap(e, null, null); });
    builderSvg.addEventListener('dblclick', e=>{
      if(locked || tool!=='move' || e.target.closest('[data-state-id],[data-edge-id],[data-start-id]')) return;
      const p = svgPoint(e); addStateAt(p.x, p.y);
    });
    function onMove(e){
      if(pointer===null || e.pointerId!==pointer || !dragKind) return;
      if(!dragMoved && Math.hypot(e.clientX-downX, e.clientY-downY) < 5) return;
      if(dragKind==='state' && tool!=='move') return;
      if(!dragUndo){ pushUndo(); dragUndo = true; }
      dragMoved = true; e.preventDefault();
      const p = svgPoint(e);
      if(dragKind==='state'){
        const s = findState(dragId); if(!s) return;
        let px = clamp(p.x, R+4, W-R-4), py = clamp(p.y, R+4, H-R-4), bx=null, bxd=10, by=null, byd=10;
        M.states.forEach(o=>{ if(o.id===dragId) return;
          const dx=Math.abs(px-o.x); if(dx<bxd){bxd=dx;bx=o.x;}
          const dy=Math.abs(py-o.y); if(dy<byd){byd=dy;by=o.y;} });
        if(bx!=null) px=bx; if(by!=null) py=by;
        s.x=px; s.y=py; snapX=bx; snapY=by;
      } else if(dragKind==='edge'){
        const edge = findEdge(dragId); if(!edge) return;
        if(edge.from===edge.to){
          const s = findState(edge.from);
          let ang = Math.atan2(p.y-s.y, p.x-s.x)*180/Math.PI;
          for(const c of [-180,-135,-90,-45,0,45,90,135,180]) if(Math.abs(ang-c)<8){ ang=c; break; }
          edge.loopAngle = ang; edge.loopRadius = clamp(Math.hypot(p.x-s.x, p.y-s.y)-R, 30, 150);
        } else {
          const a = findState(edge.from), b = findState(edge.to);
          const lx=b.x-a.x, ly=b.y-a.y, len=Math.hypot(lx,ly)||1;
          const proj = (p.x-(a.x+b.x)/2)*(-ly/len) + (p.y-(a.y+b.y)/2)*(lx/len);
          edge.curveManual = true;
          if(Math.abs(proj)<18){ edge.curve = 0; edge.labelSide = proj<0?-1:1; } else edge.curve = clamp(proj*2, -500, 500);
        }
      } else if(dragKind==='start'){
        const s = findState(dragId);
        let ang = Math.atan2(p.y-s.y, p.x-s.x)*180/Math.PI;
        for(const c of [-180,-90,0,90,180]) if(Math.abs(ang-c)<10){ ang=c; break; }
        s.startAngle = ang;
      }
      renderBuilder();
    }
    function onUp(e){
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if(pointer===null || e.pointerId!==pointer) return;
      pointer = null;
      const kind=dragKind, id=dragId, moved=dragMoved;
      dragKind=null; dragId=null; dragMoved=false; snapX=null; snapY=null;
      if(kind && moved){ renderBuilder(); save(); return; }
      if(kind==='state') tap(e, id, null);
      else if(kind==='edge') tap(e, null, id);
    }
    function tap(e, stateId, edgeId){
      if(stateId){
        if(tool==='move') return;
        if(tool==='start'){
          const s = findState(stateId);
          const why = spec.canStart && spec.canStart(s);
          if(why){ note(why); return; }
          pushUndo(); s.isStart = !s.isStart;
          if(s.isStart && s.startAngle==null) s.startAngle = bestLoopAngle(s);   // point the new start arrow into open space
          changed(); return;
        }
        if(tool==='accept'){
          const s = findState(stateId);
          const why = spec.canAccept && spec.canAccept(s);
          if(why){ note(why); return; }
          pushUndo(); s.kind = s.kind==='accept' ? 'normal' : 'accept';
          changed(); return;
        }
        if(tool==='delete'){ deleteState(stateId); return; }
        if(tool==='arrow'){
          if(!pendingFrom){
            const s = findState(stateId);
            const why = spec.canLeave && spec.canLeave(s);
            if(why){ note(why); return; }
            pendingFrom = stateId; renderBuilder(); return;
          }
          const from = pendingFrom; pendingFrom = null;
          let edge = edgeBetween(from, stateId);
          if(edge){ renderBuilder(); openEdgeEditor(edge.id, false); return; }
          pushUndo();
          edge = newEdge(from, stateId, []);
          M.edges.push(edge);
          renderBuilder();
          openEdgeEditor(edge.id, true);
        }
        return;
      }
      if(edgeId){ if(tool==='delete') deleteEdge(edgeId); else openEdgeEditor(edgeId, false); return; }
      if(tool==='state'){ const p = svgPoint(e); addStateAt(p.x, p.y); }
      else if(pendingFrom){ pendingFrom = null; renderBuilder(); }
    }
    function newEdge(from, to, rules){
      const edge = {id:'e'+(M.nextE++), from, to, rules, curve:0, curveManual:false, labelSide:1, loopAngle:null, loopRadius:null, lastObstructed:false};
      if(from===to) edge.loopAngle = bestLoopAngle(findState(from));
      return edge;
    }
    function bestLoopAngle(s){
      let best = -90, score = -Infinity;
      [-90, 90, 0, 180, -45, -135, 45, 135].forEach(c=>{
        const r = c*Math.PI/180, px = s.x+Math.cos(r)*70, py = s.y+Math.sin(r)*70;
        if(px<30 || px>W-30 || py<30 || py>H-30) return;
        let sc = 0; M.states.forEach(o=>{ if(o.id!==s.id) sc += Math.min(Math.hypot(o.x-px, o.y-py), 200); });
        if(sc>score){ score = sc; best = c; }
      });
      return best;
    }

    // ---------- arrow editor: one row per rule, laid out by spec.columns ----------

    function makeRow(row){
      const div = document.createElement('div');
      div.className = 'rule-row';
      div.style.gridTemplateColumns = gridCols;
      div.innerHTML = columns.map(c=>{
        if(c.type==='sep') return `<span class="sep">${esc(c.text)}</span>`;
        if(c.type==='sym') return `<span class="rr-box"><input class="text-in rr-in rr-${c.key}" data-k="${c.key}" type="text" maxlength="1" autocomplete="off" spellcheck="false"${c.placeholder?` placeholder="${esc(c.placeholder)}"`:''} aria-label="${esc(c.label||c.key)}"></span>`;
        return `<div class="seg rr-choice rr-${c.key}" data-k="${c.key}" role="radiogroup" aria-label="${esc(c.label||c.key)}">${c.options.map(o=>`<button type="button" data-m="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
      }).join('') + `<div class="rr-tail"><button type="button" class="rr-del" title="Remove this ${esc(ruleNoun)}">✕</button></div><span class="rr-err"></span>`;
      columns.forEach(c=>{
        if(c.type==='sym') setBox(div.querySelector('.rr-'+c.key), row[c.key] || '');
        else if(c.type==='choice') setChoice(div, c.key, row[c.key] || c.dflt || c.options[0]);
      });
      return div;
    }
    function setChoice(div, key, m){
      div.dataset[key] = m;
      div.querySelectorAll(`.rr-${key} button`).forEach(b=>{ b.classList.toggle('on', b.dataset.m===m); b.setAttribute('aria-pressed', b.dataset.m===m); });
    }
    const firstField = div => div.querySelector('.rr-in') || div.querySelector('.rr-choice button.on');
    function addRow(row, focus){
      const div = makeRow(row || {});
      ruleRows.appendChild(div);
      if(focus) firstField(div).focus();
      return div;
    }
    function rowIsEmpty(div){ return symCols.every(c=>!boxVal(div.querySelector('.rr-'+c.key))); }
    // a dotted symbol sits in its box as the plain character plus our own dot, since input boxes can't place the font's dot reliably
    function setBox(inp, v){ const dot = v.endsWith(DOT); inp.value = dot ? v.slice(0,-DOT.length) : v; inp.dataset.dot = dot ? '1' : ''; inp.parentNode.classList.toggle('dot', dot); }
    function boxVal(inp){ const v = inp.value.trim(); return v && inp.dataset.dot ? v + DOT : v; }

    function openEdgeEditor(id, isNew){
      closeEditors();
      const e = findEdge(id); if(!e) return;
      editingEdge = id; editingIsNew = isNew; editorMoved = false;
      edgeLabel.innerHTML = `${spec.editorTitle || 'Rules for'} <i>${labelHTML(findState(e.from).label)}</i> → <i>${labelHTML(findState(e.to).label)}</i>`;
      edgeError.hidden = true; edgeEditor.hidden = false;
      if(listMode){
        listIn.value = e.rules.map(r=>r[fieldCols[0].key]).join(', ');
        listIn.classList.remove('bad');
      } else {
        ruleRows.innerHTML = '';
        const rows = e.rules.map(r=>Object.assign({}, r));
        (rows.length ? rows : [{}]).forEach(r=>addRow(r, false));
        validateRows(false);
      }
      renderBuilder();   // highlights the arrow and places the editor by its label
      if(listMode){ listIn.focus({preventScroll:true}); listIn.select(); }
      else firstField(ruleRows.lastElementChild).focus({preventScroll:true});
      edgeEditor.scrollIntoView({block:'nearest', behavior:'smooth'});
    }

    // list editor: symbols separated by commas (or spaces). Shows its own error; returns the rules or null.
    function listRules(){
      const e = findEdge(editingEdge); if(!e) return null;
      const key = fieldCols[0].key;
      const fail = msg => { edgeError.innerHTML = msg; edgeError.hidden = false; listIn.classList.add('bad'); return null; };
      const parts = listIn.value.split(/[,\s]+/).map(x=>x.trim()).filter(Boolean);
      const long = parts.find(x=>chars(x).length!==1);
      if(long) return fail(`Each symbol is a single character, but “${esc(long)}” isn’t. Separate symbols with commas, like 0, 1.`);
      const others = [];
      M.edges.forEach(o=>{ if(o!==e && o.from===e.from) o.rules.forEach(r=>others.push({edge:o, rule:r})); });
      const rules = [];
      for(const x of parts){
        if(rules.some(r=>r[key]===x)) continue;
        const rule = {[key]:x};
        const bad = spec.checkRule && spec.checkRule(rule, {seen:rules, others, edge:e});
        if(bad) return fail(bad.msg);
        rules.push(rule);
      }
      return rules;
    }
    if(listMode){
      listIn.addEventListener('input', ()=>{ edgeError.hidden = true; listIn.classList.remove('bad'); });
      listIn.addEventListener('keydown', ev=>{
        if(ev.key==='Enter'){ ev.preventDefault(); saveEdge(); }
        else if(ev.key==='Escape'){ ev.preventDefault(); discardNewEdge(); closeEditors(); renderBuilder(); }
      });
      const eps = $('epsBtn');
      if(eps) eps.addEventListener('click', ()=>{
        const v = listIn.value.trim();
        listIn.value = v ? v.replace(/,?\s*$/, '') + ', ε' : 'ε';
        listIn.focus(); edgeError.hidden = true; listIn.classList.remove('bad');
      });
    }

    // Checks every row; marks problems on the row itself. Returns the rules, or null if something is wrong.
    // `strict` also reports half-filled rows (used when saving, not while typing).
    function validateRows(strict){
      const e = findEdge(editingEdge); if(!e) return null;
      const others = [];   // rules on this state's other arrows
      M.edges.forEach(o=>{ if(o!==e && o.from===e.from) o.rules.forEach(r=>others.push({edge:o, rule:r})); });
      const rules = [];
      let ok = true;
      [...ruleRows.children].forEach(div=>{
        const err = div.querySelector('.rr-err');
        const box = {}, val = {};
        symCols.forEach(c=>{ box[c.key] = div.querySelector('.rr-'+c.key); val[c.key] = boxVal(box[c.key]); });
        if(symCols.every(c=>!val[c.key])){ err.textContent = ''; symCols.forEach(c=>box[c.key].classList.remove('bad')); return; }
        let msg = '', badKey = null;
        const missing = symCols.find(c=>c.required && !val[c.key]);
        if(missing && strict){ msg = missing.missing || 'This box is empty.'; badKey = missing.key; }
        if(!msg){ const long = symCols.find(c=>chars(val[c.key]).length>1); if(long){ msg = long.tooLong || 'Use a single symbol'; badKey = long.key; } }
        let rule = null;
        if(!msg && !missing){
          rule = {};
          fieldCols.forEach(c=>{ rule[c.key] = c.type==='choice' ? div.dataset[c.key] : (val[c.key] || (c.dflt ? c.dflt(rule) : '')); });
          const bad = spec.checkRule && spec.checkRule(rule, {seen:rules, others, edge:e});
          if(bad){ msg = bad.msg; badKey = bad.key; }
        }
        err.innerHTML = msg;
        symCols.forEach(c=>box[c.key].classList.toggle('bad', c.key===badKey));
        if(msg){ ok = false; return; }
        if(rule) rules.push(rule);
      });
      return ok ? rules : null;
    }

    function discardNewEdge(){
      const e = findEdge(editingEdge);
      if(editingIsNew && e){ M.edges = M.edges.filter(x=>x!==e); undoStack.pop(); }
    }
    // returns false if the editor had to stay open because of an error
    function saveEdge(){
      const e = findEdge(editingEdge);
      if(!e){ closeEditors(); return true; }
      const rules = listMode ? listRules() : validateRows(true);
      if(!rules){
        if(listMode){ listIn.focus(); return false; }
        edgeError.hidden = true; const bad = ruleRows.querySelector('.bad'); if(bad) bad.focus(); return false;
      }
      if(!rules.length){
        if(editingIsNew){ discardNewEdge(); closeEditors(); renderBuilder(); return true; }
        edgeError.textContent = `Add at least one ${ruleNoun}, or press “Delete arrow”.`; edgeError.hidden = false; return false;
      }
      const same = JSON.stringify(rules)===JSON.stringify(e.rules);
      if(!same && !editingIsNew) pushUndo();
      e.rules = rules;
      closeEditors(); changed();
      return true;
    }

    // the field after `t` in its row: a symbol box, or the selected button of a choice
    function nextField(row, t){
      const k = t.dataset.k, i = fieldCols.findIndex(c=>c.key===k), c = fieldCols[i+1];
      if(!c) return null;
      return c.type==='sym' ? row.querySelector('.rr-'+c.key) : row.querySelector(`.rr-${c.key} button.on`);
    }
    if(!listMode){
    ruleRows.addEventListener('input', ev=>{
      const t = ev.target;
      if(t.classList.contains('rr-in') && t.dataset.dot){ t.dataset.dot = ''; t.parentNode.classList.remove('dot'); }
      if(t.classList.contains('rr-in') && spec.symInput){
        const v = spec.symInput(t.value);
        if(v!==t.value){ const pos = t.selectionStart; t.value = v; t.setSelectionRange(pos, pos); }
      }
      edgeError.hidden = true;
      validateRows(false);
      if(ev.inputType && ev.inputType.startsWith('insert') && t.value){
        const row = t.closest('.rule-row'), next = nextField(row, t);
        if(next) next.focus();
        else if(!row.querySelector('.rr-err').textContent){   // last box filled in: move on to a fresh row
          const after = row.nextElementSibling;
          if(after) firstField(after).focus(); else addRow({}, true);
        }
      }
    });
    ruleRows.addEventListener('click', ev=>{
      const mb = ev.target.closest('.rr-choice button');
      if(mb){ setChoice(mb.closest('.rule-row'), mb.closest('.rr-choice').dataset.k, mb.dataset.m); return; }
      const del = ev.target.closest('.rr-del');
      if(del){
        const row = del.closest('.rule-row');
        const next = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        if(!ruleRows.children.length) addRow({}, true);
        else if(next) firstField(next).focus();
        validateRows(false);
      }
    });
    ruleRows.addEventListener('keydown', ev=>{
      const row = ev.target.closest('.rule-row'); if(!row) return;
      const seg = ev.target.closest('.rr-choice');
      if(seg){
        const c = fieldCols.find(c=>c.key===seg.dataset.k), opts = c.options;
        const hit = ev.key.length===1 && opts.find(o=>o.toLowerCase()===ev.key.toLowerCase());
        if(hit){ ev.preventDefault(); setChoice(row, c.key, hit); return; }
        if(ev.key==='ArrowLeft' || ev.key==='ArrowRight'){
          ev.preventDefault();
          const i = clamp(opts.indexOf(row.dataset[c.key]) + (ev.key==='ArrowLeft' ? -1 : 1), 0, opts.length-1);
          setChoice(row, c.key, opts[i]); row.querySelector(`.rr-${c.key} [data-m="${opts[i]}"]`).focus(); return;
        }
      }
      if(ev.key==='Enter'){
        ev.preventDefault();
        if(rowIsEmpty(row)){ saveEdge(); return; }               // Enter on an empty rule finishes
        const next = row.nextElementSibling;
        if(next) firstField(next).focus();
        else addRow({}, true);
      }
      if(ev.key==='Escape'){ ev.preventDefault(); discardNewEdge(); closeEditors(); renderBuilder(); }
    });
    $('addRule').addEventListener('click', ()=>addRow({}, true));
    }
    $('edgeSave').addEventListener('click', saveEdge);
    $('edgeDelete').addEventListener('click', ()=>{
      const id = editingEdge;
      if(editingIsNew){ discardNewEdge(); closeEditors(); renderBuilder(); }
      else { closeEditors(); deleteEdge(id); }
    });

    function closeEditors(){
      if(edgeEditor.contains(document.activeElement)) document.activeElement.blur();
      edgeEditor.hidden = true;
      editingEdge = null; editingIsNew = false;
    }

    // ======================================================================
    //  Σ, lock in / edit
    // ======================================================================
    const sigmaBox = $('sigmaBox'), sigmaSyms = $('sigmaSyms'), sigmaHint = $('sigmaHint');
    const sigmaIn = $('sigmaIn'), sigmaType = $('sigmaType'), sigmaGhost = $('sigmaGhost');
    let SIGMA = [];
    // ---------- Σ as a set: type a symbol, the braces and commas take care of themselves ----------
    const sigmaList = () => sigmaMode!=='input' ? spec.sigma.infer(M) : sigmaIn.value ? sigmaIn.value.split(',').filter(Boolean) : [];
    function parseSigma(str){ return [...new Set(chars(str.replace(/[\s,{}]/g,'')))].sort(); }
    function setSigma(str){ if(sigmaMode!=='input') return; sigmaIn.value = [...new Set(chars(String(str||'').replace(/[\s,{}]/g,'')))].join(','); renderSigma(); }
    function renderSigma(){
      if(!sigmaBox) return;
      const list = sigmaList();
      if(sigmaMode!=='input'){
        sigmaSyms.innerHTML = list.map((c,i)=>`<span class="s-item">${esc(c)}${i<list.length-1 ? ', ' : ''}</span>`).join('');
        sigmaHint.textContent = locked ? '' : list.length ? 'read off the arrows' : 'the symbols on your arrows';
        return;
      }
      const focused = sigmaBox.classList.contains('focused');
      sigmaSyms.innerHTML = list.map((c,i)=>`<span class="s-item">${esc(c)}${i<list.length-1 ? ', ' : ''}</span>`).join('');
      const guess = !list.length ? spec.sigma.guess(M) : '';
      sigmaGhost.textContent = guess ? guess.split(',').join(', ') : '';
      sigmaHint.textContent = guess && focused ? 'Tab to use these' : '';
    }
    if(sigmaMode==='input'){
      const sigmaRefuse = msg => {
        sigmaBox.classList.remove('shake'); void sigmaBox.offsetWidth; sigmaBox.classList.add('shake');
        if(msg){ lockErr.textContent = msg; }
      };
      const sigmaChanged = () => { sigmaBox.classList.remove('bad'); lockErr.textContent = ''; renderSigma(); save(); };
      sigmaBox.addEventListener('mousedown', e=>{ if(e.target!==sigmaType && !locked){ e.preventDefault(); sigmaType.focus(); } });
      sigmaType.addEventListener('focus', ()=>{ sigmaBox.classList.add('focused'); renderSigma(); });
      sigmaType.addEventListener('blur', ()=>{ sigmaBox.classList.remove('focused'); renderSigma(); });
      sigmaType.addEventListener('input', ()=>{
        const typed = chars(sigmaType.value); sigmaType.value = '';
        let list = sigmaList(), changedAny = false;
        typed.forEach(c=>{
          if(/[\s,{}]/.test(c)) return;
          const why = spec.sigma.typeError && spec.sigma.typeError(c);
          if(why){ sigmaRefuse(why); return; }
          if(list.includes(c)){ sigmaRefuse(); return; }
          list.push(c); changedAny = true;
        });
        if(changedAny){ sigmaIn.value = list.join(','); sigmaChanged(); }
      });
      sigmaType.addEventListener('keydown', e=>{
        if(e.key==='Backspace' && !sigmaType.value){
          const list = sigmaList();
          if(list.length){ e.preventDefault(); list.pop(); sigmaIn.value = list.join(','); sigmaChanged(); }
        } else if(e.key==='Tab' && !e.shiftKey && !sigmaList().length && spec.sigma.guess(M)){
          e.preventDefault(); setSigma(spec.sigma.guess(M)); sigmaChanged();
        } else if(e.key==='Enter'){ e.preventDefault(); tryLock(true); }
      });
    }

    function setLocked(on, scroll){
      locked = on;
      panel.classList.toggle('is-locked', on);
      if(collapsible) setBuilderOpen(!on); else renderBuilder();
      $('lockBtn').hidden = on; $('editBtn').hidden = !on;
      if($('clearBtn')) $('clearBtn').hidden = on;
      if(sigmaBox && sigmaMode==='input'){ sigmaBox.classList.toggle('disabled', on); sigmaType.disabled = on; }
      renderSigma();
      const exSel = $('exampleSelect');
      if(exSel){
        exSel.disabled = on;
        exSel.title = on ? 'Press “Edit machine” to load a different machine' : '';
        if(on) exSel.blur();
      }
      (spec.lockedPanels||[]).forEach(id=>$(id).hidden = !on);
      if(on){
        if(spec.onLock) spec.onLock();
        if(scroll && spec.lockedPanels && spec.lockedPanels.length) $(spec.lockedPanels[0]).scrollIntoView({behavior:'smooth', block:'start'});
      } else {
        if(spec.onUnlock) spec.onUnlock();
      }
      save();
    }
    // The builder opens and closes like the other sections; locking in closes it, editing opens it.
    function setBuilderOpen(open){
      panel.classList.toggle('collapsed', !open);
      $('buildToggle').setAttribute('aria-expanded', open);
      if(open) renderBuilder();   // it may have been hidden, so redraw now that labels can be measured
    }
    if(collapsible) $('buildToggle').addEventListener('click', ()=>{
      const open = $('buildToggle').getAttribute('aria-expanded')!=='true';
      if(!open){ if(!edgeEditor.hidden && !saveEdge()) return; pendingFrom = null; }
      setBuilderOpen(open);
    });
    function tryLock(scroll){
      if(!edgeEditor.hidden && !saveEdge()) return false;
      pendingFrom = null;
      const {problems} = spec.analyze(M);
      if(problems.length){ lockErr.textContent = 'Fix the problems above first.'; return false; }
      if(!M.states.length){ lockErr.textContent = 'Add at least one state first.'; return false; }
      const starts = M.states.filter(s=>s.isStart).length;
      if(spec.multiStart ? starts===0 : starts!==1){ lockErr.textContent = starts===0 ? 'Set a start state first.' : `${spec.aName} has exactly one start state, but ${starts} are marked.`; return false; }
      let S;
      if(sigmaMode==='input'){
        if(!sigmaIn.value.trim()) setSigma(spec.sigma.guess(M));
        S = parseSigma(sigmaIn.value);
        if(!S.length){ lockErr.textContent = 'Enter the input alphabet Σ: type its symbols, e.g. 0 then 1.'; sigmaBox.classList.add('bad'); sigmaType.focus(); return false; }
        const why = spec.sigma.lockError && spec.sigma.lockError(S);
        if(why){ lockErr.textContent = why; sigmaBox.classList.add('bad'); sigmaType.focus(); return false; }
        sigmaBox.classList.remove('bad'); lockErr.textContent = '';
        setSigma(S.join(','));
      } else if(sigmaMode==='infer'){
        S = spec.sigma.infer(M);
        if(!S.length && spec.sigma.emptyMsg){ lockErr.textContent = spec.sigma.emptyMsg; return false; }
      } else S = [];
      const why = spec.lockCheck && spec.lockCheck(S);
      if(why){ lockErr.innerHTML = why; return false; }
      lockErr.textContent = '';
      SIGMA = S;
      setLocked(true, scroll);
      return true;
    }
    $('lockBtn').addEventListener('click', ()=>tryLock(true));
    $('editBtn').addEventListener('click', ()=>{ setLocked(false); panel.scrollIntoView({behavior:'smooth', block:'start'}); });
    // buttons a page puts inside a lock-in message (data-action="…") call spec.actions[…]
    lockErr.addEventListener('click', e=>{
      const b = e.target.closest('[data-action]');
      if(b && spec.actions && spec.actions[b.dataset.action]) spec.actions[b.dataset.action]();
    });

    // ======================================================================
    //  examples
    // ======================================================================
    function mk(states, edges, start){
      const m = emptyMachine(), idOf = {};
      states.forEach(([label,x,y,kind,startAngle])=>{ const id = 's'+(m.nextS++); idOf[label] = id; m.states.push({id, x, y, label, kind:kind||'normal', startAngle:startAngle??null}); });
      edges.forEach(([from,to,text,o])=>{
        o = o||{};
        m.edges.push({id:'e'+(m.nextE++), from:idOf[from], to:idOf[to], rules:spec.parseRules(text).rules,
          curve:o.curve ?? 0, curveManual:o.curve!=null, labelSide:o.side ?? 1, loopAngle:o.loop ?? null, loopRadius:o.radius ?? null, lastObstructed:o.curve!=null});
      });
      m.startId = idOf[start];
      return repair(m);
    }
    function loadExample(key, lockAfter){
      if(spec.beforeLoad) spec.beforeLoad();
      closeEditors();
      pushUndo();
      if(locked) setLocked(false);
      if(key==='blank'){ M = spec.starter(); if(spec.setExtra) spec.setExtra({}); setSigma(''); }
      else { const ex = spec.example(key); M = ex.build(); if(spec.setExtra) spec.setExtra({w:ex.input}); setSigma(ex.sigma); }
      setTool('move'); changed(); markSaved();
      if(key!=='blank' && lockAfter) tryLock(false);
    }
    if(hasMenu) $('exampleSelect').addEventListener('change', e=>{
      const key = e.target.value;
      e.target.value = ''; e.target.blur();
      if(key && !locked){ loadExample(key, false); panel.scrollIntoView({behavior:'smooth', block:'start'}); }
    });

    // ======================================================================
    //  sharing
    // ======================================================================
    const rulesToShare = spec.rulesToShare || (rules=>rules.map(spec.ruleText).join('; '));
    const rulesFromShare = spec.rulesFromShare || (text=>spec.parseRules(text).rules||[]);
    function machineObj(){
      return {
        s: M.states.map(s=>[s.label, Math.round(s.x), Math.round(s.y), s.kind[0], s.startAngle==null?null:Math.round(s.startAngle), s.isStart?1:0]),
        e: M.edges.map(e=>[M.states.findIndex(s=>s.id===e.from), M.states.findIndex(s=>s.id===e.to), rulesToShare(e.rules),
              e.curveManual ? Math.round(e.curve) : null, e.labelSide, e.loopAngle==null?null:Math.round(e.loopAngle), e.loopRadius==null?null:Math.round(e.loopRadius)]),
        st: M.states.findIndex(s=>s.id===M.startId)
      };
    }
    function shareObj(){
      const c = Object.assign(machineObj(), spec.getExtra ? spec.getExtra() : {});
      if(sigmaMode==='input') c.sg = sigmaIn.value;
      return c;
    }
    // warn before leaving only if the machine was changed since it was loaded or last shared
    let savedKey = '';
    function machineKey(){ const c = machineObj(); if(sigmaMode==='input') c.sg = sigmaIn.value; return JSON.stringify(c); }
    function markSaved(){ savedKey = machineKey(); }
    if(warnOnLeave) window.addEventListener('beforeunload', e=>{ if(savedKey && machineKey()!==savedKey){ e.preventDefault(); e.returnValue = ''; } });
    function encodeShare(){
      const c = shareObj();
      return btoa(unescape(encodeURIComponent(JSON.stringify(c)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    }
    function decodeShare(str){
      const c = JSON.parse(decodeURIComponent(escape(atob(str.replace(/-/g,'+').replace(/_/g,'/')))));
      const m = emptyMachine(), kinds = {n:'normal', a:'accept', r:'reject'};
      c.s.forEach(([label,x,y,k,sa,st])=>m.states.push({id:'s'+(m.nextS++), label, x, y, kind:kinds[k]||'normal', startAngle:sa, isStart: st===undefined ? undefined : !!st}));
      c.e.forEach(([f,t,rules,curve,side,la,lr])=>m.edges.push({id:'e'+(m.nextE++), from:m.states[f].id, to:m.states[t].id,
        rules:rulesFromShare(rules), curve:curve??0, curveManual:curve!=null, labelSide:side||1, loopAngle:la, loopRadius:lr, lastObstructed:curve!=null}));
      m.startId = c.st>=0 && m.states[c.st] ? m.states[c.st].id : null;
      return {m:repair(m), extra:c, sg:c.sg||''};
    }
    const toast = $('toast'); let toastTimer = null;
    function flash(msg){ if(!msg) return; toast.textContent = msg; toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(()=>toast.hidden = true, 3500); }
    // messages about the drawing go in the hint line under the tools (where the eye already is), then the hint comes back
    function note(html, plain){
      hintEl.innerHTML = html; hintEl.classList.toggle('warn', !plain);
      clearTimeout(noteTimer); noteTimer = setTimeout(()=>{ hintEl.classList.remove('warn'); hintEl.textContent = HINTS[tool]; }, 4500);
    }
    if(canShare) $('shareBtn').addEventListener('click', async ()=>{
      const url = location.href.split('#')[0] + '#' + spec.hashKey + '=' + encodeShare();
      const fb = $('shareFallback'), fbIn = $('shareUrl');
      try{
        if(!navigator.clipboard || !window.isSecureContext) throw new Error('no clipboard');
        await navigator.clipboard.writeText(url);
        fb.hidden = true; flash('Link copied'); markSaved();
      }catch(e){ fbIn.value = url; fb.hidden = false; fbIn.focus(); fbIn.select(); markSaved(); }
    });
    function loadFromHash(){
      if(!readsLinks) return false;
      const hm = new RegExp('#' + spec.hashKey + '=([A-Za-z0-9_-]+)').exec(location.hash);
      if(!hm) return false;
      let d; try{ d = decodeShare(hm[1]); }catch(e){ return false; }
      if(spec.beforeLoad) spec.beforeLoad();
      closeEditors();
      pushUndo();
      if(locked) setLocked(false);
      M = d.m; if(spec.setExtra) spec.setExtra(d.extra); setSigma(d.sg);
      try{ history.replaceState(null, '', location.href.split('#')[0]); }catch(e){}
      setTool('move'); changed(); markSaved();
      return true;
    }
    if(readsLinks) window.addEventListener('hashchange', loadFromHash);
    if(spec.clearButton) $('clearBtn').addEventListener('click', ()=>{ if(!locked){ loadExample('blank', false); note('Cleared. Press Undo to bring it back.', true); } });

    // ======================================================================
    //  keyboard (the page handles its own keys while locked)
    // ======================================================================
    document.addEventListener('keydown', e=>{
      const tag = (e.target.tagName||'').toLowerCase();
      if(tag==='input' || tag==='textarea' || tag==='select') return;
      if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z'){ e.preventDefault(); undo(); return; }
      if(e.ctrlKey||e.metaKey||e.altKey) return;
      if(e.key==='Escape'){ if(!locked){ pendingFrom = null; discardNewEdge(); closeEditors(); renderBuilder(); } return; }
    });

    initCollapsibles();

    // ======================================================================
    //  what the page gets
    // ======================================================================
    Object.defineProperties(B, {
      M: {get: ()=>M},
      locked: {get: ()=>locked},
      sigma: {get: ()=>SIGMA}
    });
    Object.assign(B, {
      findState, findEdge, edgeBetween, draw: drawMachine, mk, newEdge, note, flash, save, setSigma,
      sigmaText: () => sigmaMode==='input' ? sigmaIn.value : '',
      // change the machine from page code (e.g. a "fix it for me" button): fn(M) edits it in place
      edit(fn){ if(locked) return; pushUndo(); fn(M); closeEditors(); changed(); },
      tryLock,
      // load a shared link if there is one, otherwise the default example
      start(defaultExample){
        if(loadFromHash()){ undoStack.length = 0; return; }
        setTool(spec.tools[0]); loadExample(defaultExample, false); undoStack.length = 0;
      }
    });
    return B;
  }

  window.MachineBuilder = {create, util};
})();

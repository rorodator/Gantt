// gantt.js — Moteur de rendu SVG du diagramme de Gantt
'use strict';

const GanttRenderer = (() => {

  // Palette de 10 couleurs accessibles pour les personnes
  const PALETTE = [
    '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6',
    '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#84cc16',
  ];

  // Dimensions (px)
  const LW   = 225;  // largeur colonne labels
  const ROW  = 38;   // hauteur ligne tâche
  const SEC  = 27;   // hauteur ligne section
  const AX   = 50;   // hauteur en-tête axe temporel
  const BPD  = 7;    // padding vertical barre (haut et bas)
  const BH   = ROW - BPD * 2;  // hauteur barre = 24

  // ─── Helpers date ─────────────────────────────────────────

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + Math.round(n));
    return d;
  }

  function durToDays(v, u) {
    const n = parseFloat(v) || 1;
    return u === 'w' ? n * 7 : u === 'm' ? n * 30 : n;
  }

  function parseISO(iso) {
    return iso ? new Date(iso + 'T00:00:00') : null;
  }

  // ─── Résolution des dates (gestion des dépendances) ───────

  function resolveAll(tasks) {
    const map = {};
    tasks.forEach(t => {
      map[t.id] = {
        ...t,
        s: parseISO(t.startDate),
        e: null,
        d: durToDays(t.duration, t.unit),
      };
    });
    // Passes itératives pour résoudre les chaînes de dépendances
    for (let pass = 0; pass <= tasks.length; pass++) {
      tasks.forEach(t => {
        const r = map[t.id];
        if (t.dependsOn && map[t.dependsOn]?.e) {
          r.s = new Date(map[t.dependsOn].e);
        }
        if (r.s && r.d > 0) {
          r.e = addDays(r.s, r.d);
        }
      });
    }
    return map;
  }

  // ─── Granularité de l'axe ─────────────────────────────────

  function getGranularity(minD, maxD) {
    const days = (maxD - minD) / 86400000;
    if (days <= 42)  return 'day';
    if (days <= 210) return 'week';
    return 'month';
  }

  function weekNum(d) {
    const u = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = u.getUTCDay() || 7;
    u.setUTCDate(u.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(u.getUTCFullYear(), 0, 1));
    return Math.ceil(((u - y0) / 86400000 + 1) / 7);
  }

  function generateTicks(minD, maxD, gran) {
    const list = [];
    const c = new Date(minD);
    if (gran === 'day') {
      c.setHours(0, 0, 0, 0);
      while (c <= maxD) { list.push(new Date(c)); c.setDate(c.getDate() + 1); }
    } else if (gran === 'week') {
      const wd = c.getDay();
      c.setDate(c.getDate() - (wd === 0 ? 6 : wd - 1));
      c.setHours(0, 0, 0, 0);
      while (c <= maxD) { list.push(new Date(c)); c.setDate(c.getDate() + 7); }
    } else {
      c.setDate(1); c.setHours(0, 0, 0, 0);
      while (c <= maxD) { list.push(new Date(c)); c.setMonth(c.getMonth() + 1); }
    }
    return list;
  }

  function tickLabel(d, gran) {
    if (gran === 'day')  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    if (gran === 'week') return `S${weekNum(d)}`;
    return d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
  }

  // ─── Helpers SVG ──────────────────────────────────────────

  function el(tag, attrs = {}) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null) e.setAttribute(k, String(v));
    }
    return e;
  }

  function txt(content, attrs = {}) {
    const e = el('text', attrs);
    e.textContent = content;
    return e;
  }

  // ─── Couleur personne ─────────────────────────────────────

  function personColor(person, persons) {
    if (!person) return '#94a3b8';
    const i = persons.indexOf(person);
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  }

  // Luminance pour choisir couleur de texte sur barre
  function lum(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  // Tronque un texte en fonction de la largeur pixel disponible
  function trunc(text, availPx, fsPx = 11) {
    const chW = fsPx * 0.62;
    const max = Math.floor(availPx / chW);
    if (max <= 0) return '';
    return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
  }

  // ─── Rendu principal ──────────────────────────────────────

  function render(state, container, filterPerson) {
    const { sections = [], tasks = [], customStatuses = [], title = '' } = state;

    if (!tasks.length) {
      container.innerHTML = '<div class="gantt-placeholder"><p>Ajoutez des tâches pour afficher le diagramme de Gantt.</p></div>';
      return;
    }

    const resolved = resolveAll(tasks);
    const valid = Object.values(resolved).filter(r => r.s && r.e);

    if (!valid.length) {
      container.innerHTML = '<div class="gantt-placeholder"><p>Définissez une date de début ou une dépendance pour vos tâches.</p></div>';
      return;
    }

    // Plage temporelle + marge
    const minTs = Math.min(...valid.map(r => r.s.getTime()));
    const maxTs = Math.max(...valid.map(r => r.e.getTime()));
    const rangeDays = (maxTs - minTs) / 86400000;
    const pad = Math.max(1, Math.ceil(rangeDays * 0.04));
    const minD = addDays(new Date(minTs), -pad);
    const maxD = addDays(new Date(maxTs), pad);

    const gran  = getGranularity(minD, maxD);
    const ticks = generateTicks(minD, maxD, gran);
    const minPx = { day: 32, week: 64, month: 84 }[gran];

    // Dimensions SVG
    const cW = Math.max((container.clientWidth || 900) - LW - 32, ticks.length * minPx);
    const totalW = LW + cW;
    const span  = maxD.getTime() - minD.getTime();
    const xOf   = d => LW + (d.getTime() - minD.getTime()) / span * cW;

    // Tri topologique : une tâche dépendante apparaît toujours après sa parente
    const tMap   = Object.fromEntries(tasks.map(t => [t.id, t]));
    const tSeen  = new Set();
    const sorted = [];
    function topoVisit(t) {
      if (tSeen.has(t.id)) return;
      tSeen.add(t.id);
      if (t.dependsOn && tMap[t.dependsOn]) topoVisit(tMap[t.dependsOn]);
      sorted.push(t);
    }
    tasks.forEach(t => topoVisit(t));

    // Construction des lignes (sections + tâches ordonnées)
    const sMap  = Object.fromEntries(sections.map(s => [s.id, s]));
    const bySec = {};
    sorted.forEach(t => { const k = t.sectionId || '_'; (bySec[k] = bySec[k] || []).push(t); });
    const secOrder = [
      ...sections.map(s => s.id).filter(id => bySec[id]),
      ...(bySec['_'] ? ['_'] : []),
    ];

    const rows = [];
    secOrder.forEach(sid => {
      if (sid !== '_' && sMap[sid]) rows.push({ type: 's', data: sMap[sid] });
      (bySec[sid] || []).forEach(t => rows.push({ type: 't', data: t }));
    });

    // Liste ordonnée des personnes (ordre d'apparition)
    const persons = [];
    tasks.forEach(t => { if (t.person && !persons.includes(t.person)) persons.push(t.person); });

    const totalH = AX + rows.reduce((s, r) => s + (r.type === 's' ? SEC : ROW), 0) + 6;

    // ── Création SVG ────────────────────────────────────────
    const svg = el('svg', {
      width: totalW,
      height: totalH,
      xmlns: 'http://www.w3.org/2000/svg',
      'xmlns:xlink': 'http://www.w3.org/1999/xlink',
      'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });

    // ── Defs ────────────────────────────────────────────────
    const defs = el('defs');

    // Pattern hachuré pour statut "done"
    const hp = el('pattern', { id: 'gh', x: 0, y: 0, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hp.appendChild(el('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: 'rgba(255,255,255,0.52)', 'stroke-width': 4 }));
    defs.appendChild(hp);

    // ClipPath zone graphique
    const cc = el('clipPath', { id: 'gc' });
    cc.appendChild(el('rect', { x: LW, y: 0, width: cW + 30, height: totalH }));
    defs.appendChild(cc);

    // ClipPath zone labels
    const lc = el('clipPath', { id: 'gl' });
    lc.appendChild(el('rect', { x: 0, y: AX, width: LW - 6, height: totalH - AX }));
    defs.appendChild(lc);

    svg.appendChild(defs);

    // ── Fond général ─────────────────────────────────────────
    svg.appendChild(el('rect', { x: 0, y: 0, width: totalW, height: totalH, fill: '#f1f5f9' }));
    svg.appendChild(el('rect', { x: 0, y: 0, width: LW, height: totalH, fill: '#ffffff' }));

    // ── Grille verticale ────────────────────────────────────
    const gridG = el('g', { 'clip-path': 'url(#gc)' });
    ticks.forEach(d => {
      const x = Math.round(xOf(d));
      // Ligne plus marquée au début du mois/semaine selon granularité
      const strong = gran === 'month' || (gran === 'week' && d.getDate() <= 7);
      gridG.appendChild(el('line', {
        x1: x, y1: AX, x2: x, y2: totalH,
        stroke: strong ? '#cbd5e1' : '#e2e8f0',
        'stroke-width': strong ? 1 : 0.5,
      }));
    });
    svg.appendChild(gridG);

    // ── Fonds des lignes ─────────────────────────────────────
    const rowBgG = el('g');
    let ry = AX;
    rows.forEach((row, idx) => {
      if (row.type === 's') {
        rowBgG.appendChild(el('rect', { x: 0, y: ry, width: totalW, height: SEC, fill: '#1e293b' }));
        ry += SEC;
      } else {
        rowBgG.appendChild(el('rect', { x: LW, y: ry, width: cW, height: ROW, fill: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }));
        rowBgG.appendChild(el('line', { x1: 0, y1: ry + ROW, x2: totalW, y2: ry + ROW, stroke: '#e2e8f0', 'stroke-width': 0.5 }));
        ry += ROW;
      }
    });
    svg.appendChild(rowBgG);

    // ── Barres ───────────────────────────────────────────────
    const barsG = el('g', { 'clip-path': 'url(#gc)' });
    let by = AX;

    rows.forEach(row => {
      if (row.type === 's') { by += SEC; return; }

      const task = row.data;
      const r    = resolved[task.id];
      if (!r?.s || !r?.e) { by += ROW; return; }

      const filtered  = !!(filterPerson && task.person !== filterPerson);
      const bx        = xOf(r.s);
      const bw        = Math.max(5, xOf(r.e) - bx);
      const bTop      = by + BPD;
      const pColor    = personColor(task.person, persons);
      const barG      = el('g', { opacity: filtered ? 0.12 : 1 });

      // Barre de base
      barG.appendChild(el('rect', { x: bx, y: bTop, width: bw, height: BH, rx: 4, fill: pColor }));

      // ── Encodage visuel du statut ────────────────────────
      if (task.status === 'done') {
        // Hachuré semi-transparent
        barG.appendChild(el('rect', { x: bx, y: bTop, width: bw, height: BH, rx: 4, fill: 'url(#gh)' }));
        // Assombrir légèrement
        barG.appendChild(el('rect', { x: bx, y: bTop, width: bw, height: BH, rx: 4, fill: 'rgba(0,0,0,0.2)' }));

      } else if (task.status === 'crit') {
        // Teinture rouge + bordure + pastille gauche
        barG.appendChild(el('rect', { x: bx, y: bTop, width: bw, height: BH, rx: 4, fill: 'rgba(239,68,68,0.22)' }));
        barG.appendChild(el('rect', { x: bx, y: bTop, width: 4, height: BH, rx: 2, fill: '#ef4444' }));
        barG.appendChild(el('rect', { x: bx, y: bTop, width: bw, height: BH, rx: 4, fill: 'none', stroke: '#ef4444', 'stroke-width': 1.5 }));

      } else if (task.status !== 'active') {
        // Statut personnalisé : bordure colorée
        const cs = (customStatuses || []).find(s => s.id === task.status);
        if (cs) {
          barG.appendChild(el('rect', { x: bx, y: bTop, width: bw, height: BH, rx: 4, fill: 'none', stroke: cs.color, 'stroke-width': 2.5 }));
        }
      }

      // Label sur la barre (si assez large)
      if (bw > 48) {
        const label     = trunc(task.name, bw - 14);
        const textColor = lum(pColor) > 0.52 ? '#1e293b' : '#ffffff';
        barG.appendChild(txt(label, {
          x: bx + 8, y: bTop + BH / 2 + 4,
          fill: textColor, 'font-size': 11, 'font-weight': 600,
        }));
      }

      // Icône ✓ après la barre pour "done"
      if (task.status === 'done') {
        barG.appendChild(txt('✓', {
          x: bx + bw + 5, y: bTop + BH / 2 + 4,
          fill: pColor, 'font-size': 13, 'font-weight': 700,
        }));
      }

      barsG.appendChild(barG);
      by += ROW;
    });

    svg.appendChild(barsG);

    // ── Labels (colonne gauche) ──────────────────────────────
    const lblG = el('g', { 'clip-path': 'url(#gl)' });
    let ly = AX;

    rows.forEach(row => {
      if (row.type === 's') {
        lblG.appendChild(txt(row.data.name.toUpperCase(), {
          x: 10, y: ly + SEC / 2 + 4,
          fill: '#e2e8f0', 'font-size': 10, 'font-weight': 700, 'letter-spacing': 1,
        }));
        ly += SEC;
      } else {
        const task     = row.data;
        const filtered = !!(filterPerson && task.person !== filterPerson);
        const pColor   = personColor(task.person, persons);
        const hasP     = !!task.person;

        lblG.appendChild(txt(trunc(task.name, LW - 18, 12), {
          x: 10,
          y: ly + (hasP ? ROW / 2 : ROW / 2 + 5),
          fill: filtered ? '#cbd5e1' : '#334155',
          'font-size': 12,
        }));

        if (hasP) {
          lblG.appendChild(txt(trunc(task.person, LW - 18, 9), {
            x: 10, y: ly + ROW / 2 + 13,
            fill: filtered ? '#e2e8f0' : pColor,
            'font-size': 9, 'font-weight': 700,
          }));
        }
        ly += ROW;
      }
    });

    svg.appendChild(lblG);

    // ── En-tête axe temporel ─────────────────────────────────
    const axG = el('g');
    axG.appendChild(el('rect', { x: 0, y: 0, width: totalW, height: AX, fill: '#0f172a' }));
    axG.appendChild(el('rect', { x: 0, y: 0, width: LW, height: AX, fill: '#020617' }));

    // Titre du projet dans l'angle
    axG.appendChild(txt(title || 'Gantt', {
      x: LW / 2, y: AX / 2 + 5,
      fill: '#94a3b8', 'font-size': 12, 'font-weight': 800, 'text-anchor': 'middle',
    }));

    // Labels des ticks
    const axTickG = el('g', { 'clip-path': 'url(#gc)' });
    ticks.forEach(d => {
      const x = Math.round(xOf(d));
      axTickG.appendChild(el('line', { x1: x, y1: AX - 5, x2: x, y2: AX, stroke: '#334155', 'stroke-width': 1 }));
      axTickG.appendChild(txt(tickLabel(d, gran), {
        x: x + 4, y: AX - 18,
        fill: '#94a3b8', 'font-size': 10,
      }));
      // Mois en sous-label pour les semaines
      if (gran === 'week' && d.getDate() <= 7) {
        axTickG.appendChild(txt(d.toLocaleDateString('fr-FR', { month: 'short' }), {
          x: x + 4, y: AX - 6,
          fill: '#64748b', 'font-size': 9,
        }));
      }
    });
    axG.appendChild(axTickG);
    svg.appendChild(axG);

    // ── Ligne "Aujourd'hui" ──────────────────────────────────
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (today >= minD && today <= maxD) {
      const tx = xOf(today);
      const tg = el('g', { 'clip-path': 'url(#gc)' });
      tg.appendChild(el('line', {
        x1: tx, y1: AX, x2: tx, y2: totalH,
        stroke: '#f43f5e', 'stroke-width': 2, 'stroke-dasharray': '4,3',
      }));
      tg.appendChild(el('circle', { cx: tx, cy: AX + 1, r: 4, fill: '#f43f5e' }));
      tg.appendChild(txt("Aujourd'hui", {
        x: tx + 6, y: AX + 14,
        fill: '#f43f5e', 'font-size': 9.5, 'font-weight': 700,
      }));
      svg.appendChild(tg);
    }

    // ── Séparateur labels / graphique ────────────────────────
    svg.appendChild(el('line', { x1: LW, y1: 0, x2: LW, y2: totalH, stroke: '#cbd5e1', 'stroke-width': 1 }));

    container.innerHTML = '';
    container.appendChild(svg);
  }

  return { render, PALETTE, personColor };

})();

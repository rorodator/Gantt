// app.js — Logique applicative du Gantt
'use strict';

(function () {

  // ─── État ──────────────────────────────────────────────────
  let state = {
    title:         'Mon Projet',
    sections:      [],
    tasks:         [],
    customStatuses: [],
  };
  let nextId       = 1;
  let filterPerson = null;
  let editingId    = null;
  let dragId       = null;   // id de la tâche en cours de drag
  let dragTarget   = null;   // { pos, sid } destination provisoire

  // ─── Persistance localStorage ──────────────────────────────

  function save() {
    try { localStorage.setItem('gantt_v1', JSON.stringify({ state, nextId })); } catch (_) {}
  }

  function load() {
    try {
      const raw = localStorage.getItem('gantt_v1');
      if (raw) {
        const p = JSON.parse(raw);
        if (p.state)   state  = p.state;
        if (p.nextId)  nextId = p.nextId;
      }
    } catch (_) {}
    // Migration : dependsOn string → array
    state.tasks.forEach(t => {
      if (typeof t.dependsOn === 'string') {
        t.dependsOn = t.dependsOn ? [t.dependsOn] : [];
      } else if (!Array.isArray(t.dependsOn) || t.dependsOn == null) {
        t.dependsOn = [];
      }
    });
  }

  function uid(prefix) {
    return `${prefix}_${Date.now()}_${nextId++}`;
  }

  // ─── Rendu global ──────────────────────────────────────────

  function renderAll() {
    renderTaskList();
    renderLegend();
    renderGantt();
    syncFormSelects();
  }

  function renderGantt() {
    GanttRenderer.render(state, document.getElementById('gantt-container'), filterPerson);
  }

  // ─── Légende ───────────────────────────────────────────────

  function renderLegend() {
    const el      = document.getElementById('legend');
    const persons = getPersons();

    if (!persons.length && !state.tasks.length) { el.innerHTML = ''; return; }

    const statuses = [
      { id: 'active', name: 'Active',    dot: '●', color: '#64748b' },
      { id: 'done',   name: 'Terminée',  dot: '✓', color: '#64748b' },
      { id: 'crit',   name: 'Critique',  dot: '!', color: '#ef4444' },
      ...state.customStatuses.map(cs => ({ id: cs.id, name: cs.name, dot: '◆', color: cs.color })),
    ];

    let html = '<div class="legend-inner">';

    if (persons.length) {
      html += '<div class="legend-group"><span class="legend-title">Personnes&nbsp;:</span>';
      persons.forEach(p => {
        const c      = GanttRenderer.personColor(p, persons);
        const active = filterPerson === p;
        html += `<button class="lchip${active ? ' on' : ''}" data-p="${escH(p)}"
          style="--c:${c}${active ? `;background:${c}22` : ''}">
          <span class="ldot" style="background:${c}"></span>${escH(p)}</button>`;
      });
      html += '</div>';
    }

    if (statuses.length) {
      html += '<div class="legend-group"><span class="legend-title">Statuts&nbsp;:</span>';
      statuses.forEach(s => {
        html += `<span class="schip">
          <span style="color:${s.color};font-weight:700">${s.dot}</span>&nbsp;${escH(s.name)}
        </span>`;
      });
      html += '</div>';
    }

    html += '</div>';
    el.innerHTML = html;

    el.querySelectorAll('.lchip').forEach(b => {
      b.addEventListener('click', () => {
        const p = b.dataset.p;
        filterPerson = filterPerson === p ? null : p;
        renderLegend();
        renderGantt();
      });
    });
  }

  // ─── Tri topologique (dépendances d'abord) ─────────────────

  function topoSort(tasks) {
    const map  = Object.fromEntries(tasks.map(t => [t.id, t]));
    const seen = new Set();
    const out  = [];
    function visit(t) {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      (t.dependsOn || []).forEach(dep => { if (map[dep]) visit(map[dep]); });
      out.push(t);
    }
    tasks.forEach(t => visit(t));
    return out;
  }

  // ─── Helpers drag & drop ───────────────────────────────────

  function getAncestors(taskId) {
    const set = new Set();
    const map = Object.fromEntries(state.tasks.map(t => [t.id, t]));
    function walk(id) {
      const t = map[id];
      if (!t) return;
      (t.dependsOn || []).forEach(dep => {
        if (!set.has(dep)) { set.add(dep); walk(dep); }
      });
    }
    walk(taskId);
    return set;
  }

  function getDescendants(taskId) {
    const set = new Set();
    function walk(id) {
      state.tasks.filter(t => (t.dependsOn || []).includes(id)).forEach(t => {
        if (!set.has(t.id)) { set.add(t.id); walk(t.id); }
      });
    }
    walk(taskId);
    return set;
  }

  // domPos = index dans la liste complète triée (avec la tâche draggée)
  function isDropValid(draggedId, domPos) {
    const sorted       = topoSort(state.tasks);
    const draggedIndex = sorted.findIndex(t => t.id === draggedId);

    // Déposer à la position actuelle = toujours valide (pas de mouvement)
    if (domPos === draggedIndex || domPos === draggedIndex + 1) return true;

    // Calcule la position cible dans la liste sans la tâche draggée
    const insertPos     = domPos > draggedIndex ? domPos - 1 : domPos;
    const sortedWithout = sorted.filter(t => t.id !== draggedId);
    const ancestors     = getAncestors(draggedId);
    const descendants   = getDescendants(draggedId);

    // Aucun ancêtre ne doit être après la position cible
    for (let i = insertPos; i < sortedWithout.length; i++) {
      if (ancestors.has(sortedWithout[i].id)) return false;
    }
    // Aucun descendant ne doit être avant la position cible
    for (let i = 0; i < insertPos; i++) {
      if (descendants.has(sortedWithout[i].id)) return false;
    }
    return true;
  }

  // ─── Liste des tâches ──────────────────────────────────────

  function renderTaskList() {
    const container = document.getElementById('tasks-body');
    if (!state.tasks.length) {
      container.innerHTML = '<p class="empty-msg">Aucune tâche.</p>';
      return;
    }

    const sMap   = Object.fromEntries(state.sections.map(s => [s.id, s]));
    const sorted = topoSort(state.tasks);
    const bySec  = {};
    sorted.forEach(t => { const k = t.sectionId || '_'; (bySec[k] = bySec[k] || []).push(t); });
    const secOrder = [
      ...state.sections.map(s => s.id).filter(id => bySec[id]),
      ...(bySec['_'] ? ['_'] : []),
    ];

    const persons = getPersons();
    let html     = '';
    let flatIdx  = 0;  // position dans sorted (pour data-pos des zones de dépôt)

    secOrder.forEach(sid => {
      if (sid !== '_') {
        html += `<div class="task-sec-head">
          <span>${escH(sMap[sid]?.name || sid)}</span>
          <button class="bism danger" data-del-sec="${sid}" title="Supprimer la section">×</button>
        </div>`;
      }

      const tasksInSec = bySec[sid] || [];

      tasksInSec.forEach((t) => {
        const c  = GanttRenderer.personColor(t.person, persons);
        const sl = statusLabel(t.status);
        // data-sortpos = index dans sorted (utilisé par setupDragDrop)
        html += `<div class="task-item" draggable="true" data-tid="${t.id}" data-sortpos="${flatIdx}" data-sid="${sid}">
          <span class="drag-handle" title="Déplacer">⠿</span>
          <div class="ti-bar" style="background:${c}"></div>
          <div class="ti-body">
            <span class="ti-name">${escH(t.name)}</span>
            <span class="ti-meta">${t.person
              ? `<span style="color:${c};font-weight:600">${escH(t.person)}</span>&nbsp;·&nbsp;`
              : ''}${sl}&nbsp;·&nbsp;${t.duration}${t.unit}</span>
          </div>
          <div class="ti-actions">
            <button class="bism" data-edit="${t.id}" title="Modifier">✏</button>
            <button class="bism danger" data-del="${t.id}" title="Supprimer">×</button>
          </div>
        </div>`;

        flatIdx++;
      });
    });

    container.innerHTML = html;

    // Clics (inchangés)
    container.querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); deleteTask(b.dataset.del); }));
    container.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); startEdit(b.dataset.edit); }));
    container.querySelectorAll('[data-del-sec]').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); deleteSection(b.dataset.delSec); }));

    // Drag & Drop
    setupDragDrop(container);
  }

  function setupDragDrop(container) {
    // Nettoie tous les indicateurs visuels sur les items
    function clearDropIndicators() {
      container.querySelectorAll('.task-item').forEach(el => {
        el.classList.remove('drop-before', 'drop-before-ko', 'drop-after', 'drop-after-ko');
      });
    }

    // Applique le drop à la position stockée dans dragTarget
    function applyDrop() {
      if (!dragId || !dragTarget) return;
      const { pos: domPos, sid } = dragTarget;
      if (!isDropValid(dragId, domPos)) return;

      const sorted       = topoSort(state.tasks);
      const draggedIndex = sorted.findIndex(t => t.id === dragId);
      const insertPos    = domPos > draggedIndex ? domPos - 1 : domPos;
      const sortedWithout = sorted.filter(t => t.id !== dragId);
      const draggedTask   = state.tasks.find(t => t.id === dragId);
      sortedWithout.splice(insertPos, 0, draggedTask);
      draggedTask.sectionId = sid === '_' ? null : sid;
      state.tasks = sortedWithout;

      save();
      dragId     = null;
      dragTarget = null;
      renderAll();
    }

    container.querySelectorAll('.task-item[data-tid]').forEach(item => {

      // ── Source du drag ──────────────────────────────────────
      item.addEventListener('dragstart', e => {
        dragId = item.dataset.tid;
        requestAnimationFrame(() => item.classList.add('dragging'));
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragId);
      });

      item.addEventListener('dragend', () => {
        dragId     = null;
        dragTarget = null;
        item.classList.remove('dragging');
        clearDropIndicators();
      });

      // ── Cible du drop ───────────────────────────────────────
      // Pattern : moitié haute → insérer AVANT, moitié basse → insérer APRÈS
      item.addEventListener('dragover', e => {
        if (!dragId || item.dataset.tid === dragId) return;
        e.preventDefault();

        const sortPos  = parseInt(item.dataset.sortpos); // index de cet item dans sorted
        const sid      = item.dataset.sid;
        const rect     = item.getBoundingClientRect();
        const topHalf  = e.clientY < rect.top + rect.height / 2;

        // "insérer avant item" = zone domPos=sortPos
        // "insérer après item" = zone domPos=sortPos+1
        const domPos = topHalf ? sortPos : sortPos + 1;
        const valid  = isDropValid(dragId, domPos);

        e.dataTransfer.dropEffect = valid ? 'move' : 'none';
        dragTarget = valid ? { pos: domPos, sid } : null;

        clearDropIndicators();
        if (topHalf) {
          item.classList.add(valid ? 'drop-before' : 'drop-before-ko');
        } else {
          item.classList.add(valid ? 'drop-after' : 'drop-after-ko');
        }
      });

      item.addEventListener('dragleave', e => {
        // Ne pas effacer si on entre dans un élément enfant
        if (item.contains(e.relatedTarget)) return;
        clearDropIndicators();
        dragTarget = null;
      });

      item.addEventListener('drop', e => {
        e.preventDefault();
        applyDrop();
      });
    });
  }

  function getPersons() {
    const seen = new Set();
    return state.tasks
      .filter(t => t.person && !seen.has(t.person) && seen.add(t.person))
      .map(t => t.person);
  }

  function statusLabel(id) {
    const base = { active: 'Active', done: 'Terminée', crit: 'Critique' };
    if (base[id]) return base[id];
    return state.customStatuses.find(s => s.id === id)?.name || id;
  }

  function escH(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Synchronisation des selects du formulaire ─────────────

  function syncFormSelects() {
    // Section
    const fs = document.getElementById('f-section');
    const sv = fs.value;
    fs.innerHTML = '<option value="">— Aucune —</option>' +
      state.sections.map(s => `<option value="${s.id}">${escH(s.name)}</option>`).join('');
    if (sv) fs.value = sv;

    // Statut
    const fst = document.getElementById('f-status');
    const stv = fst.value;
    fst.innerHTML = `<option value="active">Active</option>
      <option value="done">Terminée</option>
      <option value="crit">Critique</option>` +
      state.customStatuses.map(cs =>
        `<option value="${cs.id}">${escH(cs.name)}</option>`).join('');
    if (stv) fst.value = stv;

    // Dépendances multi-sélection (checkboxes)
    // Quand on édite : la sélection vient de startEdit ; sinon on préserve ce qui est coché
    const wrap = document.getElementById('f-depends-wrap');
    const prevSelected = editingId
      ? new Set(Array.from(wrap.querySelectorAll('input:checked')).map(cb => cb.value))
      : new Set(); // en mode "ajout", on repart toujours de zéro après syncFormSelects
    const available = state.tasks.filter(t => t.id !== editingId);
    wrap.innerHTML = available.length
      ? available.map(t => `<label class="dep-opt">
          <input type="checkbox" value="${t.id}" ${prevSelected.has(t.id) ? 'checked' : ''}>
          <span class="dep-name">${escH(t.name)}</span>
        </label>`).join('')
      : '<span class="dep-none">Aucune tâche disponible.</span>';
    wrap.querySelectorAll('input[type=checkbox]').forEach(cb =>
      cb.addEventListener('change', updateStartField));

    // Datalist personnes
    const dl = document.getElementById('persons-list');
    dl.innerHTML = getPersons().map(p => `<option value="${escH(p)}">`).join('');

    updateStartField();
  }

  function updateStartField() {
    const hasDep = !!document.querySelector('#f-depends-wrap input:checked');
    const wrap   = document.getElementById('field-start');
    wrap.style.opacity = hasDep ? '0.4' : '1';
    const inp = document.getElementById('f-start');
    inp.disabled = hasDep;
    if (hasDep) inp.value = '';
  }

  // ─── CRUD Tâches ───────────────────────────────────────────

  function onSubmit(e) {
    e.preventDefault();

    const name        = document.getElementById('f-name').value.trim();
    const description = document.getElementById('f-desc').value.trim() || null;
    const sectionId   = document.getElementById('f-section').value || null;
    const person      = document.getElementById('f-person').value.trim() || null;
    const status      = document.getElementById('f-status').value;
    const dependsOn   = Array.from(document.querySelectorAll('#f-depends-wrap input:checked')).map(cb => cb.value);
    const startDate   = document.getElementById('f-start').value || null;
    const duration    = parseFloat(document.getElementById('f-duration').value) || 1;
    const unit        = document.getElementById('f-unit').value;

    if (!name) {
      document.getElementById('f-name').focus();
      return;
    }
    if (!dependsOn.length && !startDate) {
      alert('Veuillez indiquer une date de début ou sélectionner une dépendance.');
      return;
    }

    const task = {
      id:          editingId || uid('t'),
      name,
      description,
      sectionId,
      person,
      status,
      dependsOn,
      startDate:   dependsOn.length ? null : startDate,
      duration,
      unit,
    };

    if (editingId) {
      const i = state.tasks.findIndex(t => t.id === editingId);
      if (i >= 0) state.tasks[i] = task;
      endEdit();
    } else {
      state.tasks.push(task);
      e.target.reset();
      document.getElementById('f-desc').value     = '';
      document.getElementById('f-duration').value = 5;
      // Reset explicite des checkboxes dynamiques
      document.querySelectorAll('#f-depends-wrap input[type=checkbox]').forEach(cb => { cb.checked = false; });
    }

    save();
    renderAll();
  }

  function deleteTask(id) {
    if (!confirm('Supprimer cette tâche ?')) return;
    state.tasks = state.tasks.filter(t => t.id !== id);
    // Libérer les dépendances orphelines
    state.tasks.forEach(t => { t.dependsOn = (t.dependsOn || []).filter(d => d !== id); });
    save();
    renderAll();
  }

  function startEdit(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    editingId = id;

    document.getElementById('f-name').value     = t.name;
    document.getElementById('f-desc').value     = t.description || '';
    document.getElementById('f-section').value  = t.sectionId || '';
    document.getElementById('f-person').value   = t.person || '';
    document.getElementById('f-status').value   = t.status;
    document.getElementById('f-start').value    = t.startDate || '';
    document.getElementById('f-duration').value = t.duration;
    document.getElementById('f-unit').value     = t.unit;

    document.getElementById('btn-submit').textContent = 'Enregistrer';
    document.getElementById('btn-cancel').style.display = '';
    syncFormSelects();
    // Cocher les dépendances de la tâche (après syncFormSelects qui recrée les checkboxes)
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    document.querySelectorAll('#f-depends-wrap input[type=checkbox]').forEach(cb => {
      cb.checked = deps.includes(cb.value);
    });

    // Ouvrir le panneau formulaire si replié
    const formBody = document.getElementById('form-body');
    if (formBody.classList.contains('collapsed')) {
      formBody.classList.remove('collapsed');
      document.querySelector('[data-toggle="form-body"]').classList.add('open');
    }
    document.getElementById('panel-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('f-name').focus();
  }

  function endEdit() {
    editingId = null;
    document.getElementById('task-form').reset();
    document.getElementById('f-desc').value     = '';
    document.getElementById('f-duration').value = 5;
    document.getElementById('btn-submit').textContent = 'Ajouter';
    document.getElementById('btn-cancel').style.display = 'none';
    document.querySelectorAll('#f-depends-wrap input[type=checkbox]').forEach(cb => { cb.checked = false; });
    syncFormSelects();
  }

  // ─── CRUD Sections ─────────────────────────────────────────

  function openSecModal() {
    document.getElementById('modal-sec').classList.remove('hidden');
    document.getElementById('sec-name').value = '';
    setTimeout(() => document.getElementById('sec-name').focus(), 50);
  }
  function closeSecModal() { document.getElementById('modal-sec').classList.add('hidden'); }

  function addSection() {
    const name = document.getElementById('sec-name').value.trim();
    if (!name) return;
    state.sections.push({ id: uid('s'), name });
    save();
    closeSecModal();
    syncFormSelects();
    renderTaskList();
  }

  function deleteSection(id) {
    if (!confirm('Supprimer cette section ? Les tâches ne seront pas supprimées.')) return;
    state.sections = state.sections.filter(s => s.id !== id);
    state.tasks.forEach(t => { if (t.sectionId === id) t.sectionId = null; });
    save();
    renderAll();
  }

  // ─── Statuts personnalisés ─────────────────────────────────

  function openStatusModal() {
    document.getElementById('modal-status').classList.remove('hidden');
    renderCsList();
  }
  function closeStatusModal() { document.getElementById('modal-status').classList.add('hidden'); }

  function renderCsList() {
    const el = document.getElementById('cs-list');
    if (!state.customStatuses.length) {
      el.innerHTML = '<p class="empty-msg">Aucun statut personnalisé.</p>';
      return;
    }
    el.innerHTML = state.customStatuses.map(cs => `
      <div class="cs-row">
        <span class="cs-dot" style="background:${cs.color}"></span>
        <span class="cs-name">${escH(cs.name)}</span>
        <button class="bism danger" data-del-cs="${cs.id}">×</button>
      </div>`).join('');

    el.querySelectorAll('[data-del-cs]').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.dataset.delCs;
        state.customStatuses = state.customStatuses.filter(s => s.id !== id);
        state.tasks.forEach(t => { if (t.status === id) t.status = 'active'; });
        save();
        renderCsList();
        syncFormSelects();
        renderGantt();
        renderLegend();
      });
    });
  }

  function addCustomStatus() {
    const name  = document.getElementById('cs-name').value.trim();
    const color = document.getElementById('cs-color').value;
    if (!name) return;
    state.customStatuses.push({ id: uid('cs'), name, color });
    save();
    document.getElementById('cs-name').value = '';
    renderCsList();
    syncFormSelects();
    renderLegend();
  }

  // ─── Export ────────────────────────────────────────────────

  function getSvg() {
    const svg = document.querySelector('#gantt-container svg');
    if (!svg) { alert('Aucun diagramme à exporter.'); return null; }
    return svg;
  }

  function exportPng() {
    const svg = getSvg(); if (!svg) return;
    const w = +svg.getAttribute('width');
    const h = +svg.getAttribute('height');

    const canvas = document.createElement('canvas');
    const scale  = 2; // retina
    canvas.width  = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // Encode en base64 pour éviter les restrictions CORS sur les Blob URL
    const raw     = new XMLSerializer().serializeToString(svg);
    const b64     = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(raw)));
    const img     = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        const a   = document.createElement('a');
        a.href    = URL.createObjectURL(blob);
        a.download = `${state.title || 'gantt'}.png`;
        a.click();
        URL.revokeObjectURL(a.href);
      }, 'image/png');
    };
    img.onerror = () => alert('Impossible de générer le PNG. Essayez l\'export SVG.');
    img.src = b64;
  }

  function exportSvg() {
    const svg = getSvg(); if (!svg) return;
    const raw  = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([raw], { type: 'image/svg+xml;charset=utf-8' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `${state.title || 'gantt'}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportJson() {
    const blob = new Blob(
      [JSON.stringify({ state, nextId }, null, 2)],
      { type: 'application/json' }
    );
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `${state.title || 'gantt'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function newProject() {
    const input = document.getElementById('new-proj-name');
    input.value = 'Mon Projet';
    document.getElementById('modal-new').classList.remove('hidden');
    setTimeout(() => { input.select(); input.focus(); }, 50);
  }

  function confirmNewProject() {
    const name = document.getElementById('new-proj-name').value.trim() || 'Mon Projet';
    document.getElementById('modal-new').classList.add('hidden');
    state        = { title: name, sections: [], tasks: [], customStatuses: [] };
    nextId       = 1;
    filterPerson = null;
    editingId    = null;
    save();
    document.getElementById('proj-title').textContent = name;
    endEdit();
    renderAll();
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const p = JSON.parse(e.target.result);
        if (!p.state || !Array.isArray(p.state.tasks)) throw new Error();
        state  = p.state;
        nextId = p.nextId || nextId;
        save();
        document.getElementById('proj-title').textContent = state.title || 'Mon Projet';
        renderAll();
      } catch {
        alert('Fichier JSON invalide ou incompatible.');
      }
    };
    reader.readAsText(file);
  }

  // ─── Données démo au premier lancement ─────────────────────

  function seedDemo() {
    const td = n => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return d.toISOString().slice(0, 10);
    };
    state.sections = [
      { id: 'sd_a', name: 'Conception' },
      { id: 'sd_b', name: 'Développement' },
      { id: 'sd_c', name: 'Livraison' },
    ];
    state.tasks = [
      { id: 'td1', name: 'Specs fonctionnelles',    sectionId: 'sd_a', person: 'Alice', status: 'done',   dependsOn: [],           startDate: td(-14), duration: 5,  unit: 'd', description: 'Rédaction du cahier des charges fonctionnel.' },
      { id: 'td2', name: 'Maquettes UI',             sectionId: 'sd_a', person: 'Bob',   status: 'done',   dependsOn: ['td1'],      startDate: null,    duration: 7,  unit: 'd', description: null },
      { id: 'td3', name: 'Setup infrastructure',     sectionId: 'sd_b', person: 'Alice', status: 'active', dependsOn: ['td1'],      startDate: null,    duration: 5,  unit: 'd', description: null },
      { id: 'td4', name: 'Développement frontend',   sectionId: 'sd_b', person: 'Bob',   status: 'active', dependsOn: ['td2'],      startDate: null,    duration: 14, unit: 'd', description: null },
      { id: 'td5', name: 'API & base de données',    sectionId: 'sd_b', person: 'Alice', status: 'crit',   dependsOn: ['td3'],      startDate: null,    duration: 10, unit: 'd', description: 'Développement des endpoints REST et schéma BDD.' },
      { id: 'td6', name: 'Tests & intégration',      sectionId: 'sd_c', person: 'Bob',   status: 'active', dependsOn: ['td4','td5'],startDate: null,    duration: 5,  unit: 'd', description: 'td6 dépend à la fois de frontend et de l\'API.' },
      { id: 'td7', name: 'Déploiement',              sectionId: 'sd_c', person: 'Alice', status: 'active', dependsOn: ['td6'],      startDate: null,    duration: 2,  unit: 'd', description: null },
    ];
    nextId = 20;
  }

  // ─── Tooltip Gantt ─────────────────────────────────────────

  function setupTooltip() {
    const tip  = document.getElementById('gantt-tooltip');
    const cont = document.getElementById('gantt-container');
    let current = null;

    cont.addEventListener('mouseover', e => {
      const bar = e.target.closest('.g-bar');
      if (!bar) {
        if (current) { tip.classList.add('hidden'); current = null; }
        return;
      }
      if (bar === current) return;
      current = bar;

      const name   = bar.dataset.name   || '';
      const start  = bar.dataset.start  || '';
      const end    = bar.dataset.end    || '';
      const person = bar.dataset.person || '';
      const desc   = bar.dataset.desc   || '';

      let html = `<div class="g-tip-name">${escH(name)}</div>`;
      html    += `<div class="g-tip-dates">📅 ${escH(start)} → ${escH(end)}</div>`;
      if (person) html += `<div class="g-tip-person">👤 ${escH(person)}</div>`;
      if (desc)   html += `<div class="g-tip-desc">${escH(desc)}</div>`;

      tip.innerHTML = html;
      tip.classList.remove('hidden');
    });

    cont.addEventListener('mousemove', e => {
      if (tip.classList.contains('hidden')) return;
      const margin = 14;
      let x = e.clientX + margin;
      let y = e.clientY + margin;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      if (x + tw > window.innerWidth  - 4) x = e.clientX - tw - margin;
      if (y + th > window.innerHeight - 4) y = e.clientY - th - margin;
      tip.style.left = x + 'px';
      tip.style.top  = y + 'px';
    });

    cont.addEventListener('mouseleave', () => {
      tip.classList.add('hidden');
      current = null;
    });
  }

  // ─── Init ──────────────────────────────────────────────────

  function init() {
    load();

    // Données démo si premier lancement
    if (!state.tasks.length) seedDemo();

    // Titre éditable
    const titleEl = document.getElementById('proj-title');
    titleEl.textContent = state.title || 'Mon Projet';
    titleEl.addEventListener('input', () => {
      state.title = titleEl.textContent.trim() || 'Mon Projet';
      save();
      // Re-render le SVG pour mettre à jour le titre dans l'axe
      renderGantt();
    });
    titleEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    });

    // Formulaire
    document.getElementById('task-form').addEventListener('submit', onSubmit);
    document.getElementById('btn-cancel').addEventListener('click', endEdit);

    // Section
    document.getElementById('btn-add-sec').addEventListener('click', openSecModal);
    document.getElementById('modal-sec-ok').addEventListener('click', addSection);
    document.getElementById('modal-sec-cancel').addEventListener('click', closeSecModal);
    document.getElementById('sec-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addSection(); }
    });

    // Statuts perso
    document.getElementById('btn-manage-status').addEventListener('click', openStatusModal);
    document.getElementById('modal-status-close').addEventListener('click', closeStatusModal);
    document.getElementById('btn-add-cs').addEventListener('click', addCustomStatus);
    document.getElementById('cs-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addCustomStatus(); }
    });

    // Exports
    document.getElementById('btn-png').addEventListener('click', exportPng);
    document.getElementById('btn-svg').addEventListener('click', exportSvg);
    document.getElementById('btn-json').addEventListener('click', exportJson);

    // Nouveau projet
    document.getElementById('btn-new').addEventListener('click', newProject);
    document.getElementById('modal-new-ok').addEventListener('click', confirmNewProject);
    document.getElementById('modal-new-cancel').addEventListener('click', () =>
      document.getElementById('modal-new').classList.add('hidden'));
    document.getElementById('new-proj-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); confirmNewProject(); }
    });

    // Import
    document.getElementById('btn-import').addEventListener('click', () =>
      document.getElementById('f-import').click());
    document.getElementById('f-import').addEventListener('change', e => {
      if (e.target.files[0]) { importJson(e.target.files[0]); e.target.value = ''; }
    });

    // Fermeture modale au clic sur le fond
    document.querySelectorAll('.modal').forEach(m =>
      m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));

    // Touche Escape = fermer les modales
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
      }
    });

    // Panel toggles (accordéons)
    document.querySelectorAll('[data-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = document.getElementById(btn.dataset.toggle);
        if (target) {
          target.classList.toggle('collapsed');
          btn.classList.toggle('open');
        }
      });
    });

    // Tooltip
    setupTooltip();

    // Re-rendu au redimensionnement
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderGantt, 150);
    });

    renderAll();
  }

  document.addEventListener('DOMContentLoaded', init);

})();

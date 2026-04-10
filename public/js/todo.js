'use strict';

// ==========================================================================
// OnlineProjectPlanner – Todo Module
// Kanban-style board: Todo / In Progress / Done
// Cards can be linked to Gantt entries and assigned to team members.
//
// Mechanisms for better overview:
//   1. Sub-tasks – drag a card ON TOP of another card to nest it; sub-tasks
//      appear indented with a coloured left border; parents collapse/expand.
//   2. Priority & Sorting – High/Medium/Low priority badges; sort the board
//      by Default (dependency order), Priority, Due Date, or A–Z.
//   3. Labels/Categories – free-text coloured labels; click a label chip in
//      the toolbar to filter; tasks with the same label are visually grouped.
// ==========================================================================

(function () {

  const S  = () => window.appState;
  const API = (m, u, b) => window.appAPI(m, u, b);
  const U  = () => window.appUtils;

  let currentFilter      = 'all';
  let currentSort        = 'default'; // 'default'|'priority'|'due_date'|'title'
  let currentLabelFilter = '';        // '' = show all labels
  let todoDepsVisible    = false;
  let _dragDropReady     = false;
  let collapsedParents   = new Set(); // ids of collapsed parent tasks

  // Track the card id that is the current sub-task drop target (during drag)
  let _subTaskDropTarget = null;

  const PRIORITY_ORDER = { high: 0, medium: 1, low: 2, '': 3 };

  window.todoModule = {
    render,
    setFilter,
    setSort,
    showAddModal,
    setDepsVisible,
  };

  // =========================================================================
  // Render
  // =========================================================================

  function render() {
    const todos = filteredTodos();

    const byStatus = {
      todo:        sortTodos(todos.filter(t => t.status === 'todo')),
      in_progress: sortTodos(todos.filter(t => t.status === 'in_progress')),
      done:        sortTodos(todos.filter(t => t.status === 'done')),
    };

    renderColumn('todoListTodo',        byStatus.todo);
    renderColumn('todoListInProgress',  byStatus.in_progress);
    renderColumn('todoListDone',        byStatus.done);

    renderLabelFilters();
    setupDragDrop();
  }

  function filteredTodos() {
    let todos = S().todos || [];
    if (currentFilter !== 'all') {
      todos = todos.filter(t => t.status === currentFilter);
    }
    if (currentLabelFilter) {
      // Include matching tasks plus any parents needed to show them
      const allTodos   = S().todos || [];
      const matchIds   = new Set(todos.filter(t => t.label === currentLabelFilter).map(t => t.id));
      // Include parents of matching tasks so hierarchy renders correctly
      matchIds.forEach(id => {
        const t = allTodos.find(x => x.id === id);
        if (t && t.parent_id) matchIds.add(t.parent_id);
      });
      todos = todos.filter(t => matchIds.has(t.id));
    }
    return todos;
  }

  function setFilter(filter) {
    currentFilter = filter;
    render();
  }

  function setSort(sort) {
    currentSort = sort;
    render();
  }

  function setDepsVisible(visible) {
    todoDepsVisible = visible;
    render();
  }

  // =========================================================================
  // Sorting
  // =========================================================================

  function sortTodos(todos) {
    if (currentSort === 'default') return sortByDependencies(todos);

    const sorted = [...todos];
    if (currentSort === 'priority') {
      sorted.sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority || ''] ?? 3;
        const pb = PRIORITY_ORDER[b.priority || ''] ?? 3;
        if (pa !== pb) return pa - pb;
        return cmpDueDate(a, b); // secondary: due date
      });
    } else if (currentSort === 'due_date') {
      sorted.sort(cmpDueDate);
    } else if (currentSort === 'title') {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    }
    return sorted;
  }

  function cmpDueDate(a, b) {
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return 0;
  }

  /**
   * Sort todos so that "blocking" tasks appear before the tasks they block.
   * Uses Kahn's topological sort on the Gantt dependency graph.
   */
  function sortByDependencies(todos) {
    if (!todos.length) return todos;

    const deps = S().dependencies || [];
    if (!deps.length) return todos;

    const ganttToTodo = {};
    const todoMap     = {};
    todos.forEach(t => {
      todoMap[t.id] = t;
      if (t.gantt_entry_id) ganttToTodo[t.gantt_entry_id] = t;
    });

    const graph    = {};
    const inDegree = {};
    todos.forEach(t => { graph[t.id] = []; inDegree[t.id] = 0; });

    deps.forEach(dep => {
      const src = ganttToTodo[dep.source_id];
      const tgt = ganttToTodo[dep.target_id];
      if (src && tgt && graph[src.id] && graph[tgt.id] !== undefined) {
        graph[src.id].push(tgt.id);
        inDegree[tgt.id]++;
      }
    });

    const queue  = [];
    todos.forEach(t => { if (inDegree[t.id] === 0) queue.push(t.id); });

    const sorted = [];
    while (queue.length) {
      const id = queue.shift();
      sorted.push(todoMap[id]);
      (graph[id] || []).forEach(tid => {
        inDegree[tid]--;
        if (inDegree[tid] === 0) queue.push(tid);
      });
    }

    const inSorted = new Set(sorted.map(t => t.id));
    todos.forEach(t => { if (!inSorted.has(t.id)) sorted.push(t); });

    return sorted;
  }

  // =========================================================================
  // Label filter chips (Mechanism 3)
  // =========================================================================

  function renderLabelFilters() {
    const container = document.getElementById('todoLabelFilters');
    if (!container) return;

    const todos  = S().todos || [];
    const labels = [...new Set(todos.map(t => t.label).filter(Boolean))].sort();

    if (!labels.length) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = labels.map(label => {
      const color  = labelColor(label);
      const active = currentLabelFilter === label;
      return `<button class="todo-label-chip${active ? ' active' : ''}"
        data-label="${U().escHtml(label)}"
        style="--label-color:${color}"
        title="Filter by label: ${U().escHtml(label)}">${U().escHtml(label)}</button>`;
    }).join('');

    container.querySelectorAll('.todo-label-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        currentLabelFilter = (currentLabelFilter === btn.dataset.label) ? '' : btn.dataset.label;
        render();
      });
    });
  }

  /** Deterministic hue from a label string */
  function labelColor(label) {
    let hash = 0;
    for (let i = 0; i < label.length; i++) hash = ((hash << 5) - hash) + label.charCodeAt(i);
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 60%, 45%)`;
  }

  // =========================================================================
  // Column rendering
  // =========================================================================

  function renderColumn(listId, todos) {
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = '';

    // Build child map
    const allIdsInCol = new Set(todos.map(t => t.id));
    const childMap    = {};
    todos.forEach(t => {
      if (t.parent_id && allIdsInCol.has(t.parent_id)) {
        if (!childMap[t.parent_id]) childMap[t.parent_id] = [];
        childMap[t.parent_id].push(t);
      }
    });

    // Root tasks: those with no parent, or whose parent is not in this column
    const roots = todos.filter(t => !t.parent_id || !allIdsInCol.has(t.parent_id));

    function appendWithChildren(todo, depth) {
      list.appendChild(createCardElement(todo, depth, childMap));
      if (!collapsedParents.has(todo.id)) {
        const children = childMap[todo.id] || [];
        children.forEach(child => appendWithChildren(child, depth + 1));
      }
    }

    roots.forEach(root => appendWithChildren(root, 0));
  }

  // =========================================================================
  // Card element (Mechanisms 1, 2, 3)
  // =========================================================================

  function createCardElement(todo, depth, childMap) {
    const children    = childMap[todo.id] || [];
    const isParent    = children.length > 0;
    const isCollapsed = collapsedParents.has(todo.id);
    const isSubTask   = depth > 0;

    const card = document.createElement('div');
    let cls = 'todo-card';
    if (todo.status === 'done') cls += ' done';
    if (isSubTask)  cls += ' todo-card-subtask';
    card.className = cls;
    card.dataset.id = todo.id;
    if (depth > 0) card.style.marginLeft = (depth * 22) + 'px';

    // Linked Gantt entry indicator
    let ganttLabel = '';
    if (todo.gantt_entry_id) {
      const entry = S().ganttEntries.find(e => e.id === todo.gantt_entry_id);
      if (entry) {
        ganttLabel = `<span class="todo-card-gantt" title="Linked to Gantt entry">📅 ${U().escHtml(entry.title)}</span>`;
      }
    }

    // Dependency badges
    let depsHtml = '';
    if (todoDepsVisible && todo.gantt_entry_id) {
      const deps = S().dependencies || [];
      deps.filter(d => d.target_id === todo.gantt_entry_id).forEach(d => {
        const srcEntry = S().ganttEntries.find(e => e.id === d.source_id);
        if (srcEntry) {
          depsHtml += `<span class="todo-card-dep todo-card-dep-in" title="Depends on: ${U().escHtml(srcEntry.title)}">⬆ ${U().escHtml(srcEntry.title)}</span>`;
        }
      });
      deps.filter(d => d.source_id === todo.gantt_entry_id).forEach(d => {
        const tgtEntry = S().ganttEntries.find(e => e.id === d.target_id);
        if (tgtEntry) {
          depsHtml += `<span class="todo-card-dep todo-card-dep-out" title="Blocks: ${U().escHtml(tgtEntry.title)}">⬇ ${U().escHtml(tgtEntry.title)}</span>`;
        }
      });
    }

    // Due date
    let dueLabel = '';
    if (todo.due_date) {
      const due   = new Date(todo.due_date + 'T00:00:00');
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const overdue = due < today && todo.status !== 'done';
      dueLabel = `<span class="todo-card-due${overdue ? ' overdue' : ''}" title="Due date">
        ${overdue ? '⚠' : '🗓'} ${U().formatDate(todo.due_date)}
      </span>`;
    }

    // Assignee avatar
    let assigneeHtml = '';
    if (todo.assignee_id) {
      const member = getMember(todo.assignee_id);
      if (member) {
        assigneeHtml = `<span class="todo-card-assignee"
          style="background:${member.base_color}"
          title="${U().escHtml(member.username)}">${member.username[0].toUpperCase()}</span>`;
      }
    }

    // Priority badge (Mechanism 2)
    let priorityHtml = '';
    if (todo.priority) {
      const pMap = { high: { label: '▲ High', cls: 'prio-high' }, medium: { label: '● Medium', cls: 'prio-medium' }, low: { label: '▼ Low', cls: 'prio-low' } };
      const p = pMap[todo.priority];
      if (p) priorityHtml = `<span class="todo-card-priority ${p.cls}" title="Priority: ${p.label}">${p.label}</span>`;
    }

    // Label badge (Mechanism 3)
    let labelHtml = '';
    if (todo.label) {
      const color = labelColor(todo.label);
      labelHtml = `<span class="todo-card-label" style="background:${color}" title="Label: ${U().escHtml(todo.label)}">${U().escHtml(todo.label)}</span>`;
    }

    // Collapse/expand button for parent tasks (Mechanism 1)
    let collapseBtn = '';
    if (isParent) {
      collapseBtn = `<button class="todo-card-collapse" title="${isCollapsed ? 'Expand sub-tasks' : 'Collapse sub-tasks'}" data-id="${todo.id}">
        ${isCollapsed ? `▶ ${children.length}` : `▼`}
      </button>`;
    }

    // Done checkmark
    const doneCheck = todo.status === 'done'
      ? '<span class="todo-card-done-check" title="Task completed">✅</span>' : '';

    card.innerHTML = `
      ${doneCheck}
      <div class="todo-card-header-row">
        <div class="todo-card-title">${U().escHtml(todo.title)}</div>
        ${collapseBtn}
      </div>
      ${todo.description ? `<div class="todo-card-desc">${U().escHtml(todo.description)}</div>` : ''}
      ${depsHtml ? `<div class="todo-card-deps">${depsHtml}</div>` : ''}
      <div class="todo-card-meta">
        <span class="todo-card-tag">${statusLabel(todo.status)}</span>
        ${priorityHtml}
        ${labelHtml}
        ${dueLabel}
        ${ganttLabel}
        ${assigneeHtml}
      </div>
    `;

    // Collapse button click
    card.querySelector('.todo-card-collapse')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (collapsedParents.has(todo.id)) {
        collapsedParents.delete(todo.id);
      } else {
        collapsedParents.add(todo.id);
      }
      render();
    });

    card.addEventListener('click', () => showEditModal(todo));
    card.draggable = true;

    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(todo.id));
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.todo-list').forEach(l => l.classList.remove('drag-over'));
      document.querySelectorAll('.todo-card.sub-task-target').forEach(c => c.classList.remove('sub-task-target'));
      _subTaskDropTarget = null;
    });

    // Sub-task drop target (Mechanism 1)
    card.addEventListener('dragenter', (e) => {
      const dragId = _activeDragId;
      if (!dragId || dragId === String(todo.id)) return;
      if (isDescendant(dragId, todo.id)) return; // prevent cycles
      e.preventDefault();
      e.stopPropagation();
      document.querySelectorAll('.todo-card.sub-task-target').forEach(c => c.classList.remove('sub-task-target'));
      card.classList.add('sub-task-target');
      _subTaskDropTarget = todo.id;
    });
    card.addEventListener('dragover', (e) => {
      const dragId = _activeDragId;
      if (!dragId || dragId === String(todo.id)) return;
      if (isDescendant(dragId, todo.id)) return;
      e.preventDefault();
      e.stopPropagation(); // prevent column drag-over highlight
      e.dataTransfer.dropEffect = 'move';
    });
    card.addEventListener('dragleave', (e) => {
      // Only clear if we're leaving this card entirely (not entering a child element)
      if (!e.relatedTarget || !card.contains(e.relatedTarget)) {
        card.classList.remove('sub-task-target');
        if (_subTaskDropTarget === todo.id) _subTaskDropTarget = null;
      }
    });
    card.addEventListener('drop', async (e) => {
      const dragId = e.dataTransfer.getData('text/plain');
      if (!dragId || dragId === String(todo.id)) return;
      if (isDescendant(dragId, todo.id)) return;
      e.preventDefault();
      e.stopPropagation(); // don't let column handle this
      card.classList.remove('sub-task-target');
      _subTaskDropTarget = null;

      const dragged = S().todos.find(t => String(t.id) === dragId);
      if (!dragged) return;

      // Move to parent's status too
      const updates = { parent_id: todo.id, status: todo.status };
      const data = await API('PUT', `/api/todos/${dragged.id}`, updates);
      const idx = S().todos.findIndex(t => t.id === dragged.id);
      if (idx !== -1) S().todos[idx] = data.todo;
      render();
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menuItems = [
        { icon: '▶', label: 'Mark In Progress', action: () => updateStatus(todo, 'in_progress') },
        { icon: '✓', label: 'Mark Done',         action: () => updateStatus(todo, 'done') },
        { icon: '↩', label: 'Mark Todo',         action: () => updateStatus(todo, 'todo') },
        { separator: true },
      ];
      if (todo.parent_id) {
        menuItems.push({ icon: '↑', label: 'Remove from sub-task', action: () => unparentTodo(todo) });
      }
      menuItems.push(
        { icon: '✏', label: 'Edit',   action: () => showEditModal(todo) },
        { icon: '🗑', label: 'Delete', action: () => deleteTodo(todo), danger: true },
      );
      U().showContextMenu(e.pageX, e.pageY, menuItems);
    });

    return card;
  }

  /** Track the id of the card currently being dragged (dragstart fires before dragenter, but getData is empty in dragenter in some browsers) */
  let _activeDragId = null;
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.todo-card');
    if (card) _activeDragId = card.dataset.id;
  }, true);
  document.addEventListener('dragend', () => { _activeDragId = null; }, true);

  /** Check if candidateParentId is a descendant of dragId (would create cycle) */
  function isDescendant(dragId, candidateParentId) {
    const todos = S().todos || [];
    let cur = todos.find(t => String(t.id) === String(candidateParentId));
    while (cur) {
      if (String(cur.id) === String(dragId)) return true;
      cur = todos.find(t => t.id === cur.parent_id);
    }
    return false;
  }

  // =========================================================================
  // Drag-and-drop between columns
  // =========================================================================

  function setupDragDrop() {
    if (_dragDropReady) return;
    _dragDropReady = true;

    document.querySelectorAll('.todo-list').forEach(list => {
      list.addEventListener('dragover', (e) => {
        if (_subTaskDropTarget) return; // card is handling it
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        list.classList.add('drag-over');
      });
      list.addEventListener('dragenter', (e) => {
        if (_subTaskDropTarget) return;
        e.preventDefault();
        list.classList.add('drag-over');
      });
      list.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget || !list.contains(e.relatedTarget)) {
          list.classList.remove('drag-over');
        }
      });
      list.addEventListener('drop', async (e) => {
        list.classList.remove('drag-over');
        if (_subTaskDropTarget) return; // card handled it
        e.preventDefault();
        const todoId   = e.dataTransfer.getData('text/plain');
        const newStatus = list.closest('.todo-column')?.dataset.status;
        if (!todoId || !newStatus) return;
        const todo = S().todos.find(t => String(t.id) === todoId);
        if (!todo) return;

        // Dropping on a column = unparent + optional status change
        const updates = {};
        if (todo.parent_id) updates.parent_id = null;
        if (todo.status !== newStatus) updates.status = newStatus;
        if (!Object.keys(updates).length) return;

        const data = await API('PUT', `/api/todos/${todo.id}`, updates);
        const idx = S().todos.findIndex(t => t.id === todo.id);
        if (idx !== -1) S().todos[idx] = data.todo;
        if (updates.status === 'done') window.soundsModule?.play('task_done');
        render();
      });
    });
  }

  // =========================================================================
  // Modals
  // =========================================================================

  function showAddModal(ganttEntryId) {
    U().openModal('Add Todo', buildTodoFormHtml({
      title: '',
      description: '',
      status: 'todo',
      assignee_id: '',
      due_date: '',
      gantt_entry_id: ganttEntryId || '',
      priority: '',
      label: '',
    }), async () => {
      const vals = readTodoForm();
      if (!vals.title) return alert('Title is required');
      const data = await API('POST', '/api/todos', {
        project_id: S().currentProject.id,
        ...vals,
      });
      S().todos.push(data.todo);
      render();
      U().closeModal();
    });
  }

  function showEditModal(todo) {
    U().openModal('Edit Todo', buildTodoFormHtml(todo), async () => {
      const vals = readTodoForm();
      if (!vals.title) return alert('Title is required');
      const data = await API('PUT', `/api/todos/${todo.id}`, vals);
      const idx = S().todos.findIndex(t => t.id === todo.id);
      if (idx !== -1) S().todos[idx] = data.todo;
      render();
      U().closeModal();
    });
  }

  function buildTodoFormHtml(todo) {
    const members = S().members[S().currentTeam?.id] || [];
    const memberOptions = members.map(m =>
      `<option value="${m.id}" ${todo.assignee_id === m.id ? 'selected' : ''}>${U().escHtml(m.username)}</option>`
    ).join('');

    const ganttEntries  = (S().ganttEntries || []).filter(e => !e.parent_id || true);
    const ganttOptions  = ganttEntries.map(e =>
      `<option value="${e.id}" ${todo.gantt_entry_id === e.id ? 'selected' : ''}>${U().escHtml(e.title)}</option>`
    ).join('');

    // All existing labels as datalist suggestions
    const allLabels = [...new Set((S().todos || []).map(t => t.label).filter(Boolean))];
    const labelDatalist = allLabels.map(l => `<option value="${U().escHtml(l)}">`).join('');

    return `
      <div class="form-group">
        <label>Title</label>
        <input type="text" id="ftTitle" value="${U().escHtml(todo.title || '')}" placeholder="What needs to be done?">
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="ftDesc" placeholder="Optional details">${U().escHtml(todo.description || '')}</textarea>
      </div>
      <div style="display:flex;gap:12px">
        <div class="form-group" style="flex:1">
          <label>Status</label>
          <select id="ftStatus">
            <option value="todo"        ${todo.status === 'todo'        ? 'selected' : ''}>To Do</option>
            <option value="in_progress" ${todo.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
            <option value="done"        ${todo.status === 'done'        ? 'selected' : ''}>Done</option>
          </select>
        </div>
        <div class="form-group" style="flex:1">
          <label>Priority</label>
          <select id="ftPriority">
            <option value=""       ${!todo.priority              ? 'selected' : ''}>— None —</option>
            <option value="high"   ${todo.priority === 'high'    ? 'selected' : ''}>▲ High</option>
            <option value="medium" ${todo.priority === 'medium'  ? 'selected' : ''}>● Medium</option>
            <option value="low"    ${todo.priority === 'low'     ? 'selected' : ''}>▼ Low</option>
          </select>
        </div>
      </div>
      <div style="display:flex;gap:12px">
        <div class="form-group" style="flex:1">
          <label>Due Date</label>
          <input type="date" id="ftDue" value="${todo.due_date || ''}">
        </div>
        <div class="form-group" style="flex:1">
          <label>Label / Category</label>
          <input type="text" id="ftLabel" value="${U().escHtml(todo.label || '')}" placeholder="e.g. Backend, UI…" list="ftLabelList">
          <datalist id="ftLabelList">${labelDatalist}</datalist>
        </div>
      </div>
      <div class="form-group">
        <label>Assignee</label>
        <select id="ftAssignee">
          <option value="">— Unassigned —</option>
          ${memberOptions}
        </select>
      </div>
      <div class="form-group">
        <label>Linked Gantt Entry</label>
        <select id="ftGantt">
          <option value="">— None —</option>
          ${ganttOptions}
        </select>
      </div>
    `;
  }

  function readTodoForm() {
    return {
      title:          document.getElementById('ftTitle')?.value.trim() || '',
      description:    document.getElementById('ftDesc')?.value.trim() || '',
      status:         document.getElementById('ftStatus')?.value || 'todo',
      priority:       document.getElementById('ftPriority')?.value || '',
      label:          document.getElementById('ftLabel')?.value.trim() || '',
      assignee_id:    document.getElementById('ftAssignee')?.value || null,
      due_date:       document.getElementById('ftDue')?.value || null,
      gantt_entry_id: document.getElementById('ftGantt')?.value || null,
    };
  }

  // =========================================================================
  // Actions
  // =========================================================================

  async function updateStatus(todo, status) {
    const data = await API('PUT', `/api/todos/${todo.id}`, { status });
    const idx = S().todos.findIndex(t => t.id === todo.id);
    if (idx !== -1) S().todos[idx] = data.todo;
    if (status === 'done') window.soundsModule?.play('task_done');
    render();
  }

  async function unparentTodo(todo) {
    const data = await API('PUT', `/api/todos/${todo.id}`, { parent_id: null });
    const idx = S().todos.findIndex(t => t.id === todo.id);
    if (idx !== -1) S().todos[idx] = data.todo;
    render();
  }

  async function deleteTodo(todo) {
    if (!confirm(`Delete "${todo.title}"?`)) return;
    await API('DELETE', `/api/todos/${todo.id}`);
    S().todos = S().todos.filter(t => t.id !== todo.id);
    render();
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  function getMember(userId) {
    const members = Object.values(S().members).flat();
    return members.find(m => m.id === userId) || null;
  }

  function statusLabel(status) {
    return { todo: 'To Do', in_progress: 'In Progress', done: 'Done' }[status] || status;
  }

})();

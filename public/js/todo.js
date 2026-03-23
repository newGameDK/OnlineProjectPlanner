'use strict';

// ==========================================================================
// OnlineProjectPlanner – Todo Module
// Kanban-style board: Todo / In Progress / Done
// Cards can be linked to Gantt entries and assigned to team members.
// ==========================================================================

(function () {

  const S  = () => window.appState;
  const API = (m, u, b) => window.appAPI(m, u, b);
  const U  = () => window.appUtils;

  let currentFilter = 'all';
  let todoDepsVisible = false;  // show dependency badges on cards
  let _dragDropReady  = false;  // column drop-zones set up once per DOM

  window.todoModule = {
    render,
    setFilter,
    showAddModal,
    setDepsVisible,
  };

  // =========================================================================
  // Render
  // =========================================================================

  function render() {
    const todos = filteredTodos();

    const byStatus = {
      todo:        sortByDependencies(todos.filter(t => t.status === 'todo')),
      in_progress: sortByDependencies(todos.filter(t => t.status === 'in_progress')),
      done:        sortByDependencies(todos.filter(t => t.status === 'done')),
    };

    renderColumn('todoListTodo',        byStatus.todo);
    renderColumn('todoListInProgress',  byStatus.in_progress);
    renderColumn('todoListDone',        byStatus.done);

    setupDragDrop();
  }

  function filteredTodos() {
    const todos = S().todos || [];
    if (currentFilter === 'all') return todos;
    return todos.filter(t => t.status === currentFilter);
  }

  function setFilter(filter) {
    currentFilter = filter;
    render();
  }

  function setDepsVisible(visible) {
    todoDepsVisible = visible;
    render();
  }

  // =========================================================================
  // Dependency-based topological sort
  // =========================================================================

  /**
   * Sort todos so that "blocking" tasks (ones that other tasks depend on)
   * appear before the tasks they block.  Uses Kahn's topological sort on
   * the Gantt dependency graph mapped through gantt_entry_id links.
   */
  function sortByDependencies(todos) {
    if (!todos.length) return todos;

    const deps = S().dependencies || [];
    if (!deps.length) return todos;

    // Map gantt_entry_id → todo for quick lookup
    const ganttToTodo = {};
    const todoMap     = {};
    todos.forEach(t => {
      todoMap[t.id] = t;
      if (t.gantt_entry_id) ganttToTodo[t.gantt_entry_id] = t;
    });

    // Build adjacency list + in-degree (source blocks target)
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

    // Kahn's algorithm
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

    // Append any remaining todos (unlinked or in cycles)
    const inSorted = new Set(sorted.map(t => t.id));
    todos.forEach(t => { if (!inSorted.has(t.id)) sorted.push(t); });

    return sorted;
  }

  // =========================================================================
  // Column rendering
  // =========================================================================

  function renderColumn(listId, todos) {
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = '';

    todos.forEach(todo => {
      list.appendChild(buildCard(todo));
    });
  }

  function buildCard(todo) {
    const card = document.createElement('div');
    card.className = 'todo-card' + (todo.status === 'done' ? ' done' : '');
    card.dataset.id = todo.id;

    // Linked Gantt entry indicator
    let ganttLabel = '';
    if (todo.gantt_entry_id) {
      const entry = S().ganttEntries.find(e => e.id === todo.gantt_entry_id);
      if (entry) {
        ganttLabel = `<span class="todo-card-gantt" title="Linked to Gantt entry">📅 ${U().escHtml(entry.title)}</span>`;
      }
    }

    // Dependency badges (shown when todoDepsVisible is true and the card has a linked Gantt entry)
    let depsHtml = '';
    if (todoDepsVisible && todo.gantt_entry_id) {
      const deps = S().dependencies || [];
      // Tasks that must finish before this one (this task depends on them)
      deps.filter(d => d.target_id === todo.gantt_entry_id).forEach(d => {
        const srcEntry = S().ganttEntries.find(e => e.id === d.source_id);
        if (srcEntry) {
          depsHtml += `<span class="todo-card-dep todo-card-dep-in" title="Depends on: ${U().escHtml(srcEntry.title)}">⬆ ${U().escHtml(srcEntry.title)}</span>`;
        }
      });
      // Tasks that are blocked by this one (they depend on this task)
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
      const due = new Date(todo.due_date + 'T00:00:00');
      const today = new Date(); today.setHours(0,0,0,0);
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

    // Done checkmark
    const doneCheck = todo.status === 'done'
      ? '<span class="todo-card-done-check" title="Task completed">\u2705</span>' : '';

    card.innerHTML = `
      ${doneCheck}
      <div class="todo-card-title">${U().escHtml(todo.title)}</div>
      ${todo.description ? `<div class="todo-card-desc">${U().escHtml(todo.description)}</div>` : ''}
      ${depsHtml ? `<div class="todo-card-deps">${depsHtml}</div>` : ''}
      <div class="todo-card-meta">
        <span class="todo-card-tag">${statusLabel(todo.status)}</span>
        ${dueLabel}
        ${ganttLabel}
        ${assigneeHtml}
      </div>
    `;

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
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      U().showContextMenu(e.pageX, e.pageY, [
        { icon: '▶', label: 'Mark In Progress', action: () => updateStatus(todo, 'in_progress') },
        { icon: '✓', label: 'Mark Done',         action: () => updateStatus(todo, 'done') },
        { icon: '↩', label: 'Mark Todo',         action: () => updateStatus(todo, 'todo') },
        { separator: true },
        { icon: '✏', label: 'Edit',             action: () => showEditModal(todo) },
        { icon: '🗑', label: 'Delete',           action: () => deleteTodo(todo), danger: true },
      ]);
    });

    return card;
  }

  // =========================================================================
  // Drag-and-drop between columns
  // =========================================================================

  function setupDragDrop() {
    if (_dragDropReady) return;
    _dragDropReady = true;

    document.querySelectorAll('.todo-list').forEach(list => {
      list.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        list.classList.add('drag-over');
      });
      list.addEventListener('dragenter', (e) => {
        e.preventDefault();
        list.classList.add('drag-over');
      });
      list.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget || !list.contains(e.relatedTarget)) {
          list.classList.remove('drag-over');
        }
      });
      list.addEventListener('drop', async (e) => {
        e.preventDefault();
        list.classList.remove('drag-over');
        const todoId  = e.dataTransfer.getData('text/plain');
        const newStatus = list.closest('.todo-column')?.dataset.status;
        if (!todoId || !newStatus) return;
        const todo = S().todos.find(t => String(t.id) === todoId);
        if (!todo || todo.status === newStatus) return;
        await updateStatus(todo, newStatus);
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

    const ganttEntries = (S().ganttEntries || []).filter(e => !e.parent_id || true);
    const ganttOptions = ganttEntries.map(e =>
      `<option value="${e.id}" ${todo.gantt_entry_id === e.id ? 'selected' : ''}>${U().escHtml(e.title)}</option>`
    ).join('');

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
          <label>Due Date</label>
          <input type="date" id="ftDue" value="${todo.due_date || ''}">
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

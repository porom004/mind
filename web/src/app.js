import { api } from './api/client.js';
import {
  buildGraphLayerOrder,
  buildNeighborhoodFocus,
  computeLabelFontSize,
  computeLabelY,
  computeNodeCircleRadius,
  computeNodeFillOpacity,
  layoutGraph,
  truncateGraphLabel,
  zoomTransformAtAnchor,
} from './features/graph/graph-math.js';
import {
  beginGraphPointerGesture,
  createGraphInteractionState,
  currentGraphPanTransform,
  endGraphPointerGesture,
  handleGraphContextMenu,
  shouldSelectGraphNodeOnClick,
  updateGraphPointerGesture,
} from './features/graph/interactions.js';
import {
  DRAG_CLOSE_GUARD_THRESHOLD_PX,
  interactionWasDrag,
  shouldCloseMemoryPanelOnClick,
} from './features/memory-panel/interactions.js';
import { buildAppUrl, parseAppRoute } from './features/routing/routing.js';

/** @typedef {{ id:string, name:string, tier:1|2|3, pinned:boolean, access_count:number, tags?:string[] }} MemorySummary */
/** @typedef {{ id:string, space_name:string, name:string, content:string, tier:1|2|3, pinned:boolean, tags?:string[] }} Memory */
/** @typedef {{ name:string, description?:string, tags?:string[], memory_count?:number, hidden?:boolean }} Space */
/** @typedef {{ logs: any[], total: number, limit: number, offset: number }} LogsResult */

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  /** @type {Space[]} */
  spaces: [],
  /** @type {Space | null} */
  currentSpace: null,
  /** @type {MemorySummary[]} */
  memories: [], // MemorySummary[]
  /** @type {Memory | null} */
  currentMemory: null, // Memory (full)
  searchActive: false,
  searchResults: [],
  showHiddenSpaces: false,
  spaceView: 'list',
  graph: null,
  graphFocusNodeId: null,
  graphTransform: { scale: 1, tx: 0, ty: 0 },
  lastAppliedScale: null, // Track last scale for label update optimization
  // Logs state
  logsActive: false,
  logs: [],
  logsTotal: 0,
  logsOffset: 0,
  logsLimit: 100,
  logsLive: true,
  logsPollingInterval: null,
  logsLastId: 0,
  logsExpandedId: null,
  logsFollow: true,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const elSpaceList = $('space-list');
const elEmptyState = $('empty-state');
const elSpaceDetail = $('space-detail');
const elSearchResults = $('search-results');
const elMemoryPanel = $('memory-panel');
const elGlobalSearch = $('global-search');
const elSpaceTitle = $('space-title');
const elSpaceDesc = $('space-desc');
const elSpaceTagsRow = $('space-tags-row');
const elSearchList = $('search-list');
const elSearchHeading = $('search-heading');
const elMemTitle = $('mem-title');
const elMemTierBadge = $('mem-tier-badge');
const elMemTagsRow = $('mem-tags-row');
const elMemContent = $('mem-content');
const elMemEditArea = $('mem-edit-area');
const elMemEditInput = $('mem-edit-input');
const elStatusSpaces = $('status-spaces');
const elStatusTiers = $('status-tiers');
const elTiers = $('tiers');
const elGraphView = $('graph-view');
const elGraphSvg = $('graph-svg');
const elGraphMeta = $('graph-meta');
const elBtnViewList = $('btn-view-list');
const elBtnViewMap = $('btn-view-map');
const elToggleHiddenSpaces = $('toggle-hidden-spaces');
// Logs DOM refs
const elLogsPage = $('logs-page');
const elLogsList = $('logs-list');
const _elLogsControls = $('logs-pagination');
const elLogsCount = $('logs-count');
const elLogSourceCli = $('log-source-cli');
const elLogSourceMcp = $('log-source-mcp');
const elLogSourceApi = $('log-source-api');
const elLogSearch = $('log-search');
const elLogOrder = $('log-order');
const elLogLive = $('log-live');
const elLogFollow = $('log-follow');
const elLogsConnectionStatus = $('logs-connection-status');
const elBtnRefreshLogs = $('btn-refresh-logs');
const elBtnClearLogs = $('btn-clear-logs');
const elBtnLoadMoreLogs = $('btn-load-more-logs');

// ── Tier helpers ──────────────────────────────────────────────────────────────
const TIER_LABEL = { 1: 'T1 — Hot', 2: 'T2 — Warm', 3: 'T3 — Cold' };
const TIER_CLASS = { 1: 't1', 2: 't2', 3: 't3' };
const TIER_LIMITS = { 1: 25, 2: 50, 3: null }; // null = unlimited
const GRAPH_SCALE_MIN = 0.45;
const GRAPH_SCALE_MAX = 4.5;
const GRAPH_LABEL_BASE = 11;
const GRAPH_LABEL_MIN = 8;
const GRAPH_LABEL_MAX = 16;

// ── SVG Icons ──────────────────────────────────────────────────────────────────
const ICON_TIER = {
  1: `<svg class="tier-icon tier-icon-1" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="#ff7b72"/></svg>`,
  2: `<svg class="tier-icon tier-icon-2" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="#e3b341"/></svg>`,
  3: `<svg class="tier-icon tier-icon-3" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="#79c0ff"/></svg>`,
};
const ICON_PIN = `<svg class="icon-pin" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="4" y="2" width="8" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 8v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const ICON_CLOSE = `<svg class="icon-close" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const ICON_HIDDEN = `<svg class="icon-hidden" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M3 3l10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const _ICON_LOGS = `<svg class="icon-logs" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5 6h6M5 8h6M5 10h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const ICON_SUCCESS = `<svg class="toast-icon toast-icon-success" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="9" cy="9" r="7" stroke="#3fb950" stroke-width="1.5"/><path d="M6 9l2 2 4-4" stroke="#3fb950" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_ERROR = `<svg class="toast-icon toast-icon-error" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="9" cy="9" r="7" stroke="#f85149" stroke-width="1.5"/><path d="M9 6v4M9 12v.5" stroke="#f85149" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const ICON_WARNING = `<svg class="toast-icon toast-icon-warning" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M9 2L16 15H2L9 2z" stroke="#d29922" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 7v4M9 13v.5" stroke="#d29922" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const _ICON_BACK = `<svg class="icon-back" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ── Status panel ──────────────────────────────────────────────────────────────

function appendStatusTierPill(tier, value) {
  const cls = TIER_CLASS[tier] ?? '';
  const icon = ICON_TIER[tier] ?? '';
  const limit = TIER_LIMITS[tier];
  const cap = typeof value === 'number' && limit != null ? `/${limit}` : '';
  const pill = document.createElement('span');
  pill.className = `status-tier-pill ${cls}`;
  pill.title = TIER_LABEL[tier] ?? `T${tier}`;
  pill.innerHTML = `${icon}<span>${value}${cap}</span>`;
  elStatusTiers.appendChild(pill);
}

function renderStatusPlaceholder() {
  elStatusSpaces.textContent = '-';
  elStatusTiers.innerHTML = '';
  for (const tier of [1, 2, 3]) {
    appendStatusTierPill(tier, '-');
  }
}

function renderStatus(status) {
  const spaces = status.total_spaces ?? 0;
  const memories = status.total_memories ?? 0;
  elStatusSpaces.textContent = `${spaces} space${spaces !== 1 ? 's' : ''}, ${memories} mem`;
  elStatusTiers.innerHTML = '';
  for (const t of status.by_tier ?? []) {
    appendStatusTierPill(t.tier, t.count);
  }
}

async function loadStatus(spaceName = state.currentSpace?.name) {
  if (!spaceName) {
    renderStatusPlaceholder();
    return;
  }

  try {
    const status = await api.get(`/api/status?space=${enc(spaceName)}`);
    renderStatus(status);
  } catch {
    renderStatusPlaceholder();
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderSpaceList() {
  elSpaceList.innerHTML = '';
  for (const sp of state.spaces) {
    const li = document.createElement('li');
    li.className =
      'space-item' +
      (state.currentSpace?.name === sp.name ? ' active' : '') +
      (sp.hidden ? ' space-hidden' : '');
    li.dataset.name = sp.name;
    li.innerHTML = `
            <span class="space-item-name">${sp.hidden ? '<span class="icon-hidden-inline" style="display:inline-flex;width:14px;height:14px;vertical-align:middle;margin-right:2px;">' + ICON_HIDDEN + '</span>' : ''}${esc(sp.name)}</span>
            <span class="space-item-count">${sp.memory_count}</span>
        `;
    li.addEventListener('click', () => {
      closeSidebarOnSpaceSelect();
      selectSpace(sp.name);
    });
    elSpaceList.appendChild(li);
  }
}

function renderSpaceDetail() {
  const sp = state.currentSpace;
  if (!sp) return;

  elSpaceTitle.textContent = sp.name;
  elSpaceDesc.textContent = sp.description || 'No description';

  // Tags
  renderTagRow(
    elSpaceTagsRow,
    sp.tags ?? [],
    async tag => {
      await api.patch(`/api/spaces/${enc(sp.name)}`, { removeTag: tag });
      await refreshSpace(sp.name);
    },
    async () => {
      const tag = prompt('Tag name:');
      if (tag) {
        await api.patch(`/api/spaces/${enc(sp.name)}`, { addTag: tag.trim().toLowerCase() });
        await refreshSpace(sp.name);
      }
    }
  );

  // Tier containers
  for (const tier of [1, 2, 3]) {
    const ul = document.querySelector(`#tiers .memory-list[data-tier="${tier}"]`);
    const mems = state.memories.filter(m => m.tier === tier);
    ul.innerHTML = '';
    if (mems.length === 0) {
      ul.innerHTML = '<li class="tier-empty">Empty</li>';
    } else {
      for (const mem of mems) {
        ul.appendChild(renderMemoryItem(mem, sp.name));
      }
    }
  }

  renderGraph();
  setSpaceView(state.spaceView, { updateUrl: false });
}

function setSpaceView(view, options = {}) {
  const { updateUrl = true } = options;
  state.spaceView = view === 'map' ? 'map' : 'list';
  const showMap = state.spaceView === 'map';

  elTiers.classList.toggle('hidden', showMap);
  elGraphView.classList.toggle('hidden', !showMap);

  elBtnViewList.classList.toggle('is-active', !showMap);
  elBtnViewMap.classList.toggle('is-active', showMap);
  elBtnViewList.setAttribute('aria-pressed', String(!showMap));
  elBtnViewMap.setAttribute('aria-pressed', String(showMap));

  // Toggle sliding indicator on view track
  const track = document.querySelector('.view-toggle-track');
  if (track) {
    if (showMap) {
      track.classList.add('toggle-map');
    } else {
      track.classList.remove('toggle-map');
    }
  }

  if (updateUrl && state.currentSpace) {
    syncUrl();
  }
}

function renderGraph() {
  const graph = state.graph;
  elGraphSvg.innerHTML = '';

  if (!graph || graph.nodes.length === 0) {
    elGraphMeta.textContent = 'No memories to map.';
    return;
  }

  const layout = layoutGraph(graph.nodes);
  const focus = buildNeighborhoodFocus(graph.nodes, state.graphFocusNodeId);
  const transformGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  transformGroup.setAttribute('id', 'graph-transform');
  const layers = new Map();

  for (const layerName of buildGraphLayerOrder()) {
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.setAttribute('data-layer', layerName);
    layers.set(layerName, layer);
    transformGroup.appendChild(layer);
  }

  const rings = [
    { tier: 1, radius: 130, color: '#ff7b72' },
    { tier: 2, radius: 230, color: '#e3b341' },
    { tier: 3, radius: 330, color: '#79c0ff' },
  ];

  for (const ring of rings) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '500');
    circle.setAttribute('cy', '500');
    circle.setAttribute('r', String(ring.radius));
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', ring.color);
    circle.setAttribute('stroke-opacity', '0.2');
    circle.setAttribute('stroke-width', '1');
    circle.classList.add('tier-ring');
    layers.get('rings').appendChild(circle);
  }

  const renderedEdges = new Set();
  for (const node of graph.nodes) {
    for (const targetId of node.links_to) {
      const key = `${node.id}->${targetId}`;
      if (renderedEdges.has(key)) continue;
      renderedEdges.add(key);
      const sourcePos = layout.get(node.id);
      const targetPos = layout.get(targetId);
      if (!sourcePos || !targetPos) continue;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(sourcePos.x));
      line.setAttribute('y1', String(sourcePos.y));
      line.setAttribute('x2', String(targetPos.x));
      line.setAttribute('y2', String(targetPos.y));
      line.setAttribute('stroke', '#8b949e');
      const edgeKey = `${node.id}->${targetId}`;
      const isIncident = focus.active && focus.incidentEdgeKeys.has(edgeKey);
      const edgeOpacity = !focus.active ? 0.35 : isIncident ? 0.82 : 0.1;
      const edgeWidth = isIncident ? 1.6 : 1;
      line.setAttribute('stroke-opacity', String(edgeOpacity));
      line.setAttribute('stroke-width', String(edgeWidth));
      line.classList.add('edge-glow');
      layers.get('edges').appendChild(line);
    }
  }

  for (const node of graph.nodes) {
    const pos = layout.get(node.id);
    if (!pos) continue;

    const degree = node.links_to.length + node.linked_by.length;
    const radius = computeNodeCircleRadius(degree);
    const tierColor = graphTierColor(node.tier);
    const isFocusedNode = focus.active && node.id === focus.centerNodeId;
    const isFocusRelated = focus.active && focus.relatedNodeIds.has(node.id);

    let fillOpacity = computeNodeFillOpacity(degree);
    if (focus.active) {
      fillOpacity = isFocusRelated ? fillOpacity : Math.min(fillOpacity, 0.18);
      if (isFocusedNode) {
        fillOpacity = Math.max(fillOpacity, 0.95);
      }
    }

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(pos.x));
    circle.setAttribute('cy', String(pos.y));
    circle.setAttribute('r', String(radius));
    circle.setAttribute('fill', tierColor);
    circle.setAttribute('fill-opacity', String(fillOpacity));
    circle.setAttribute('stroke', isFocusedNode ? '#58a6ff' : '#0f1117');
    circle.setAttribute('stroke-width', isFocusedNode ? '2.4' : '1.5');
    circle.setAttribute('tabindex', '0');
    circle.setAttribute('role', 'button');
    circle.setAttribute('aria-label', `Open memory ${node.name}. Degree ${degree}`);
    circle.style.cursor = 'pointer';
    // Add tier glow class
    circle.classList.add(`node-t${node.tier}`);
    if (isFocusedNode) {
      circle.classList.add('node-focused');
    }

    const circleTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    circleTitle.textContent = node.name;
    circle.appendChild(circleTitle);

    circle.addEventListener('click', event => {
      if (!shouldSelectGraphNodeOnClick({ button: event.button })) return;
      state.graphFocusNodeId = node.id;
      selectMemory(state.currentSpace.name, node.name);
    });
    circle.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        state.graphFocusNodeId = node.id;
        selectMemory(state.currentSpace.name, node.name);
      }
    });
    layers.get('nodes').appendChild(circle);

    const degreeLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    degreeLabel.textContent = String(degree);
    degreeLabel.setAttribute('x', String(pos.x));
    degreeLabel.setAttribute('y', String(pos.y + 0.5));
    degreeLabel.setAttribute('text-anchor', 'middle');
    degreeLabel.setAttribute('dominant-baseline', 'middle');
    degreeLabel.setAttribute('fill', '#0f1117');
    degreeLabel.setAttribute('font-size', '10');
    degreeLabel.setAttribute('font-weight', '700');
    degreeLabel.style.pointerEvents = 'none';
    degreeLabel.style.opacity = !focus.active || isFocusRelated ? '1' : '0.3';
    layers.get('nodes').appendChild(degreeLabel);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.textContent = truncateGraphLabel(node.name, 25);
    label.setAttribute('x', String(pos.x));
    label.setAttribute('y', String(computeLabelY(pos.y, radius)));
    label.setAttribute('fill', '#e6edf3');
    label.classList.add('graph-label');
    label.setAttribute('font-size', String(GRAPH_LABEL_BASE));
    label.setAttribute('text-anchor', 'middle');
    label.style.pointerEvents = 'none';
    label.style.opacity = !focus.active || isFocusRelated ? '1' : '0.3';

    const labelTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    labelTitle.textContent = node.name;
    label.appendChild(labelTitle);

    layers.get('labels').appendChild(label);
  }

  elGraphSvg.appendChild(transformGroup);
  applyGraphTransform();

  const m = graph.meta;
  if (m.truncated) {
    elGraphMeta.textContent = `Showing ${m.returned_nodes}/${m.total_nodes} nodes (cap ${m.applied_limit}/${m.max_limit}).`;
  } else {
    elGraphMeta.textContent = `Showing all ${m.returned_nodes} nodes.`;
  }
}

function graphTierColor(tier) {
  if (tier === 1) return '#ff7b72';
  if (tier === 2) return '#e3b341';
  if (tier === 3) return '#79c0ff';
  throw new Error('Invalid tier: ' + tier);
}

function applyGraphTransform() {
  const transformGroup = $('graph-transform');
  if (!transformGroup) return;
  const { scale, tx, ty } = state.graphTransform;
  transformGroup.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
  // Only recalculate labels if the scale actually changed
  if (scale !== state.lastAppliedScale) {
    updateGraphLabels(scale);
    state.lastAppliedScale = scale;
  }
}

function updateGraphLabels(scale) {
  const labels = elGraphSvg.querySelectorAll('.graph-label');
  const clampedLabelSize = computeLabelFontSize(
    scale,
    GRAPH_LABEL_BASE,
    GRAPH_LABEL_MIN,
    GRAPH_LABEL_MAX
  );
  const normalizedFontSize = clampedLabelSize / scale;
  for (const label of labels) {
    label.setAttribute('font-size', String(normalizedFontSize));
  }
}

function getSvgAnchorFromClient(clientX, clientY) {
  const point = elGraphSvg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;

  const screenMatrix = elGraphSvg.getScreenCTM();
  if (!screenMatrix) {
    return { x: 500, y: 500 };
  }

  const svgPoint = point.matrixTransform(screenMatrix.inverse());
  return { x: svgPoint.x, y: svgPoint.y };
}

function getSvgCenterAnchor() {
  const viewBox = elGraphSvg.viewBox.baseVal;
  return {
    x: viewBox.x + viewBox.width / 2,
    y: viewBox.y + viewBox.height / 2,
  };
}

function zoomGraphAtAnchor(factor, anchor) {
  state.graphTransform = zoomTransformAtAnchor(state.graphTransform, {
    factor,
    anchorX: anchor.x,
    anchorY: anchor.y,
    minScale: GRAPH_SCALE_MIN,
    maxScale: GRAPH_SCALE_MAX,
  });
  applyGraphTransform();
}

function renderMemoryItem(mem, spaceName) {
  const li = document.createElement('li');
  li.className = 'memory-item' + (state.currentMemory?.id === mem.id ? ' active' : '');
  li.dataset.id = mem.id;
  li.dataset.name = mem.name;

  const tags = (mem.tags ?? [])
    .slice(0, 3)
    .map(t => `<span class="memory-item-tag">${esc(t)}</span>`)
    .join('');

  li.innerHTML = `
        <span class="memory-item-pin">${mem.pinned ? '<span class="memory-item-pin-icon">' + ICON_PIN + '</span>' : ''}</span>
        <span class="memory-item-name">${esc(mem.name)}</span>
        <span class="memory-item-tags">${tags}</span>
    `;
  li.addEventListener('click', () => selectMemory(spaceName, mem.name));
  return li;
}

function renderTagRow(container, tags, onRemove, onAdd) {
  container.innerHTML = '';
  for (const tag of tags) {
    const span = document.createElement('span');
    span.className = 'tag';
    span.textContent = '#' + tag;
    span.title = 'Click to remove';
    span.style.cursor = 'pointer';
    span.addEventListener('click', async () => {
      if (!confirm(`Delete tag #${tag}?`)) return;
      await onRemove(tag);
    });
    container.appendChild(span);
  }
  const addBtn = document.createElement('button');
  addBtn.className = 'tag-add';
  addBtn.textContent = '+ tag';
  addBtn.addEventListener('click', onAdd);
  container.appendChild(addBtn);
}

function renderMemoryPanel(memory) {
  elMemTitle.textContent = memory.name;
  elMemTierBadge.innerHTML = ICON_TIER[memory.tier] + ' ' + TIER_LABEL[memory.tier];
  elMemTierBadge.className = 'tier-badge ' + TIER_CLASS[memory.tier];

  renderTagRow(
    elMemTagsRow,
    memory.tags ?? [],
    async tag => {
      await api.patch(`/api/spaces/${enc(memory.space_name)}/memories/${enc(memory.name)}`, {
        removeTag: tag,
      });
      await refreshMemory(memory.space_name, memory.name);
    },
    async () => {
      const tag = prompt('Tag name:');
      if (tag) {
        await api.patch(`/api/spaces/${enc(memory.space_name)}/memories/${enc(memory.name)}`, {
          addTag: tag.trim().toLowerCase(),
        });
        await refreshMemory(memory.space_name, memory.name);
      }
    }
  );

  // Sanitize HTML before rendering markdown output
  const rawContent = memory.content || '';
  const parsedContent = globalThis.marked.parse(rawContent);
  elMemContent.innerHTML = sanitizeHTML(parsedContent);

  const pinBtn = $('btn-mem-pin');
  pinBtn.innerHTML =
    '<span class="pin-button-icon">' +
    ICON_PIN +
    '</span><span>' +
    (memory.pinned ? 'Unpin' : 'Pin') +
    '</span>';

  // Show content, hide editor
  elMemContent.classList.remove('hidden');
  elMemEditArea.classList.add('hidden');
}

function renderSearchResults(results, query) {
  // Group results by space_name
  const groups = results.reduce((acc, r) => {
    const list = acc.get(r.space_name) ?? [];
    list.push(r);
    acc.set(r.space_name, list);
    return acc;
  }, new Map());

  const spaceCount = groups.size;
  elSearchHeading.textContent = `"${query}" — ${results.length} result${results.length !== 1 ? 's' : ''} in ${spaceCount} space${spaceCount !== 1 ? 's' : ''}`;
  elSearchList.innerHTML = '';
  if (results.length === 0) {
    elSearchList.innerHTML = '<li class="tier-empty">No results.</li>';
    return;
  }

  for (const [spaceName, memories] of groups) {
    // Space header
    const headerLi = document.createElement('li');
    headerLi.className = 'search-space-header';
    headerLi.textContent = `${esc(spaceName)} (${memories.length})`;
    elSearchList.appendChild(headerLi);

    // Memory items for this space
    for (const r of memories) {
      const li = document.createElement('li');
      li.className = 'memory-item';
      const tierClass = TIER_CLASS[r.tier] ?? '';
      const tierLabel = TIER_LABEL[r.tier] ?? '';
      li.innerHTML = `
                <span class="memory-item-name">${esc(r.name)}</span>
                <span class="memory-item-tags">${(r.tags ?? [])
                  .slice(0, 2)
                  .map(t => `<span class="memory-item-tag">${esc(t)}</span>`)
                  .join('')}</span>
                <span class="tier-badge ${tierClass}" style="font-size:10px;padding:0 5px;">${tierLabel}</span>
            `;
      li.addEventListener('click', () => {
        state.searchActive = false;
        showPanel('space');
        // Navigate to the space first, then open memory
        selectSpace(r.space_name).then(() => selectMemory(r.space_name, r.name));
      });
      elSearchList.appendChild(li);
    }
  }
}

// ── Panels ────────────────────────────────────────────────────────────────────
function showPanel(panel) {
  elEmptyState.classList.add('hidden');
  elSpaceDetail.classList.add('hidden');
  elSearchResults.classList.add('hidden');
  elLogsPage.classList.add('hidden');

  if (panel === 'empty') elEmptyState.classList.remove('hidden');
  else if (panel === 'space') elSpaceDetail.classList.remove('hidden');
  else if (panel === 'search') elSearchResults.classList.remove('hidden');
  else if (panel === 'logs') elLogsPage.classList.remove('hidden');
}

function showMemoryPanel(show) {
  if (show) {
    elMemoryPanel.classList.remove('hidden');
    // Force reflow so CSS transition animates from current (off-screen) state
    void elMemoryPanel.offsetWidth;
    elMemoryPanel.classList.add('open');
  } else {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    elMemoryPanel.classList.remove('open');
    if (prefersReducedMotion) {
      elMemoryPanel.classList.add('hidden');
    } else {
      // Wait for slide-out animation (250ms) before hiding
      setTimeout(() => {
        elMemoryPanel.classList.add('hidden');
      }, 250);
    }
  }
}

function closeCurrentMemoryPanel() {
  state.currentMemory = null;
  state.graphFocusNodeId = null;
  showMemoryPanel(false);
  renderSpaceDetail();
  syncUrl();
}

function isMemoryPanelOpen() {
  return !elMemoryPanel.classList.contains('hidden');
}

function isMemorySelectionTarget(target) {
  return Boolean(target.closest('.memory-item') || target.closest('#graph-svg [role="button"]'));
}

function syncUrl(options = {}) {
  const { replace = false } = options;
  const nextUrl = buildAppUrl({
    spaceName: state.currentSpace?.name ?? null,
    view: state.spaceView,
    memoryName: state.currentMemory?.name ?? null,
    isLogsPage: state.logsActive,
  });

  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl === currentUrl) return;

  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({}, '', nextUrl);
}

function resetToHomeState() {
  state.currentSpace = null;
  state.currentMemory = null;
  state.memories = [];
  state.graph = null;
  state.graphFocusNodeId = null;
  closeLogsPage();
  showMemoryPanel(false);
  showPanel('empty');
  renderSpaceList();
  renderStatusPlaceholder();
}

async function restoreRouteFromLocation() {
  const route = parseAppRoute(window.location.pathname, window.location.search);

  // Handle logs page
  if (route.isLogsPage) {
    showLogsPage();
    return;
  }

  if (!route.spaceName) {
    resetToHomeState();
    syncUrl({ replace: true });
    return;
  }

  const hasSpace = state.spaces.some(space => space.name === route.spaceName);
  if (!hasSpace) {
    resetToHomeState();
    syncUrl({ replace: true });
    return;
  }

  await selectSpace(route.spaceName, { updateUrl: false, view: route.view });

  if (route.memoryName) {
    const hasMemory = state.memories.some(memory => memory.name === route.memoryName);
    if (hasMemory) {
      await selectMemory(route.spaceName, route.memoryName, { updateUrl: false });
    } else {
      state.currentMemory = null;
      showMemoryPanel(false);
      renderSpaceDetail();
    }
  }

  syncUrl({ replace: true });
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function loadSpaces() {
  const qs = state.showHiddenSpaces ? '?includeHidden=true' : '';
  state.spaces = await api.get(`/api/spaces${qs}`);
  renderSpaceList();
}

async function selectSpace(name, options = {}) {
  const { updateUrl = true, view = state.spaceView } = options;
  state.currentSpace = state.spaces.find(s => s.name === name) ?? { name };
  state.currentMemory = null;
  state.graphFocusNodeId = null;
  state.logsActive = false;
  showMemoryPanel(false);

  const [spaceData, memories, graph] = await Promise.all([
    api.get(`/api/spaces/${enc(name)}`),
    api.get(`/api/spaces/${enc(name)}/memories`),
    api.get(`/api/spaces/${enc(name)}/graph`),
  ]);
  state.currentSpace = spaceData;
  state.memories = memories;
  state.graph = graph;
  state.graphTransform = { scale: 1, tx: 0, ty: 0 };
  state.lastAppliedScale = null;

  showPanel('space');
  renderSpaceList();
  renderSpaceDetail();
  setSpaceView(view, { updateUrl: false });
  await loadStatus(spaceData.name);

  if (updateUrl) {
    syncUrl();
  }
}

async function refreshSpace(name) {
  const [spaceData, memories, graph] = await Promise.all([
    api.get(`/api/spaces/${enc(name)}`),
    api.get(`/api/spaces/${enc(name)}/memories`),
    api.get(`/api/spaces/${enc(name)}/graph`),
    loadSpaces(),
    loadStatus(name),
  ]);
  state.currentSpace = spaceData;
  state.memories = memories;
  state.graph = graph;
  state.graphFocusNodeId = null;
  renderSpaceDetail();
}

async function selectMemory(spaceName, memName, options = {}) {
  const { updateUrl = true } = options;
  const memory = await api.get(`/api/spaces/${enc(spaceName)}/memories/${enc(memName)}`);
  state.currentMemory = memory;
  renderMemoryPanel(memory);
  showMemoryPanel(true);
  // Re-render memory list to show active state
  renderSpaceDetail();

  if (updateUrl) {
    syncUrl();
  }
}

async function refreshMemory(spaceName, memName) {
  const memory = await api.get(`/api/spaces/${enc(spaceName)}/memories/${enc(memName)}`);
  state.currentMemory = memory;
  renderMemoryPanel(memory);
  await refreshSpace(spaceName);
}

// ── Inline editing ────────────────────────────────────────────────────────────
function makeEditable(el, onSave) {
  el.addEventListener('click', () => {
    const current = el.textContent;
    const input = document.createElement('input');
    input.value = current;
    input.className = el.className;
    input.style.background = 'var(--bg3)';
    input.style.border = '1px solid var(--accent)';
    input.style.borderRadius = '4px';
    input.style.padding = '2px 6px';
    input.style.color = 'var(--text)';
    input.style.width = '100%';
    el.replaceWith(input);
    input.focus();
    input.select();

    const done = async save => {
      if (save && input.value !== current) await onSave(input.value);
      input.replaceWith(el);
      if (save) el.textContent = input.value;
    };
    input.addEventListener('blur', () => done(true));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(true);
      }
      if (e.key === 'Escape') done(false);
    });
  });
}

// ── Event wiring ──────────────────────────────────────────────────────────────

elBtnViewList.addEventListener('click', () => {
  setSpaceView('list');
});
elBtnViewMap.addEventListener('click', () => {
  setSpaceView('map');
});

// View toggle keyboard navigation (ArrowLeft/ArrowRight)
const viewButtons = document.querySelectorAll('.view-toggle-btn');
viewButtons.forEach((btn, index) => {
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prevBtn = viewButtons[index - 1] || viewButtons[viewButtons.length - 1];
      prevBtn.click();
      prevBtn.focus();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const nextBtn = viewButtons[index + 1] || viewButtons[0];
      nextBtn.click();
      nextBtn.focus();
    }
  });
});

window.addEventListener('popstate', () => {
  restoreRouteFromLocation().catch(() => {
    resetToHomeState();
    syncUrl({ replace: true });
  });
});

$('btn-graph-zoom-in').addEventListener('click', () => {
  zoomGraphAtAnchor(1.2, getSvgCenterAnchor());
});

$('btn-graph-zoom-out').addEventListener('click', () => {
  zoomGraphAtAnchor(1 / 1.2, getSvgCenterAnchor());
});

$('btn-graph-reset').addEventListener('click', () => {
  state.graphTransform = { scale: 1, tx: 0, ty: 0 };
  state.lastAppliedScale = null;
  applyGraphTransform();
});

let graphInteraction = createGraphInteractionState();
let panelCloseGuardPointerStart = null;
let panelCloseGuardInteractionWasDrag = false;
let graphDragHappened = false;

/**
 * Check if the event target is a graph node (circle element with role="button")
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
function isGraphNodeTarget(target) {
  if (!target) return false;
  if (!(target instanceof Element)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'circle' && target.getAttribute('role') === 'button';
}

document.addEventListener('mousedown', event => {
  if (event.button !== 0) return;
  panelCloseGuardPointerStart = { x: event.clientX, y: event.clientY };
  panelCloseGuardInteractionWasDrag = false;
});

document.addEventListener('mouseup', event => {
  if (!panelCloseGuardPointerStart) return;
  panelCloseGuardInteractionWasDrag = Boolean(
    interactionWasDrag({
      start: panelCloseGuardPointerStart,
      end: { x: event.clientX, y: event.clientY },
      thresholdPx: DRAG_CLOSE_GUARD_THRESHOLD_PX,
    })
  );
  panelCloseGuardPointerStart = null;
});

elGraphSvg.addEventListener('pointerdown', event => {
  const nextState = beginGraphPointerGesture(graphInteraction, {
    pointerId: event.pointerId,
    button: event.button,
    shiftKey: event.shiftKey,
    clientX: event.clientX,
    clientY: event.clientY,
    tx: state.graphTransform.tx,
    ty: state.graphTransform.ty,
  });

  graphInteraction = nextState;
  if (graphInteraction.activePointerId !== event.pointerId) return;

  // Only capture pointer for panning if NOT clicking on a graph node.
  // This ensures click events on nodes (circles) fire normally.
  if (!isGraphNodeTarget(event.target)) {
    elGraphSvg.setPointerCapture(event.pointerId);
  }

  if (event.button === 0 || event.button === 2) {
    event.preventDefault();
  }
});

elGraphSvg.addEventListener('pointermove', event => {
  graphInteraction = updateGraphPointerGesture(graphInteraction, {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
  });

  const nextTransform = currentGraphPanTransform(graphInteraction, {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
  });
  if (!nextTransform) return;

  event.preventDefault();
  state.graphTransform = {
    ...state.graphTransform,
    tx: nextTransform.tx,
    ty: nextTransform.ty,
  };
  applyGraphTransform();
});

elGraphSvg.addEventListener('pointerup', event => {
  // Capture drag state before resetting
  graphDragHappened = graphInteraction.dragMoved;
  graphInteraction = endGraphPointerGesture(graphInteraction, { pointerId: event.pointerId });
});

elGraphSvg.addEventListener('pointercancel', event => {
  // Capture drag state before resetting
  graphDragHappened = graphInteraction.dragMoved;
  graphInteraction = endGraphPointerGesture(graphInteraction, { pointerId: event.pointerId });
});

elGraphSvg.addEventListener('lostpointercapture', () => {
  if (graphInteraction.activePointerId === null) return;
  // Capture drag state before resetting
  graphDragHappened = graphInteraction.dragMoved;
  graphInteraction = endGraphPointerGesture(graphInteraction, {
    pointerId: graphInteraction.activePointerId,
  });
});

elGraphSvg.addEventListener('contextmenu', event => {
  const decision = handleGraphContextMenu(graphInteraction, {
    shiftKey: event.shiftKey,
  });
  graphInteraction = decision.state;

  if (decision.shouldPrevent) {
    event.preventDefault();
  }
});

elGraphSvg.addEventListener(
  'wheel',
  event => {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1.1 : 0.9;
    const anchor = getSvgAnchorFromClient(event.clientX, event.clientY);
    zoomGraphAtAnchor(direction, anchor);
  },
  { passive: false }
);

// Space title inline edit (rename)
makeEditable(elSpaceTitle, async newName => {
  const oldName = state.currentSpace.name;
  await api.patch(`/api/spaces/${enc(oldName)}`, { newName });
  state.currentSpace.name = newName;
  await loadSpaces();
  syncUrl({ replace: true });
});

// Space description inline edit
makeEditable(elSpaceDesc, async desc => {
  await api.patch(`/api/spaces/${enc(state.currentSpace.name)}`, { description: desc });
  state.currentSpace.description = desc;
});

// New space modal
$('btn-new-space').addEventListener('click', () => $('modal-new-space').classList.remove('hidden'));
$('modal-space-cancel').addEventListener('click', () =>
  $('modal-new-space').classList.add('hidden')
);
$('modal-space-create').addEventListener('click', async () => {
  const name = $('new-space-name').value.trim();
  const desc = $('new-space-desc').value.trim();
  const tags = $('new-space-tags')
    .value.split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
  if (!name) return;

  const btn = $('modal-space-create');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Creating…';

  try {
    await api.post('/api/spaces', { name, description: desc, tags });
    $('modal-new-space').classList.add('hidden');
    $('new-space-name').value = '';
    $('new-space-desc').value = '';
    $('new-space-tags').value = '';
    await loadSpaces();
    await selectSpace(name);
    showToast(`Space "${name}" created`, 'success');
  } catch (err) {
    showToast(`Failed to create space: ${err.message || 'Unknown error'}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Create';
  }
});

// Delete space
$('btn-delete-space').addEventListener('click', async () => {
  const name = state.currentSpace?.name;
  if (!name) return;
  if (!confirm(`Delete space "${name}" and all its memories?`)) return;

  const btn = $('btn-delete-space');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Deleting…';

  try {
    await api.del(`/api/spaces/${enc(name)}`);
    resetToHomeState();
    syncUrl();
    await loadSpaces();
    showToast(`Space "${name}" deleted`, 'success');
  } catch (err) {
    showToast(`Failed to delete space: ${err.message || 'Unknown error'}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Delete space';
  }
});

// New memory modal
$('btn-add-memory').addEventListener('click', () =>
  $('modal-new-memory').classList.remove('hidden')
);
$('modal-mem-cancel').addEventListener('click', () =>
  $('modal-new-memory').classList.add('hidden')
);
$('modal-mem-create').addEventListener('click', async () => {
  const name = $('new-mem-name').value.trim();
  const content = $('new-mem-content').value;
  const tags = $('new-mem-tags')
    .value.split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
  const tier = Number($('new-mem-tier').value);
  if (!name || !state.currentSpace) return;

  const btn = $('modal-mem-create');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Adding…';

  try {
    await api.post(`/api/spaces/${enc(state.currentSpace.name)}/memories`, {
      name,
      content,
      tags,
      tier,
    });
    $('modal-new-memory').classList.add('hidden');
    $('new-mem-name').value = '';
    $('new-mem-content').value = '';
    $('new-mem-tags').value = '';
    $('new-mem-tier').value = '2';
    await refreshSpace(state.currentSpace.name);
    showToast(`Memory "${name}" added`, 'success');
  } catch (err) {
    showToast(`Failed to add memory: ${err.message || 'Unknown error'}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Add';
  }
});

// Memory panel actions
$('btn-mem-close').addEventListener('click', () => {
  closeCurrentMemoryPanel();
});

$('btn-mem-close-inline').addEventListener('click', () => {
  closeCurrentMemoryPanel();
});

document.addEventListener('click', event => {
  if (!isMemoryPanelOpen()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  // Check both document-level drag guard AND graph-level drag state
  const wasDrag = panelCloseGuardInteractionWasDrag || graphDragHappened;

  const shouldClose = shouldCloseMemoryPanelOnClick({
    isPanelOpen: true,
    targetInsidePanel: Boolean(target.closest('#memory-panel')),
    targetIsMemorySelection: isMemorySelectionTarget(target),
    interactionWasDrag: wasDrag,
  });

  panelCloseGuardInteractionWasDrag = false;
  graphDragHappened = false;

  if (shouldClose) {
    closeCurrentMemoryPanel();
  }
});

$('btn-mem-edit').addEventListener('click', () => {
  elMemEditInput.value = state.currentMemory?.content ?? '';
  elMemContent.classList.add('hidden');
  elMemEditArea.classList.remove('hidden');
  elMemEditInput.focus();
});

$('btn-mem-cancel-edit').addEventListener('click', () => {
  elMemContent.classList.remove('hidden');
  elMemEditArea.classList.add('hidden');
});

$('btn-mem-save').addEventListener('click', async () => {
  const mem = state.currentMemory;
  if (!mem) return;
  const content = elMemEditInput.value;

  const btn = $('btn-mem-save');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Saving…';

  try {
    await api.patch(`/api/spaces/${enc(mem.space_name)}/memories/${enc(mem.name)}`, { content });
    await refreshMemory(mem.space_name, mem.name);
    showToast('Memory saved', 'success');
  } catch (err) {
    showToast(`Failed to save: ${err.message || 'Unknown error'}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Save';
  }
});

$('btn-mem-promote').addEventListener('click', async () => {
  const mem = state.currentMemory;
  if (!mem) return;
  try {
    await api.patch(`/api/spaces/${enc(mem.space_name)}/memories/${enc(mem.name)}`, {
      promote: true,
    });
    await refreshMemory(mem.space_name, mem.name);
  } catch (err) {
    showToast(`Failed to promote: ${err.message || 'Unknown error'}`, 'error');
  }
});

$('btn-mem-demote').addEventListener('click', async () => {
  const mem = state.currentMemory;
  if (!mem) return;
  try {
    await api.patch(`/api/spaces/${enc(mem.space_name)}/memories/${enc(mem.name)}`, {
      demote: true,
    });
    await refreshMemory(mem.space_name, mem.name);
  } catch (err) {
    showToast(`Failed to demote: ${err.message || 'Unknown error'}`, 'error');
  }
});

$('btn-mem-pin').addEventListener('click', async () => {
  const mem = state.currentMemory;
  if (!mem) return;
  try {
    await api.patch(`/api/spaces/${enc(mem.space_name)}/memories/${enc(mem.name)}`, {
      pinned: !mem.pinned,
    });
    await refreshMemory(mem.space_name, mem.name);
  } catch (err) {
    showToast(`Failed to update pin: ${err.message || 'Unknown error'}`, 'error');
  }
});

$('btn-mem-delete').addEventListener('click', async () => {
  const mem = state.currentMemory;
  if (!mem || !confirm(`Delete memory "${mem.name}"?`)) return;

  const btn = $('btn-mem-delete');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Deleting…';

  try {
    await api.del(`/api/spaces/${enc(mem.space_name)}/memories/${enc(mem.name)}`);
    state.currentMemory = null;
    showMemoryPanel(false);
    await refreshSpace(mem.space_name);
    syncUrl();
    showToast(`Memory "${mem.name}" deleted`, 'success');
  } catch (err) {
    showToast(`Failed to delete memory: ${err.message || 'Unknown error'}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Delete';
  }
});

// Close search
$('btn-close-search').addEventListener('click', () => {
  state.searchActive = false;
  elGlobalSearch.value = '';
  if (state.currentSpace) showPanel('space');
  else showPanel('empty');
});

// Global search (debounced)
let searchTimer = null;
let searchTypingTimer = null;
elGlobalSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = elGlobalSearch.value.trim();
  if (!q) {
    state.searchActive = false;
    if (state.currentSpace) showPanel('space');
    else showPanel('empty');
    // Reset typing pulse state
    if (searchTypingTimer) {
      clearTimeout(searchTypingTimer);
      searchTypingTimer = null;
    }
    elGlobalSearch.style.boxShadow = '';
    return;
  }
  searchTimer = setTimeout(async () => {
    state.searchResults = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
    state.searchActive = true;
    showPanel('search');
    renderSearchResults(state.searchResults, q);
  }, 300);

  // Search typing pulse - after 1s of continuous typing, start pulsing
  if (searchTypingTimer) {
    clearTimeout(searchTypingTimer);
  }
  searchTypingTimer = setTimeout(() => {
    const pulse = () => {
      elGlobalSearch.style.boxShadow =
        '0 0 12px var(--neon-cyan), 0 0 24px rgba(0,240,255,0.6), 0 0 48px rgba(0,240,255,0.3)';
      setTimeout(() => {
        elGlobalSearch.style.boxShadow =
          '0 0 6px var(--neon-cyan), 0 0 16px rgba(0,240,255,0.4), 0 0 32px rgba(0,240,255,0.15)';
      }, 250);
    };
    pulse();
    const intervalId = setInterval(pulse, 500);
    // Store interval id in a custom property for cleanup
    searchTypingTimer = { intervalId, timeoutId: null };
    searchTypingTimer.timeoutId = setTimeout(() => {
      clearInterval(searchTypingTimer.intervalId);
      elGlobalSearch.style.boxShadow = '';
      searchTypingTimer = null;
    }, 3000);
  }, 1000);
});

elGlobalSearch.addEventListener('blur', () => {
  if (searchTypingTimer) {
    if (searchTypingTimer.intervalId) clearInterval(searchTypingTimer.intervalId);
    if (searchTypingTimer.timeoutId) clearTimeout(searchTypingTimer.timeoutId);
    searchTypingTimer = null;
  }
  elGlobalSearch.style.boxShadow = '';
});

// Modal dismiss with scale-out animation
function closeModal() {
  const backdrop = document.querySelector('.modal-backdrop');
  const modal = document.querySelector('.modal');
  if (!backdrop) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReducedMotion) {
    backdrop.classList.add('hidden');
    modal.classList.add('hidden');
  } else {
    modal.classList.add('modal-closing');
    setTimeout(() => {
      backdrop.classList.add('hidden');
      modal.classList.remove('modal-closing');
      modal.classList.add('hidden');
    }, 150);
  }
}

// Modal keyboard close
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal();
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function enc(str) {
  return encodeURIComponent(str);
}

// ── Toast notifications ─────────────────────────────────────────────────────────
let toastContainer = null;

function ensureToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    document.body.appendChild(toastContainer);
  }
}

function showToast(message, type = 'success', duration = null) {
  ensureToastContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');
  toast.setAttribute('aria-live', 'polite');

  let icon = '';
  if (type === 'success') icon = ICON_SUCCESS;
  else if (type === 'error') icon = ICON_ERROR;
  else if (type === 'warning') icon = ICON_WARNING;

  toast.innerHTML = `
        ${icon}
        <span class="toast-message">${esc(message)}</span>
        <button class="toast-dismiss" aria-label="Dismiss">${ICON_CLOSE}</button>
    `;

  const dismissBtn = toast.querySelector('.toast-dismiss');
  dismissBtn.addEventListener('click', () => {
    dismissToast(toast);
  });

  toastContainer.appendChild(toast);

  // Auto-dismiss for success, manual for error/warning
  if (type === 'success') {
    const autoDuration = duration ?? 3000;
    setTimeout(() => {
      dismissToast(toast);
    }, autoDuration);
  }

  return toast;
}

function dismissToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.classList.add('toast-fade-out');
  setTimeout(() => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }, 200);
}

// ── Skeleton loading ───────────────────────────────────────────────────────────
function _renderSkeletonMemoryList(container, count = 3) {
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const li = document.createElement('li');
    li.className = 'skeleton-memory-item';
    li.innerHTML = `
            <div class="skeleton skeleton-circle"></div>
            <div class="skeleton skeleton-text"></div>
            <div class="skeleton skeleton-tag"></div>
            <div class="skeleton skeleton-count"></div>
        `;
    container.appendChild(li);
  }
}

function _showGraphLoadingOverlay() {
  let overlay = $('graph-loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'graph-loading-overlay';
    overlay.innerHTML = '<div class="spinner"></div>';
    overlay.style.display = 'flex';
    const canvasWrap = $('graph-canvas-wrap');
    if (canvasWrap) canvasWrap.style.position = 'relative';
    const graphSvg = $('graph-svg');
    if (graphSvg && graphSvg.parentNode) {
      graphSvg.parentNode.insertBefore(overlay, graphSvg.nextSibling);
    }
  }
  overlay.style.display = 'flex';
}

function _hideGraphLoadingOverlay() {
  const overlay = $('graph-loading-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

// ── XSS Sanitization ───────────────────────────────────────────────────────────
const SAFE_TAGS = new Set([
  'p',
  'strong',
  'em',
  'a',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'span',
  'br',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);
const SAFE_ATTRS = new Set(['href', 'title', 'alt', 'class']);

function sanitizeHTML(html) {
  if (!html) return '';

  // Parse HTML into a DOM to safely extract allowed content
  const doc = document.implementation.createHTMLDocument('');
  const body = doc.body;

  // Use a temporary div to parse HTML (safe because we're extracting text content only)
  const temp = doc.createElement('div');
  temp.innerHTML = html;
  body.appendChild(temp);

  // Walk the DOM and sanitize
  function sanitizeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const tagName = node.tagName.toLowerCase();

    if (!SAFE_TAGS.has(tagName)) {
      // For non-safe tags, preserve their text content only
      return Array.from(node.childNodes).map(sanitizeNode).join('');
    }

    // Build sanitized attributes
    const attrs = [];
    for (const attr of node.attributes) {
      const name = attr.name.toLowerCase();
      if (SAFE_ATTRS.has(name)) {
        if (name === 'href') {
          const value = attr.value.trim();
          if (value.toLowerCase().startsWith('javascript:')) {
            continue; // Strip javascript: hrefs
          }
          attrs.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
        } else {
          attrs.push(`${name}="${attr.value.replace(/"/g, '&quot;')}"`);
        }
      }
    }

    const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
    const innerHTML = Array.from(node.childNodes).map(sanitizeNode).join('');

    // Self-closing tags
    if (['br', 'hr', 'img'].includes(tagName)) {
      return `<${tagName}${attrStr}>`;
    }

    return `<${tagName}${attrStr}>${innerHTML}</${tagName}>`;
  }

  return Array.from(body.childNodes).map(sanitizeNode).join('');
}

// ── Logs ─────────────────────────────────────────────────────────────────────

function getLogsFilter() {
  const sources = [];
  if (elLogSourceCli?.checked) sources.push('cli');
  if (elLogSourceMcp?.checked) sources.push('mcp');
  if (elLogSourceApi?.checked) sources.push('api');

  return {
    source: sources.length > 0 ? sources.join(',') : undefined,
    search: elLogSearch?.value?.trim() || undefined,
    order: elLogOrder?.value || 'desc',
    limit: state.logsLimit,
    offset: state.logsOffset,
  };
}

async function loadLogs() {
  try {
    const filter = getLogsFilter();
    const result = await api.getLogs(filter);

    if (state.logsOffset === 0) {
      state.logs = result.logs;
    } else {
      state.logs = [...state.logs, ...result.logs];
    }
    state.logsTotal = result.total;

    renderLogsList();
  } catch (e) {
    console.error('Failed to load logs:', e);
  }
}

function renderLogsList() {
  elLogsList.innerHTML = '';

  for (const log of state.logs) {
    const li = document.createElement('li');
    li.className = 'log-entry' + (state.logsExpandedId === log.id ? ' expanded' : '');

    const timestamp = new Date(log.timestamp.replace(' ', 'T') + 'Z').toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const duration = log.duration_ms ? `${log.duration_ms}ms` : '';

    li.innerHTML =
      '<div class="log-entry-header">' +
      '<span class="log-timestamp">' +
      esc(timestamp) +
      '</span>' +
      '<span class="log-source ' +
      log.source +
      '">' +
      log.source +
      '</span>' +
      '<span class="log-operation">' +
      esc(log.operation) +
      '</span>' +
      '<span class="log-level ' +
      log.level +
      '">' +
      log.level +
      '</span>' +
      '<span class="log-duration">' +
      duration +
      '</span>' +
      '</div>' +
      (log.error_message
        ? '<div class="log-error-message">' + esc(log.error_message) + '</div>'
        : '') +
      '<div class="log-entry-details hidden">' +
      '<strong>Input:</strong><pre>' +
      (log.input_data ? esc(formatJson(log.input_data)) : 'null') +
      '</pre>' +
      '<strong>Output:</strong><pre>' +
      (log.output_data ? esc(formatJson(log.output_data)) : 'null') +
      '</pre>' +
      (log.caller_info
        ? '<strong>Caller:</strong><pre>' + esc(formatJson(log.caller_info)) + '</pre>'
        : '') +
      '</div>';

    // Drag guard: don't toggle if text is selected
    li.addEventListener('click', () => {
      if (window.getSelection().toString().length > 0) {
        return;
      }
      state.logsExpandedId = state.logsExpandedId === log.id ? null : log.id;
      const details = li.querySelector('.log-entry-details');
      if (details) {
        details.classList.toggle('hidden', state.logsExpandedId !== log.id);
      }
      li.classList.toggle('expanded', state.logsExpandedId === log.id);
    });

    elLogsList.appendChild(li);
  }

  elLogsCount.textContent = `Showing ${state.logs.length} of ${state.logsTotal} logs`;
}

function formatJson(str) {
  if (!str) return '';
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function showLogsPage() {
  state.logsActive = true;
  state.logsOffset = 0;
  state.logsLastId = 0;
  state.logs = [];

  showPanel('logs');
  loadLogs();

  // Start polling if Live is enabled by default
  if (state.logsLive) {
    startLogsPolling();
  }
}

function closeLogsPage() {
  state.logsActive = false;
  stopLogsPolling();
}

function startLogsPolling() {
  console.log('Starting logs polling...');

  // Stop any existing polling
  if (state.logsPollingInterval) {
    clearInterval(state.logsPollingInterval);
  }

  // Do initial poll
  pollLogs();

  // Poll every 2 seconds
  state.logsPollingInterval = setInterval(pollLogs, 2000);

  elLogsConnectionStatus?.classList.remove('hidden');
  elLogsConnectionStatus.textContent = '● Live (polling)';
}

function stopLogsPolling() {
  console.log('Stopping logs polling...');
  if (state.logsPollingInterval) {
    clearInterval(state.logsPollingInterval);
    state.logsPollingInterval = null;
  }
  elLogsConnectionStatus?.classList.add('hidden');
}

function getLogsPollingFilter() {
  const sources = [];
  if (elLogSourceCli?.checked) sources.push('cli');
  if (elLogSourceMcp?.checked) sources.push('mcp');
  if (elLogSourceApi?.checked) sources.push('api');

  return {
    source: sources.length > 0 ? sources.join(',') : undefined,
    search: elLogSearch?.value?.trim() || undefined,
    order: elLogOrder?.value || 'desc',
    limit: 50, // Get more logs for polling to ensure we don't miss any
  };
}

function prependNewLogs(newLogs) {
  // Save current scroll position
  const scrollTop = elLogsList.scrollTop;
  const scrollHeight = elLogsList.scrollHeight;

  // Update count
  elLogsCount.textContent = `Showing ${state.logs.length} of ${state.logsTotal} logs`;

  // Prepend each new log to the DOM (in reverse order so they appear correctly)
  for (let i = newLogs.length - 1; i >= 0; i--) {
    const log = newLogs[i];
    const li = createLogElement(log);
    elLogsList.insertBefore(li, elLogsList.firstChild);
  }

  // Handle scroll: if follow is enabled, scroll to top. Otherwise preserve position.
  if (state.logsFollow) {
    elLogsList.scrollTop = 0;
  } else {
    // Restore scroll position (adjust for new content height)
    const newScrollHeight = elLogsList.scrollHeight;
    const heightDiff = newScrollHeight - scrollHeight;
    elLogsList.scrollTop = scrollTop + heightDiff;
  }
}

function createLogElement(log) {
  const li = document.createElement('li');
  li.className = 'log-entry' + (state.logsExpandedId === log.id ? ' expanded' : '');

  const timestamp = new Date(log.timestamp.replace(' ', 'T') + 'Z').toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const duration = log.duration_ms ? `${log.duration_ms}ms` : '';

  li.innerHTML =
    '<div class="log-entry-header">' +
    '<span class="log-timestamp">' +
    esc(timestamp) +
    '</span>' +
    '<span class="log-source ' +
    log.source +
    '">' +
    log.source +
    '</span>' +
    '<span class="log-operation">' +
    esc(log.operation) +
    '</span>' +
    '<span class="log-level ' +
    log.level +
    '">' +
    log.level +
    '</span>' +
    '<span class="log-duration">' +
    duration +
    '</span>' +
    '</div>' +
    (log.error_message
      ? '<div class="log-error-message">' + esc(log.error_message) + '</div>'
      : '') +
    '<div class="log-entry-details hidden">' +
    '<strong>Input:</strong><pre>' +
    (log.input_data ? esc(formatJson(log.input_data)) : 'null') +
    '</pre>' +
    '<strong>Output:</strong><pre>' +
    (log.output_data ? esc(formatJson(log.output_data)) : 'null') +
    '</pre>' +
    (log.caller_info
      ? '<strong>Caller:</strong><pre>' + esc(formatJson(log.caller_info)) + '</pre>'
      : '') +
    '</div>';

  // Drag guard: don't toggle if text is selected
  li.addEventListener('click', () => {
    if (window.getSelection().toString().length > 0) {
      return;
    }
    state.logsExpandedId = state.logsExpandedId === log.id ? null : log.id;
    const details = li.querySelector('.log-entry-details');
    if (details) {
      details.classList.toggle('hidden', state.logsExpandedId !== log.id);
    }
    li.classList.toggle('expanded', state.logsExpandedId === log.id);
  });

  return li;
}
async function pollLogs() {
  try {
    const filter = getLogsPollingFilter();

    // Use since parameter to get only new logs
    // Since we want newest first (desc), we need to track the highest ID we've seen
    const result = await api.getLogs({ ...filter, since: state.logsLastId });

    if (result.logs.length > 0) {
      // Update lastId to track the newest log
      const maxId = Math.max(...result.logs.map(l => l.id));
      if (maxId > state.logsLastId) {
        state.logsLastId = maxId;
      }

      // For polling with desc order, newest are at the start
      // Prepend new logs to the beginning of the list
      state.logs = [...result.logs, ...state.logs].slice(0, 1000);
      state.logsTotal = result.total;
      prependNewLogs(result.logs);
    }
  } catch (e) {
    console.error('Failed to poll logs:', e);
  }
}

// Event handlers for logs
elLogSourceCli?.addEventListener('change', () => {
  state.logsOffset = 0;
  state.logsLastId = 0;
  loadLogs();
});
elLogSourceMcp?.addEventListener('change', () => {
  state.logsOffset = 0;
  state.logsLastId = 0;
  loadLogs();
});
elLogSourceApi?.addEventListener('change', () => {
  state.logsOffset = 0;
  state.logsLastId = 0;
  loadLogs();
});
elLogSearch?.addEventListener('input', () => {
  state.logsOffset = 0;
  state.logsLastId = 0;
  loadLogs();
});
elLogOrder?.addEventListener('change', () => {
  state.logsOffset = 0;
  state.logsLastId = 0;
  loadLogs();
});
elLogLive?.addEventListener('change', () => {
  state.logsLive = elLogLive.checked;
  if (state.logsLive) {
    startLogsPolling();
  } else {
    stopLogsPolling();
  }
});
elLogFollow?.addEventListener('change', () => {
  state.logsFollow = elLogFollow.checked;
});
elBtnRefreshLogs?.addEventListener('click', () => {
  state.logsOffset = 0;
  loadLogs();
});
elBtnClearLogs?.addEventListener('click', async () => {
  if (!confirm('Delete all logs? This cannot be undone.')) return;
  try {
    await api.deleteLogs();
    state.logs = [];
    state.logsTotal = 0;
    state.logsOffset = 0;
    state.logsLastId = 0;
    renderLogsList();
  } catch (e) {
    console.error('Failed to clear logs:', e);
  }
});
elBtnLoadMoreLogs?.addEventListener('click', () => {
  state.logsOffset += state.logsLimit;
  loadLogs();
});

elToggleHiddenSpaces?.addEventListener('change', () => {
  state.showHiddenSpaces = elToggleHiddenSpaces.checked;
  loadSpaces();
});

// ── Mobile sidebar overlay ─────────────────────────────────────────────────────
const sidebar = $('sidebar');
const sidebarOverlay = $('sidebar-overlay');
const hamburgerBtn = $('hamburger-btn');

function openSidebar() {
  sidebar?.classList.add('sidebar-open');
  sidebarOverlay?.classList.remove('overlay-hidden');
  hamburgerBtn?.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
}

function closeSidebar() {
  sidebar?.classList.remove('sidebar-open');
  sidebarOverlay?.classList.add('overlay-hidden');
  hamburgerBtn?.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}

hamburgerBtn?.addEventListener('click', () => {
  const isOpen = sidebar?.classList.contains('sidebar-open');
  if (isOpen) {
    closeSidebar();
  } else {
    openSidebar();
  }
});

sidebarOverlay?.addEventListener('click', closeSidebar);

// Close sidebar when selecting a space on mobile
function closeSidebarOnSpaceSelect() {
  if (window.innerWidth < 768) {
    closeSidebar();
  }
}

// Update close button visibility based on screen size
function updateCloseButtonVisibility() {
  const isMobile = window.innerWidth < 768;
  const btnBack = $('btn-mem-close');
  const btnInline = $('btn-mem-close-inline');
  if (btnBack && btnInline) {
    btnBack.style.display = isMobile ? 'flex' : 'none';
    btnInline.style.display = isMobile ? 'none' : 'flex';
  }
}

// Handle window resize
window.addEventListener('resize', () => {
  updateCloseButtonVisibility();
  if (window.innerWidth >= 768) {
    closeSidebar();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  updateCloseButtonVisibility();
  await loadSpaces();
  await loadStatus();
  await restoreRouteFromLocation();
}

boot().catch(() => {
  resetToHomeState();
});

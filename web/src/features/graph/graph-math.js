// @ts-check

const TWO_PI = Math.PI * 2;

/** @typedef {{ scale:number, tx:number, ty:number }} GraphTransform */
/** @typedef {{ factor:number, anchorX:number, anchorY:number, minScale:number, maxScale:number }} ZoomOptions */
/** @typedef {{ id:string, tier?:number, links_to:string[], linked_by:string[] }} GraphNode */
/** @typedef {{ x:number, y:number }} Point */
/** @typedef {{ centerX?:number, centerY?:number, tierRadius?:Record<1|2|3, number> }} LayoutOptions */

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** @param {GraphTransform} transform @param {ZoomOptions} options */
function zoomTransformAtAnchor(transform, options) {
  const { factor, anchorX, anchorY, minScale, maxScale } = options;
  const currentScale = transform.scale;
  const nextScale = clamp(currentScale * factor, minScale, maxScale);

  if (nextScale === currentScale) {
    return { scale: currentScale, tx: transform.tx, ty: transform.ty };
  }

  const ratio = nextScale / currentScale;
  const nextTx = anchorX - (anchorX - transform.tx) * ratio;
  const nextTy = anchorY - (anchorY - transform.ty) * ratio;

  return { scale: nextScale, tx: nextTx, ty: nextTy };
}

/** @param {number} scale @param {number} [base] @param {number} [min] @param {number} [max] */
function computeLabelFontSize(scale, base = 11, min = 8, max = 16) {
  return clamp(base * scale, min, max);
}

/** @param {string} name @param {number} [maxVisibleChars] */
function truncateGraphLabel(name, maxVisibleChars = 25) {
  if (maxVisibleChars <= 0) return '…';
  if (name.length <= maxVisibleChars) return name;
  return `${name.slice(0, maxVisibleChars)}…`;
}

/** @param {number} nodeY @param {number} nodeRadius @param {number} [gap] */
function computeLabelY(nodeY, nodeRadius, gap = 4) {
  return nodeY - nodeRadius - gap;
}

function buildGraphLayerOrder() {
  return ['rings', 'edges', 'nodes', 'labels'];
}

/** @param {number} [_degree] */
function computeNodeCircleRadius(_degree) {
  return 12;
}

/** @param {number} degree */
function computeNodeFillOpacity(degree) {
  return clamp(0.45 + Math.max(0, degree) * 0.08, 0.45, 0.95);
}

/** @param {GraphNode[]} nodes @param {number|null} selectedNodeId */
function buildNeighborhoodFocus(nodes, selectedNodeId) {
  const emptyFocus = {
    active: false,
    centerNodeId: null,
    relatedNodeIds: new Set(),
    incidentEdgeKeys: new Set(),
  };

  if (selectedNodeId == null) return emptyFocus;

  const selectedNode = nodes.find(node => node.id === selectedNodeId);
  if (!selectedNode) return emptyFocus;

  const relatedNodeIds = new Set([selectedNode.id]);
  const incidentEdgeKeys = new Set();

  for (const targetId of selectedNode.links_to ?? []) {
    relatedNodeIds.add(targetId);
    incidentEdgeKeys.add(`${selectedNode.id}->${targetId}`);
  }

  for (const sourceId of selectedNode.linked_by ?? []) {
    relatedNodeIds.add(sourceId);
    incidentEdgeKeys.add(`${sourceId}->${selectedNode.id}`);
  }

  return {
    active: true,
    centerNodeId: selectedNode.id,
    relatedNodeIds,
    incidentEdgeKeys,
  };
}

/** @param {GraphNode[]} nodes @param {LayoutOptions} [options] */
function layoutGraph(nodes, options = {}) {
  const centerX = options.centerX ?? 500;
  const centerY = options.centerY ?? 500;
  const tierRadius = options.tierRadius ?? { 1: 130, 2: 230, 3: 330 };
  /** @type {Record<1|2|3, GraphNode[]>} */
  const byTier = { 1: [], 2: [], 3: [] };

  for (const node of nodes) {
    if (node.tier !== 1 && node.tier !== 2 && node.tier !== 3) {
      throw new Error('Invalid tier: ' + node.tier);
    }
    const tierKey = /** @type {1|2|3} */ (node.tier);
    byTier[tierKey].push(node);
  }

  /** @type {Map<number, any>} */
  const positions = new Map();
  for (const tier of [1, 2, 3]) {
    const tierNodes = byTier[/** @type {1|2|3} */ (tier)];
    if (tierNodes.length === 0) continue;
    placeTierNodes(tierNodes, tierRadius[/** @type {1|2|3} */ (tier)], centerX, centerY, positions);
  }

  return positions;
}

/** @param {GraphNode[]} nodes @param {number} baseRadius @param {number} centerX @param {number} centerY @param {Map<number, Point>} positions */
function placeTierNodes(nodes, baseRadius, centerX, centerY, positions) {
  const sortedNodes = [...nodes].sort((a, b) => a.id - b.id);
  const laneCount = sortedNodes.length > 24 ? 3 : sortedNodes.length > 12 ? 2 : 1;
  const laneSpacing = 18;
  const bucketCount = Math.max(72, sortedNodes.length * 8);
  const occupied = new Uint8Array(bucketCount);

  for (let index = 0; index < sortedNodes.length; index++) {
    const node = sortedNodes[index];
    if (!node) continue;
    const nodeRadius = computeNodeCircleRadius();

    const laneIndex = index % laneCount;
    const laneOffset = (laneIndex - (laneCount - 1) / 2) * laneSpacing;
    const radius = baseRadius + laneOffset + ((node.id % 5) - 2) * 2;
    const baseAngle = ((index / sortedNodes.length) * TWO_PI + seededOffset(node.id)) % TWO_PI;

    const requiredArc = 2 * Math.asin(Math.min(0.92, (nodeRadius + 8) / Math.max(1, radius)));
    const clearance = Math.max(1, Math.ceil((requiredArc / TWO_PI) * bucketCount));
    const angle = resolveFreeAngle(baseAngle, occupied, clearance);

    occupy(occupied, angle, clearance);

    positions.set(node.id, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    });
  }
}

/** @param {number} baseAngle @param {Uint8Array} occupied @param {number} clearance */
function resolveFreeAngle(baseAngle, occupied, clearance) {
  const bucketCount = occupied.length;
  const baseBucket = angleToBucket(baseAngle, bucketCount);

  if (isBucketRangeFree(occupied, baseBucket, clearance)) {
    return bucketToAngle(baseBucket, bucketCount);
  }

  const maxSteps = Math.min(64, Math.floor(bucketCount / 2));
  for (let step = 1; step <= maxSteps; step++) {
    for (const direction of [1, -1]) {
      const candidateBucket = normalizeBucket(baseBucket + direction * step, bucketCount);
      if (!isBucketRangeFree(occupied, candidateBucket, clearance)) continue;
      return bucketToAngle(candidateBucket, bucketCount);
    }
  }

  return bucketToAngle(baseBucket, bucketCount);
}

/** @param {Uint8Array} occupied @param {number} angle @param {number} clearance */
function occupy(occupied, angle, clearance) {
  const bucketCount = occupied.length;
  const bucket = angleToBucket(angle, bucketCount);
  for (let delta = -clearance; delta <= clearance; delta++) {
    occupied[normalizeBucket(bucket + delta, bucketCount)] = 1;
  }
}

/** @param {Uint8Array} occupied @param {number} bucket @param {number} clearance */
function isBucketRangeFree(occupied, bucket, clearance) {
  const bucketCount = occupied.length;
  for (let delta = -clearance; delta <= clearance; delta++) {
    const index = normalizeBucket(bucket + delta, bucketCount);
    if (occupied[index] === 1) return false;
  }
  return true;
}

/** @param {number} bucket @param {number} count */
function normalizeBucket(bucket, count) {
  return ((bucket % count) + count) % count;
}

/** @param {number} angle @param {number} count */
function angleToBucket(angle, count) {
  const normalized = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
  return Math.round((normalized / TWO_PI) * (count - 1));
}

/** @param {number} bucket @param {number} count */
function bucketToAngle(bucket, count) {
  const normalizedBucket = normalizeBucket(bucket, count);
  return (normalizedBucket / count) * TWO_PI;
}

/** @param {number} id */
function seededOffset(id) {
  const value = Math.abs(Math.sin(id * 12.9898) * 43758.5453);
  return (value - Math.floor(value)) * 0.6;
}

export {
  buildGraphLayerOrder,
  buildNeighborhoodFocus,
  computeLabelFontSize,
  computeLabelY,
  computeNodeCircleRadius,
  computeNodeFillOpacity,
  layoutGraph,
  truncateGraphLabel,
  zoomTransformAtAnchor,
};

import { gameContext, gameMap } from "../game";
import { tileKey } from "../scan";

// --- Path graph layer ------------------------------------------------------
// Wraps OpenRCT2's PathNavigator/PathConnection API (added in 0.5.5) so the
// rest of the plugin reasons about the footpath network as a graph instead
// of raw tile adjacency. A PathConnection is only reported by the engine
// when the two tiles are genuinely walkable into one another (it already
// accounts for slopes, height offsets, queue/regular separation and
// banners), which is exactly the information tile-adjacency heuristics used
// to get wrong (e.g. treating a bridge path and the path underneath it as
// connected because they share x/y).

// Default traversal rules used everywhere in this module. Queues and wide
// paths are included because both are legitimate parts of the network for
// at least one caller (entertainer "include queue" areas, mechanic exits
// that sit on a queue); callers that must exclude them (e.g. handyman/guard
// zoning) filter the resulting tiles themselves via `isIncluded`.
export const DEFAULT_PATH_OPTIONS: PathNavigationOptions = {
	includeQueues: true,
	includeWidePaths: true,
};

export interface PathGraphNode {
	x: number;
	y: number;
	z: number;
}

// An undirected graph over footpath tiles: `nodes` holds one entry per
// visited tile (keyed the same way as the rest of the codebase, see
// tileKey), `edges` holds the tile keys each node has a real
// PathConnection to.
export interface PathGraph {
	nodes: Map<string, PathGraphNode>;
	edges: Map<string, string[]>;
}

// Returns every path tile directly reachable from (x, y, z) according to the
// engine, or an empty array if there is no footpath there at all.
export const getConnectedPaths = function getConnectedPaths(
	position: CoordsXYZ,
	options: PathNavigationOptions = DEFAULT_PATH_OPTIONS,
): PathConnection[] {
	const navigator = gameMap().getPathNavigator(
		{ x: position.x * 32, y: position.y * 32, z: position.z },
		options,
	);
	if (!navigator) {
		return [];
	}
	return navigator.getConnectedPaths();
};

// Whether the engine reports a real PathConnection from `from` to `to`. This
// is the graph-based replacement for the old manual baseZ/slope arithmetic:
// it defers entirely to the engine's own notion of walkability instead of
// re-deriving it from tile-element fields.
export const pathTilesConnected = function pathTilesConnected(
	from: CoordsXYZ,
	to: CoordsXY,
	options: PathNavigationOptions = DEFAULT_PATH_OPTIONS,
): boolean {
	const targetKey = tileKey(to.x, to.y);
	for (const connection of getConnectedPaths(from, options)) {
		if (
			tileKey(Math.floor(connection.position.x / 32), Math.floor(connection.position.y / 32)) ===
			targetKey
		) {
			return true;
		}
	}
	return false;
};

// Builds the connected footpath network reachable from `start`, restricted
// to tiles for which `isIncluded` returns true (e.g. park-owned, non-queue
// tiles). Traversal follows real PathConnections rather than plain x/y
// adjacency, so islands separated by height (bridges, cliffs) or missing
// connections are never merged, and tiles unreachable from `start` are
// simply never visited (see findUnreachableTiles below for surfacing that).
export const buildNetwork = function buildNetwork(
	start: PathGraphNode,
	isIncluded: (x: number, y: number) => boolean,
	options: PathNavigationOptions = DEFAULT_PATH_OPTIONS,
): PathGraph {
	const nodes = new Map<string, PathGraphNode>();
	const edges = new Map<string, string[]>();
	const startKey = tileKey(start.x, start.y);
	nodes.set(startKey, start);
	const queue: PathGraphNode[] = [start];
	let head = 0;
	while (head < queue.length) {
		const current = queue[head++];
		const currentKey = tileKey(current.x, current.y);
		const neighbourKeys: string[] = [];
		for (const connection of getConnectedPaths(current, options)) {
			const nx = Math.floor(connection.position.x / 32);
			const ny = Math.floor(connection.position.y / 32);
			if (isIncluded(nx, ny)) {
				const key = tileKey(nx, ny);
				neighbourKeys.push(key);
				if (!nodes.has(key)) {
					const node = { x: nx, y: ny, z: connection.position.z };
					nodes.set(key, node);
					queue.push(node);
				}
			}
		}
		edges.set(currentKey, neighbourKeys);
	}
	return { nodes: nodes, edges: edges };
};

// Unweighted shortest-path distances (in tile hops) from `sourceKey` to every
// node reachable from it within `graph`. Used both to rank staff-to-zone
// assignment by real walking distance and to find a graph-central tile.
export const graphDistances = function graphDistances(
	graph: PathGraph,
	sourceKey: string,
): Map<string, number> {
	const distances = new Map<string, number>();
	if (!graph.nodes.has(sourceKey)) {
		return distances;
	}
	distances.set(sourceKey, 0);
	const queue = [sourceKey];
	let head = 0;
	while (head < queue.length) {
		const key = queue[head++];
		const distance = distances.get(key) ?? 0;
		for (const neighbour of graph.edges.get(key) ?? []) {
			if (!distances.has(neighbour)) {
				distances.set(neighbour, distance + 1);
				queue.push(neighbour);
			}
		}
	}
	return distances;
};

// The graph-hop distance between two nodes, or Infinity if `toKey` is not
// reachable from `fromKey` within the graph.
export const graphDistance = function graphDistance(
	graph: PathGraph,
	fromKey: string,
	toKey: string,
): number {
	return graphDistances(graph, fromKey).get(toKey) ?? Infinity;
};

// Splits every node of `graph` into `zoneCount` connected groups of roughly
// equal size, by growing regions along real graph edges (a multi-source BFS
// "Voronoi" from a spread-out set of seed tiles) rather than bucketing tiles
// by geometric position. Every returned zone is therefore guaranteed to be
// walkable in one piece; unreachable tiles are never included since they are
// never part of `graph` in the first place (see buildNetwork).
export const splitIntoZones = function splitIntoZones(
	graph: PathGraph,
	zoneCount: number,
): string[][] {
	const keys = [...graph.nodes.keys()];
	if (1 >= zoneCount || 0 === keys.length) {
		if (0 === keys.length) {
			return [];
		}
		return [keys];
	}

	// Farthest-point sampling: repeatedly pick the node with the largest
	// minimum graph distance to the seeds picked so far, so seeds start out
	// spread across the whole network instead of clumped in one corner.
	const seeds: string[] = [keys[0]];
	while (seeds.length < zoneCount && seeds.length < keys.length) {
		let bestKey = keys[0];
		let bestMinDistance = -1;
		for (const key of keys) {
			let minDistance = Infinity;
			for (const seed of seeds) {
				const distance = graphDistance(graph, seed, key);
				if (distance < minDistance) {
					minDistance = distance;
				}
			}
			if (minDistance > bestMinDistance) {
				bestMinDistance = minDistance;
				bestKey = key;
			}
		}
		seeds.push(bestKey);
	}

	// Multi-source BFS: every node ends up in the zone of whichever seed
	// reaches it first, which keeps each zone a single connected region.
	const zoneOfKey = new Map<string, number>();
	const queue: string[] = [];
	for (let i = 0; i < seeds.length; i++) {
		zoneOfKey.set(seeds[i], i);
		queue.push(seeds[i]);
	}
	let head = 0;
	while (head < queue.length) {
		const key = queue[head++];
		const zone = zoneOfKey.get(key) ?? 0;
		for (const neighbour of graph.edges.get(key) ?? []) {
			if (!zoneOfKey.has(neighbour)) {
				zoneOfKey.set(neighbour, zone);
				queue.push(neighbour);
			}
		}
	}

	const zones: string[][] = seeds.map(function emptyZone() {
		return [];
	});
	for (const entry of zoneOfKey) {
		zones[entry[1]].push(entry[0]);
	}
	return zones;
};

// Finds the index of the zone closest to `fromKey` by real graph distance
// (BFS over PathConnections), skipping zones that are unreachable from the
// starting tile entirely. Returns -1 if none of the zones are reachable.
export const nearestZoneIndex = function nearestZoneIndex(
	graph: PathGraph,
	fromKey: string,
	zones: string[][],
): number {
	const distances = graphDistances(graph, fromKey);
	let bestIndex = -1;
	let bestDistance = Infinity;
	for (let i = 0; i < zones.length; i++) {
		for (const key of zones[i]) {
			const distance = distances.get(key);
			if (distance !== undefined && distance < bestDistance) {
				bestDistance = distance;
				bestIndex = i;
			}
		}
	}
	return bestIndex;
};

// The tile key of `start` if it is already a node of `graph`, otherwise the
// key of the closest node in `graph` by graph distance from a small BFS seeded
// at `start`'s raw neighbours. Used to snap a staff member who is standing on
// a tile outside the scanned network (e.g. mid-teleport) onto the nearest
// reachable node before measuring zone distance.
export const snapToNetwork = function snapToNetwork(
	graph: PathGraph,
	start: PathGraphNode,
	options: PathNavigationOptions = DEFAULT_PATH_OPTIONS,
): string | undefined {
	const startKey = tileKey(start.x, start.y);
	if (graph.nodes.has(startKey)) {
		return startKey;
	}
	for (const connection of getConnectedPaths(start, options)) {
		const key = tileKey(
			Math.floor(connection.position.x / 32),
			Math.floor(connection.position.y / 32),
		);
		if (graph.nodes.has(key)) {
			return key;
		}
	}
	return undefined;
};

// The most graph-central node among `keys`
// hop distance to every other tile in the set), used to place staff "in the
// middle" of their zone instead of at its geometric centroid, which can fall
// on an unreachable or off-network tile for an L-shaped or branching zone.
export const centralTile = function centralTile(
	graph: PathGraph,
	keys: string[],
): string | undefined {
	if (0 === keys.length) {
		return undefined;
	}
	let bestKey = keys[0];
	let bestMaxDistance = Infinity;
	for (const candidate of keys) {
		const distances = graphDistances(graph, candidate);
		let maxDistance = 0;
		for (const key of keys) {
			const distance = distances.get(key) ?? Infinity;
			if (distance > maxDistance) {
				maxDistance = distance;
			}
		}
		if (maxDistance < bestMaxDistance) {
			bestMaxDistance = maxDistance;
			bestKey = candidate;
		}
	}
	return bestKey;
};

// Finds the footpath tile a ride exit leads onto by asking the engine for a
// PathNavigator at each candidate tile in turn (preferred direction first),
// instead of manually probing for a footpath tile element. This lets the
// engine's own connectivity rules (height, slope) decide whether a
// candidate is really the path in front of the exit, so it works across
// slopes/height offsets that a plain "is there a footpath here" check
// cannot distinguish from an unrelated path at a different level.
export const exitToPathTile = function exitToPathTile(
	exitTile: CoordsXYZ,
	orderedOffsets: CoordsXY[],
	options: PathNavigationOptions = DEFAULT_PATH_OPTIONS,
): PathGraphNode | undefined {
	for (const offset of orderedOffsets) {
		const candidateX = exitTile.x + offset.x;
		const candidateY = exitTile.y + offset.y;
		const navigator = gameMap().getPathNavigator(
			{ x: candidateX * 32, y: candidateY * 32, z: exitTile.z },
			options,
		);
		if (navigator) {
			return { x: candidateX, y: candidateY, z: navigator.current.position.z };
		}
	}
	return undefined;
};

// --- Cache -----------------------------------------------------------------
// Building the network can require one PathNavigator query per tile, which
// is too expensive to redo on every zoning/assignment/mechanic-detection
// call. The graph is built once per invalidation and reused for all of them
// within that window; it is invalidated lazily (nulled out, rebuilt on next
// use) rather than rebuilt eagerly, so a burst of path edits only costs one
// rebuild when the graph is actually queried again.
let cachedGraph: PathGraph | undefined = undefined;
let invalidationSubscription: IDisposable | undefined = undefined;

// Game actions that can change the footpath graph's shape: placing/removing
// paths changes edges directly, additions (banners) change which edges are
// permitted once respectBanners is used, and land rights changes can move a
// tile in or out of the "park-owned" filter passed to buildNetwork.
const GRAPH_INVALIDATING_ACTIONS = new Set<string>([
	"footpathplace",
	"footpathremove",
	"footpathadditionplace",
	"footpathadditionremove",
	"bannerplace",
	"bannerremove",
	"landsetrights",
]);

export const invalidatePathGraphCache = function invalidatePathGraphCache(): void {
	cachedGraph = undefined;
};

const ensureInvalidationSubscribed = function ensureInvalidationSubscribed(): void {
	if (invalidationSubscription) {
		return;
	}
	invalidationSubscription = gameContext().subscribe(
		"action.execute",
		function onActionExecute(event: GameActionEventArgs) {
			if (GRAPH_INVALIDATING_ACTIONS.has(event.action)) {
				invalidatePathGraphCache();
			}
		},
	);
};

// Test seam only: lets tests reset the module's cache/subscription between
// runs without needing a real game context.
export const resetPathGraphCacheForTests = function resetPathGraphCacheForTests(): void {
	cachedGraph = undefined;
	invalidationSubscription = undefined;
};

// Returns the cached network rooted at `start`, building (and subscribing to
// invalidating actions) it on first use or after the cache was invalidated.
export const getCachedNetwork = function getCachedNetwork(
	start: PathGraphNode,
	isIncluded: (x: number, y: number) => boolean,
	options: PathNavigationOptions = DEFAULT_PATH_OPTIONS,
): PathGraph {
	ensureInvalidationSubscribed();
	cachedGraph ??= buildNetwork(start, isIncluded, options);
	return cachedGraph;
};

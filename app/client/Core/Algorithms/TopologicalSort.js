/**
 * @fileoverview Implements Kahn's algorithm for topological sorting.
 * This utility is used by the SystemManager to determine the execution order of systems
 * based on their dependencies, allowing for parallel execution where possible.
 */

/**
 * Performs a topological sort on a directed graph to find a linear ordering of its nodes.
 * This implementation of Kahn's algorithm also groups nodes into stages that can be executed in parallel.
 * The function is generic and works with any graph represented as an adjacency list.
 *
 * @template T - The type of the nodes in the graph.
 * @param {Map<T, Set<T> | T[]>} graph - An adjacency list representation of the graph, where each key is a node
 *   and its value is an iterable (Set or Array) of its successor nodes (outgoing edges).
 * @returns {{stages: Array<T[]>, hasCycle: boolean, cycleNodes: T[]}} An object containing the sorted stages,
 *   a flag indicating if a cycle was detected, and an array of nodes involved in the cycle.
 */
export function topologicalSort(graph) {
	const inDegree = new Map()
	const allNodes = new Set(graph.keys())

	// Discover nodes that only appear as dependencies (i.e., have no outgoing edges)
	for (const neighbors of graph.values()) {
		for (const neighbor of neighbors) {
			allNodes.add(neighbor)
		}
	}

	// Initialize in-degree for all nodes to 0
	for (const node of allNodes) {
		inDegree.set(node, 0)
	}

	// Calculate the actual in-degree for each node
	for (const neighbors of graph.values()) {
		for (const neighbor of neighbors) {
			inDegree.set(neighbor, inDegree.get(neighbor) + 1)
		}
	}

	const queue = []
	for (const [node, degree] of inDegree.entries()) {
		if (degree === 0) {
			queue.push(node)
		}
	}

	const executionStages = []
	let processedCount = 0
	while (queue.length > 0) {
		const stage = queue.splice(0, queue.length) // Process the entire current queue as one stage
		executionStages.push(stage) // Add the parallel stage to the results

		for (const nodeItem of stage) {
			processedCount++
			const neighbors = graph.get(nodeItem) || []
			for (const neighbor of neighbors) {
				const newDegree = inDegree.get(neighbor) - 1
				inDegree.set(neighbor, newDegree)
				if (newDegree === 0) {
					queue.push(neighbor)
				}
			}
		}
	}

	const hasCycle = processedCount !== allNodes.size
	let cycleNodes = []
	if (hasCycle) {
		cycleNodes = Array.from(inDegree.entries())
			.filter(([, degree]) => degree > 0)
			.map(([node]) => node)
	}

	return { stages: executionStages, hasCycle, cycleNodes }
}
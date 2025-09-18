const { testManager } = await import(`${PATH_MANAGERS}/TestManager/TestManager.js`)
const { describe, it, expect } = await import(`${PATH_MANAGERS}/TestManager/TestAPI.js`)

const { topologicalSort } = await import(`${PATH_CORE}/Algorithms/TopologicalSort.js`)

/**
 * A system dedicated to testing the functionality of the topologicalSort utility.
 * It runs a suite of self-contained tests for various graph structures.
 */
export class TopologicalSortTestSystem {
	constructor() {}

	async init() {
		describe('Topological Sort (Kahn`s Algorithm)', () => {
			it('should correctly sort a simple linear graph', () => {
				const graph = new Map([
					['A', ['B']],
					['B', ['C']],
				])
				const { stages, hasCycle } = topologicalSort(graph)

				expect(hasCycle).toBe(false)
				expect(stages).toEqual([['A'], ['B'], ['C']])
			})

			it('should handle parallel branches correctly', () => {
				const graph = new Map([
					['A', ['C']],
					['B', ['C']],
					['C', ['D']],
				])
				const { stages, hasCycle } = topologicalSort(graph)

				expect(hasCycle).toBe(false)
				// A and B can run in parallel
				expect(stages.length).toBe(3)
				expect(stages[0].sort()).toEqual(['A', 'B'])
				expect(stages[1]).toEqual(['C'])
				expect(stages[2]).toEqual(['D'])
			})

			it('should correctly sort a complex diamond graph', () => {
				const graph = new Map([
					['A', ['B', 'C']],
					['B', ['D']],
					['C', ['D']],
					['D', ['E']],
				])
				const { stages, hasCycle } = topologicalSort(graph)

				expect(hasCycle).toBe(false)
				expect(stages.length).toBe(4)
				expect(stages[0]).toEqual(['A'])
				expect(stages[1].sort()).toEqual(['B', 'C'])
				expect(stages[2]).toEqual(['D'])
				expect(stages[3]).toEqual(['E'])
			})

			it('should handle disconnected components', () => {
				const graph = new Map([
					['A', ['B']], // Component 1
					['X', ['Y']], // Component 2
				])
				const { stages, hasCycle } = topologicalSort(graph)

				expect(hasCycle).toBe(false)
				expect(stages.length).toBe(2)
				// Stage 1 should contain both independent starting nodes
				expect(stages[0].sort()).toEqual(['A', 'X'])
				// Stage 2 should contain their respective dependencies
				expect(stages[1].sort()).toEqual(['B', 'Y'])
			})

			it('should detect a simple direct cycle', () => {
				const graph = new Map([
					['A', ['B']],
					['B', ['A']],
				])
				const { stages, hasCycle, cycleNodes } = topologicalSort(graph)

				expect(hasCycle).toBe(true)
				expect(stages.length).toBe(0) // No valid stages can be formed
				expect(cycleNodes.sort()).toEqual(['A', 'B'])
			})

			it('should detect a longer, more complex cycle', () => {
				const graph = new Map([
					['A', ['B']],
					['B', ['C']],
					['C', ['D']],
					['D', ['B']], // D depends on B, creating a B -> C -> D -> B cycle
					['E', ['A']],
				])
				const { stages, hasCycle, cycleNodes } = topologicalSort(graph)

				expect(hasCycle).toBe(true)
				// E can run, then A can run, but the cycle prevents further progress.
				expect(stages).toEqual([['E'], ['A']])
				expect(cycleNodes.sort()).toEqual(['B', 'C', 'D'])
			})

			it('should handle a node that is only a dependency', () => {
				const graph = new Map([['A', ['B']]]) // B is never a key
				const { stages, hasCycle } = topologicalSort(graph)

				expect(hasCycle).toBe(false)
				expect(stages).toEqual([['A'], ['B']])
			})

			it('should handle an empty graph', () => {
				const graph = new Map()
				const { stages, hasCycle, cycleNodes } = topologicalSort(graph)

				expect(hasCycle).toBe(false)
				expect(stages).toEqual([])
				expect(cycleNodes).toEqual([])
			})

			it('should handle a graph with no edges', () => {
				const graph = new Map([
					['A', []],
					['B', []],
					['C', []],
				])
				const { stages, hasCycle } = topologicalSort(graph)

				expect(hasCycle).toBe(false)
				expect(stages.length).toBe(1)
				expect(stages[0].sort()).toEqual(['A', 'B', 'C'])
			})
		})

		// Run all the defined tests.
		testManager.runAllTests()
	}
}
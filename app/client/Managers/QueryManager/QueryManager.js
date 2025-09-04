const { Query } = await import(`${PATH_MANAGERS}/QueryManager/Query.js`)
const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)

class QueryManager {
	constructor() {
		this._activeQueries = []
        this.nextQueryId = 0
        this.queriesById = new Map()
	}

	async init() {
		this.componentManager = theManager.getManager('ComponentManager')
		this.archetypeManager = theManager.getManager('ArchetypeManager')
	}

	getQuery({ with: required = [], without = [], any = [], react = [] }) {
		try {
            const queryId = this.nextQueryId++;
			const newQuery = new Query(
                queryId,
				this,
				this.componentManager,
				this.archetypeManager,
				required,
				without,
				any,
				react
			)

			this._activeQueries.push(newQuery)
            this.queriesById.set(queryId, newQuery);

			for (const archetypeId of this.archetypeManager.archetypeLookup.values()) {
				newQuery.registerArchetype(archetypeId)
			}
			return newQuery
		} catch (error) {
			console.error(`QueryManager: Error creating query:`, error)
			return undefined
		}
	}

    getQueryById(id) {
        return this.queriesById.get(id);
    }

	registerArchetype(newArchetypeId) {
		for (const query of this._activeQueries) {
			query.registerArchetype(newArchetypeId)
		}
	}

	unregisterArchetype(deletedArchetypeId) {
		for (const query of this._activeQueries) {
			query.unregisterArchetype(deletedArchetypeId)
		}
	}

	destroyQuery(queryToDestroy) {
		const index = this._activeQueries.indexOf(queryToDestroy)
		if (index > -1) {
			this._activeQueries.splice(index, 1)
		}
        this.queriesById.delete(queryToDestroy.id);
	}
}

export const queryManager = new QueryManager()
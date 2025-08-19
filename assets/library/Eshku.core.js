const map = (value, in_min, in_max, out_min, out_max) =>
	((value - in_min) * (out_max - out_min)) / (in_max - in_min) + out_min

const getAllObjectProperties = (object, ignoreInternal = false) => {
	const properties = Object.getOwnPropertyNames(Object.getPrototypeOf(object))
	if (ignoreInternal) {
		const filteredProperties = properties.filter(prop => !prop.startsWith('_'))
		return filteredProperties
	} else {
		return properties
	}
}


/**
 * Checks for conflicting methods and properties between two objects.
 *
 * @param {object} obj1 - The first object to compare.
 * @param {object} obj2 - The second object to compare.
 * @param {boolean} [checkPrototypes=true] - Whether to check the prototypes of the objects.
 * @returns {object} - An object containing lists of conflicting and unique properties.
 */
function findPropertyConflicts(obj1, obj2, checkPrototypes = true) {
	if (typeof obj1 !== 'object' || obj1 === null || typeof obj2 !== 'object' || obj2 === null) {
	  throw new Error('Both arguments must be non-null objects.');
	}
  
	const conflicts = {
	  common: [], // Properties present in both objects with the same name
	  uniqueToObj1: [], // Properties unique to obj1
	  uniqueToObj2: [], // Properties unique to obj2
	};
  
	const obj1Props = new Set();
	const obj2Props = new Set();
  
	// Helper function to collect properties, optionally including prototype chain
	function collectProperties(obj, propSet) {
	  let currentObj = obj;
	  while (currentObj) {
		const props = Object.getOwnPropertyNames(currentObj);
		props.forEach(prop => propSet.add(prop));
		if (!checkPrototypes) break;
		currentObj = Object.getPrototypeOf(currentObj);
	  }
	}
  
	collectProperties(obj1, obj1Props);
	collectProperties(obj2, obj2Props);
  
	// Find common and unique properties
	obj1Props.forEach(prop => {
	  if (obj2Props.has(prop)) {
		conflicts.common.push(prop);
	  } else {
		conflicts.uniqueToObj1.push(prop);
	  }
	});
  
	obj2Props.forEach(prop => {
	  if (!obj1Props.has(prop)) {
		conflicts.uniqueToObj2.push(prop);
	  }
	});
  
	return conflicts;
  }
  
  /**
   * Checks for conflicting methods and properties between two objects, and logs the results.
   *
   * @param {object} obj1 - The first object to compare.
   * @param {object} obj2 - The second object to compare.
   * @param {string} name1 - The name of the first object (for logging).
   * @param {string} name2 - The name of the second object (for logging).
   * @param {boolean} [checkPrototypes=true] - Whether to check the prototypes of the objects.
   */
  function analyzeObjectConflicts(obj1, obj2, name1, name2, checkPrototypes = true) {
	try {
	  const conflictData = findPropertyConflicts(obj1, obj2, checkPrototypes);
  
	  console.log(`\n--- Conflicts between ${name1} and ${name2} ---`);
  
	  if (conflictData.common.length > 0) {
		console.warn(`Common properties (potential conflicts) between ${name1} and ${name2}:`);
		conflictData.common.forEach(prop => console.warn(`  - ${prop}`));
	  } else {
		console.log(`No common properties found between ${name1} and ${name2}.`);
	  }
  
	  if (conflictData.uniqueToObj1.length > 0) {
		console.log(`Properties unique to ${name1}:`);
		conflictData.uniqueToObj1.forEach(prop => console.log(`  - ${prop}`));
	  } else {
		console.log(`No unique properties found in ${name1}.`);
	  }
  
	  if (conflictData.uniqueToObj2.length > 0) {
		console.log(`Properties unique to ${name2}:`);
		conflictData.uniqueToObj2.forEach(prop => console.log(`  - ${prop}`));
	  } else {
		console.log(`No unique properties found in ${name2}.`);
	  }
	} catch (error) {
	  console.error('Error during conflict analysis:', error);
	}
  }
 
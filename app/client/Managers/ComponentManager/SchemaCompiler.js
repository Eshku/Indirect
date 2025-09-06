/**
 * @fileoverview Compiles a component's static schema into a "program" (an instruction list).
 * This is the "Compiler" phase of the Interpreter pattern. It runs once per component type
 * at registration time.
 */

export const Opcodes = Object.freeze({
	PROCESS_ENUM: 'enum',
	PROCESS_BITMASK: 'bitmask',
	PROCESS_STRING: 'string',
	PROCESS_FLAT_ARRAY: 'flat_array',
	PROCESS_RPN: 'rpn',
});

export class SchemaCompiler {
	/**
	 * Compiles a component's schema into a list of processing instructions.
	 * @param {object} componentInfo - The parsed schema info from SchemaParser.
	 * @returns {Array<object>|null} An array of instruction objects, or null if no processing is needed.
	 */
	compile(componentInfo) {
		const instructions = [];

		// The `representations` object from SchemaParser is the source of truth.
		for (const propName in componentInfo.representations) {
			const rep = componentInfo.representations[propName];
			if (!rep.type) continue;

			// We only create instructions for types that require runtime processing
			// of "designer-friendly" data into "engine-friendly" data.
			switch (rep.type) {
				case Opcodes.PROCESS_ENUM:
					instructions.push({ op: Opcodes.PROCESS_ENUM, prop: propName, values: rep.values });
					break;
				case Opcodes.PROCESS_BITMASK:
					instructions.push({ op: Opcodes.PROCESS_BITMASK, prop: propName, values: rep.values });
					break;
				case Opcodes.PROCESS_STRING:
					instructions.push({ op: Opcodes.PROCESS_STRING, prop: propName });
					break;
				case Opcodes.PROCESS_FLAT_ARRAY:
					instructions.push({
						op: Opcodes.PROCESS_FLAT_ARRAY,
						prop: propName,
						schema: rep, // Pass whole representation schema for the interpreter
					});
					break;
				case Opcodes.PROCESS_RPN:
					instructions.push({
						op: Opcodes.PROCESS_RPN,
						prop: propName,
						schema: rep,
					});
					break;
			}
		}

		return instructions.length > 0 ? instructions : null;
	}
}
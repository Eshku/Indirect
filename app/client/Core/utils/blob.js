/**
 * Creates a temporary, revokable URL from a string of code.
 * This is useful for creating web workers or importing modules from in-memory code.
 *
 * **Note:** The caller is responsible for calling `URL.revokeObjectURL()` on the returned
 * URL when it is no longer needed to prevent memory leaks.
 *
 * @param {string} codeString The JavaScript code.
 * @returns {string} A temporary object URL.
 */
export function createURLFromString(codeString) {
	const blob = new Blob([codeString], { type: 'application/javascript' });
	return URL.createObjectURL(blob);
}

/**
 * Dynamically imports a JavaScript module from a string of code.
 *
 * This utility solves the problem of executing a raw string of code as a modern ES Module.
 * It works by creating a temporary in-memory "file" (a Blob) and generating a URL for it.
 * This URL can then be passed to the standard dynamic `import()` function.
 * This function automatically handles the creation and revocation of the temporary URL.
 *
 * This is essential for features like Hot Module Replacement (HMR).
 *
 * @param {string} codeString The JavaScript code to import.
 * @returns {Promise<object>} A promise that resolves to the module's namespace object.
 */
export async function importFromString(codeString) {
	const url = createURLFromString(codeString);
	try {
		return await import(url);
	} finally {
		URL.revokeObjectURL(url); // Clean up the temporary URL to prevent memory leaks.
	}
}
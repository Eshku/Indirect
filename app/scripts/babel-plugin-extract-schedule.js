/**
 * A custom Babel plugin to extract `schedule` method from a system class,
 * analyze its `this` dependencies, and rewrite it as a standalone function.
 */
export default function ({ types: t }) {
    return {
        visitor: {
            Program(programPath, state) {
                let classPath = null;
                let scheduleMethod = null;
                let systemName = '';

                // Find exported class that has a schedule method.
                programPath.traverse({
                    Class(path) {
                        // We only care about top-level classes.
                        if (t.isExportNamedDeclaration(path.parent) || t.isExportDefaultDeclaration(path.parent)) {
                            path.get('body').traverse({
                                ClassMethod(methodPath) {
                                    if (methodPath.node.key.name === 'schedule') {
                                        classPath = path;
                                        scheduleMethod = methodPath;
                                        systemName = path.node.id.name;
                                    }
                                }
                            });
                        }
                    }
                });

                if (!classPath || !scheduleMethod) return;

                const dependencies = new Set();

                // 1. Analyze dependencies within schedule method and rewrite `this` to `context`.
                scheduleMethod.traverse({
                    MemberExpression(memberPath) {
                        if (t.isThisExpression(memberPath.node.object)) {
                            const propName = memberPath.node.property.name;
                            dependencies.add(propName);
                            memberPath.get('object').replaceWith(t.identifier('context'));
                        }
                    }
                });

                // 2. Create a new standalone function declaration from schedule method's contents.
                const newFunction = t.functionDeclaration(
                    t.identifier('schedule'),
                    scheduleMethod.node.params,
                    scheduleMethod.node.body,
                    scheduleMethod.node.generator,
                    scheduleMethod.node.async
                );

                // 3. Create an export declaration for new function.
                const exportStatement = t.exportNamedDeclaration(newFunction, []);

                // 4. Create a new Program node that contains ONLY our new export statement.
                // This effectively discards all original imports and other code.
                const newProgram = t.program([exportStatement]);

                // 5. Replace entire original program with our new, clean one.
                programPath.replaceWith(newProgram);

                // 6. Store metadata for main transpile script to use.
                state.file.metadata.isParallel = true; // Flag that this system has a schedule method
                state.file.metadata.systemName = systemName; // name of system class
                state.file.metadata.dependencies = Array.from(dependencies); // collected dependencies
            }
        }
    };
}
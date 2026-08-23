import { defineRule } from "@oxlint/plugins";

import {
	collectTypeEnvironment,
	resolveHazardousType,
	typeParameterBindings,
} from "../shared/lexical-type-parameters.ts";

/** Ban named aliases proven to conceal unknown. */
export const noUnknownTypeAliasesRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow type aliases whose locally resolved type exposes unknown.",
		},
		messages: {
			unknownAlias:
				"Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
		},
	},
	createOnce(context) {
		return {
			Program(node) {
				const environment = collectTypeEnvironment(node);
				for (const alias of environment.aliases.values()) {
					const resolution = resolveHazardousType(
						alias.typeAnnotation,
						"unknown",
						environment,
						typeParameterBindings(alias.typeParameters),
					);
					if (resolution !== "hazard") continue;
					context.report({
						node: alias.id,
						messageId: "unknownAlias",
						data: { alias: alias.id.name },
					});
				}
			},
		};
	},
});

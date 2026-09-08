import * as vscode from "vscode";
import type { ThinkingEffort } from "../converters/request";
import { THINKING_EFFORTS, describeEffort } from "../thinking-variants";
import { ConfigurationService } from "../services/configuration.service";

export const SELECT_THINKING_EFFORT_COMMAND = "bedrock.selectThinkingEffort";

interface EffortItem extends vscode.QuickPickItem {
	/** The level to apply, or "off" to disable thinking entirely. */
	value?: ThinkingEffort | "off";
	/** Set on the entry that toggles the model-picker variants instead. */
	toggleVariants?: boolean;
}

/**
 * Quick pick for the global reasoning-effort default, opened from the status bar.
 *
 * Writes the same two settings the settings page exposes rather than keeping its
 * own copy of the state, so the status bar, the settings editor and the request
 * builder can never disagree about the current default.
 */
export async function selectThinkingEffort(configService: ConfigurationService): Promise<void> {
	const enabled = configService.isThinkingEnabled();
	const current: ThinkingEffort | "off" = enabled ? configService.getThinkingEffort() : "off";
	const variantsShown = configService.showEffortVariants();
	const tick = new vscode.ThemeIcon("check");

	const items: EffortItem[] = [
		{
			label: "off",
			description: "no reasoning — fastest and cheapest",
			value: "off",
			iconPath: current === "off" ? tick : undefined,
		},
		...THINKING_EFFORTS.map((effort) => ({
			label: effort,
			description: describeEffort(effort),
			value: effort,
			iconPath: current === effort ? tick : undefined,
		})),
		{ label: "", kind: vscode.QuickPickItemKind.Separator },
		{
			label: "Show effort variants in the model picker",
			description: variantsShown ? "on — click to turn off" : "off — click to turn on",
			detail: "Adds a per-effort entry for each reasoning model, so effort can be set per conversation.",
			toggleVariants: true,
			iconPath: variantsShown ? tick : undefined,
		},
	];

	const pick = await vscode.window.showQuickPick(items, {
		title: "Bedrock: thinking effort",
		// The token budget shown against each level only applies to the older
		// budget-based API; say so here rather than repeating it on every row.
		placeHolder:
			"Claude 4.6 and newer choose their own budget from the level; " +
			"Claude 3.7–4.5 get the budget shown",
	});

	if (!pick) {
		return;
	}

	if (pick.toggleVariants) {
		await configService.setShowEffortVariants(!variantsShown);
		return;
	}

	if (pick.value === "off") {
		await configService.setThinkingDefault(false);
		return;
	}

	if (pick.value) {
		await configService.setThinkingDefault(true, pick.value);
	}
}

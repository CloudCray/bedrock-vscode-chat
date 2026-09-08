import * as vscode from "vscode";
import { ConfigurationService } from "./services/configuration.service";
import { SELECT_THINKING_EFFORT_COMMAND } from "./commands/select-thinking-effort";

/**
 * Status bar item showing, and letting you change, the global reasoning-effort
 * default.
 *
 * Deliberately not gated behind a setting of its own. VS Code already lets a
 * user hide any status bar item from its right-click menu, and an item with an
 * `id` and a `name` has that choice remembered — a bespoke
 * `showStatusBarItem` setting would only duplicate a native affordance.
 */
export class ThinkingStatusBar {
	private readonly item: vscode.StatusBarItem;

	constructor(private readonly configService: ConfigurationService) {
		this.item = vscode.window.createStatusBarItem(
			"bedrock.thinkingEffort",
			vscode.StatusBarAlignment.Right,
			100
		);
		this.item.name = "Bedrock Thinking Effort";
		this.item.command = SELECT_THINKING_EFFORT_COMMAND;
		this.refresh();
		this.item.show();
	}

	/** Re-read the settings this item reflects. Called on configuration change. */
	refresh(): void {
		const enabled = this.configService.isThinkingEnabled();
		const effort = this.configService.getThinkingEffort();

		this.item.text = enabled
			? `$(lightbulb) Bedrock: think ${effort}`
			: `$(lightbulb-empty) Bedrock: think off`;

		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(
			enabled
				? `Bedrock extended thinking is **on** at **${effort}** effort.\n\n`
				: `Bedrock extended thinking is **off**.\n\n`
		);
		tooltip.appendMarkdown(
			"This is the default for every conversation. A model picked as " +
				"`· think <level>` in the chat window overrides it for that conversation.\n\n" +
				"Click to change."
		);
		this.item.tooltip = tooltip;
	}

	dispose(): void {
		this.item.dispose();
	}
}

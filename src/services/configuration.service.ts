import * as vscode from "vscode";
import type { AuthMethod, ManualModel } from "../types";
import type { ThinkingEffort } from "../converters/request";
import type { ThinkingDisplay } from "../thinking";

/**
 * Centralized configuration management for Bedrock extension.
 * All VS Code settings access should go through this service.
 */
export class ConfigurationService {
	private readonly configSection = 'languageModelChatProvider.bedrock';

	/**
	 * Get the AWS region from configuration
	 */
	getRegion(): string {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('region') ?? "us-east-1";
	}

	/**
	 * Get the authentication method from configuration
	 */
	getAuthMethod(): AuthMethod {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<AuthMethod>('authMethod') ?? 'default';
	}

	/**
	 * Get API key from configuration (if using api-key auth)
	 */
	getApiKey(): string | undefined {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('apiKey');
	}

	/**
	 * Get AWS profile name from configuration (if using profile auth)
	 */
	getProfile(): string | undefined {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('profile');
	}

	/**
	 * Get AWS access key ID from configuration (if using access-keys auth)
	 */
	getAccessKeyId(): string | undefined {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('accessKeyId');
	}

	/**
	 * Get AWS secret access key from configuration (if using access-keys auth)
	 */
	getSecretAccessKey(): string | undefined {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('secretAccessKey');
	}

	/**
	 * Get AWS session token from configuration (if using access-keys auth with temp credentials)
	 */
	getSessionToken(): string | undefined {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<string>('sessionToken');
	}

	/**
	 * Get user-provided inference profile overrides.
	 * Maps bare model IDs (e.g. "anthropic.claude-sonnet-4-6") to
	 * full inference profile ARNs or IDs to use at invocation time.
	 */
	getInferenceProfileOverrides(): Record<string, string> {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<Record<string, string>>('inferenceProfileOverrides') ?? {};
	}
	/**
	 * Get manually-declared models. Used as a fallback when model listing is
	 * unavailable (e.g. SCP denies bedrock:ListFoundationModels) or to pin an
	 * explicit model set.
	 */
	getManualModels(): ManualModel[] {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<ManualModel[]>('manualModels') ?? [];
	}

	/**
	 * Whether extended thinking should be requested from models that support it.
	 */
	isThinkingEnabled(): boolean {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<boolean>('thinking.enabled') ?? false;
	}

	/**
	 * Reasoning effort for models on the adaptive thinking API, and the basis for
	 * the token budget on older models.
	 */
	getThinkingEffort(): ThinkingEffort {
		const config = vscode.workspace.getConfiguration(this.configSection);
		const value = config.get<string>('thinking.effort') ?? 'medium';
		return isThinkingEffort(value) ? value : 'medium';
	}

	/**
	 * Explicit token budget for models on the legacy thinking API.
	 * 0 means "derive it from the effort level".
	 */
	getThinkingBudgetTokens(): number {
		const config = vscode.workspace.getConfiguration(this.configSection);
		const value = config.get<number>('thinking.budgetTokens') ?? 0;
		return value > 0 ? Math.max(1024, value) : 0;
	}

	/**
	 * How reasoning output should be displayed.
	 */
	getThinkingDisplay(): ThinkingDisplay {
		const config = vscode.workspace.getConfiguration(this.configSection);
		const value = config.get<string>('thinking.display') ?? 'native';
		return value === 'hidden' || value === 'native' || value === 'text' ? value : 'native';
	}

	/**
	 * Whether to insert Bedrock prompt-cache checkpoints into requests.
	 */
	isPromptCachingEnabled(): boolean {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<boolean>('promptCaching.enabled') ?? true;
	}

	/**
	 * User cap on output tokens per response. 0 means "use the model's maximum",
	 * which is the default: a low cap truncates large tool calls mid-JSON.
	 */
	getMaxOutputTokens(): number {
		const config = vscode.workspace.getConfiguration(this.configSection);
		const value = config.get<number>('maxOutputTokens') ?? 0;
		return value > 0 ? value : 0;
	}

	/**
	 * Whether to ask Bedrock to count input tokens before sending. Accurate but
	 * costs an extra API round trip per turn.
	 */
	isNativeTokenCountingEnabled(): boolean {
		const config = vscode.workspace.getConfiguration(this.configSection);
		return config.get<boolean>('nativeTokenCounting') ?? true;
	}
}

function isThinkingEffort(value: string): value is ThinkingEffort {
	return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';
}

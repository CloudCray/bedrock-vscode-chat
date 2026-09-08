/**
 * Live feature test for the INSTALLED bedrock-vscode-chat extension.
 *
 * Loads the extension's own compiled modules out of the installed extension
 * directory (not the repo build) and drives them against real Bedrock, so what
 * is verified is the artifact that VS Code will actually run.
 *
 * A tiny `vscode` stub is injected because tool-buffer/stream-processor/logger
 * require it at runtime for the response-part classes and the output channel.
 */
const Module = require("node:module");
const path = require("node:path");
const assert = require("node:assert");

// Defaults to this repo's own build. Point EXT_DIR at an installed extension
// directory to verify the artifact VS Code actually loaded, e.g.
//   EXT_DIR=~/.vscode-server/extensions/arifum.bedrock-vscode-chat-0.0.6
const EXT = process.env.EXT_DIR || path.resolve(__dirname, "..");
const OUT = path.join(EXT, "out");

if (!require("node:fs").existsSync(OUT)) {
	console.error(`No compiled output at ${OUT}. Run \`npm run compile\` first.`);
	process.exit(2);
}
if (!process.env.AWS_BEARER_TOKEN_BEDROCK && !process.env.AWS_PROFILE) {
	console.error("Set AWS_BEARER_TOKEN_BEDROCK (or AWS_PROFILE) — this harness makes real Bedrock calls.");
	process.exit(2);
}

/* ---------------------------------------------------------------- vscode stub */

class LanguageModelTextPart {
	constructor(value) { this.value = value; }
}
class LanguageModelToolCallPart {
	constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; }
}
class LanguageModelThinkingPart {
	constructor(value) { this.value = value; }
}

const logLines = [];
const vscodeStub = {
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	// Deliberately absent by default so `native` display degrades as it does on
	// VS Code stable. Test 11 adds it to prove the runtime probe finds it.
	window: {
		createOutputChannel: () => ({
			appendLine: (l) => logLines.push(l),
			append: (l) => logLines.push(l),
			show: () => {}, dispose: () => {}, clear: () => {},
		}),
	},
	workspace: { getConfiguration: () => ({ get: () => undefined }) },
};

// The modules bind `vscode` with __importStar, which COPIES the namespace at
// require time — so the Insiders case must be set up before the first require,
// not mutated in afterwards. Driven by env var so one harness covers both.
const INSIDERS = process.env.STUB_THINKING_API === "1";
if (INSIDERS) { vscodeStub.LanguageModelThinkingPart = LanguageModelThinkingPart; }

const origLoad = Module._load;
Module._load = function (request) {
	if (request === "vscode") { return vscodeStub; }
	return origLoad.apply(this, arguments);
};

/* ------------------------------------------------------- installed ext modules */

const { getModelProfile, parseClaudeVersion } = require(path.join(OUT, "profiles.js"));
const { buildRequestInput } = require(path.join(OUT, "converters/request.js"));
const { applyCachePoints } = require(path.join(OUT, "converters/cache-points.js"));
const { StreamProcessor } = require(path.join(OUT, "stream-processor.js"));
const { UsageTracker } = require(path.join(OUT, "usage-tracker.js"));
const { getThinkingPartCtor, resetThinkingPartCache, createThinkingReporter } = require(path.join(OUT, "thinking.js"));
const { BedrockClient } = require(path.join(OUT, "clients/bedrock.client.js"));

const {
	BedrockRuntimeClient, ConverseStreamCommand,
} = require(path.join(EXT, "node_modules/@aws-sdk/client-bedrock-runtime"));

/* ------------------------------------------------------------------- test rig */

const REGION = process.env.AWS_REGION || "us-west-2";
const CHEAP = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const ADAPTIVE = "global.anthropic.claude-sonnet-4-6";

const results = [];
let spend = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };

/** ONLY=<substring> restricts the run, so the Insiders pass costs no API calls. */
const ONLY = process.env.ONLY;

async function test(name, fn) {
	if (ONLY && !name.includes(ONLY)) { return; }
	const t0 = Date.now();
	try {
		const note = await fn();
		results.push({ name, ok: true, ms: Date.now() - t0, note });
		console.log(`PASS  ${name}${note ? "  — " + note : ""}`);
	} catch (err) {
		results.push({ name, ok: false, ms: Date.now() - t0, note: err.message });
		console.log(`FAIL  ${name}\n        ${err.message}`);
	}
}

/** Collects what the provider reports to VS Code. */
function makeProgress() {
	const parts = [];
	return {
		parts,
		report: (p) => parts.push(p),
		text: () => parts.filter((p) => p instanceof LanguageModelTextPart).map((p) => p.value).join(""),
		toolCalls: () => parts.filter((p) => p instanceof LanguageModelToolCallPart),
	};
}
const noCancel = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

/** Send a built request through the real StreamProcessor. */
async function run(input, opts = {}) {
	const client = new BedrockRuntimeClient({ region: REGION });
	const res = await client.send(new ConverseStreamCommand(input));
	const progress = makeProgress();
	const result = await new StreamProcessor().processStream(res.stream, progress, noCancel, opts);
	spend.calls++;
	spend.in += result.usage?.inputTokens ?? 0;
	spend.out += result.usage?.outputTokens ?? 0;
	spend.cacheRead += result.usage?.cacheReadInputTokens ?? 0;
	spend.cacheWrite += result.usage?.cacheWriteInputTokens ?? 0;
	return { result, progress };
}

/* Fixtures --------------------------------------------------------------- */

const model = (id, maxOut) => ({ id, maxOutputTokens: maxOut });
const userMsg = (t) => ({ role: "user", content: [{ text: t }] });

/** A system prompt large enough to clear Anthropic's minimum cacheable prefix. */
const BIG_SYSTEM = Array.from({ length: 90 }, (_, i) =>
	`Rule ${i + 1}: When responding, prefer precision over brevity, cite the specific ` +
	`file and line when referring to code, never invent an API that you have not seen ` +
	`in the provided context, and if a request is ambiguous state the assumption you ` +
	`are making rather than asking a clarifying question. This rule is numbered ${i + 1} ` +
	`and exists to make the system prompt long enough to be worth caching.`
).join("\n");

const TOOLS = {
	tools: [{
		toolSpec: {
			name: "write_file",
			description: "Write text content to a file at the given path, replacing it entirely.",
			inputSchema: { json: {
				type: "object",
				properties: {
					path: { type: "string", description: "Repo-relative file path" },
					content: { type: "string", description: "Full file contents to write" },
				},
				required: ["path", "content"],
			} },
		},
	}],
};

const NO_PARAM_TOOL = {
	tools: [{
		toolSpec: {
			name: "get_current_time",
			description: "Returns the current server time. Takes no arguments.",
			inputSchema: { json: { type: "object", properties: {} } },
		},
	}],
};

/* ============================================================== OFFLINE TESTS */

async function main() {
console.log(`\n--- Offline: real compiled code from the installed extension ---\n`);

await test("#25 root cause: maxTokens defaults to the model ceiling, not 4096", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 64000),
		converted: { messages: [userMsg("hi")], system: [] },
		options: {},                       // Copilot sends no max_tokens — the bug trigger
		profile: getModelProfile(CHEAP),
	});
	const got = built.input.inferenceConfig.maxTokens;
	assert.strictEqual(got, 64000, `expected 64000, got ${got}`);
	assert.notStrictEqual(got, 4096, "still pinned at the old 4096 default");
	return `maxTokens=${got}`;
});

await test("maxOutputTokens override is honoured and clamped to the ceiling", async () => {
	const low = buildRequestInput({
		model: model(CHEAP, 64000), converted: { messages: [userMsg("hi")], system: [] },
		options: {}, profile: getModelProfile(CHEAP), maxOutputTokensOverride: 500,
	});
	assert.strictEqual(low.input.inferenceConfig.maxTokens, 500);
	const over = buildRequestInput({
		model: model(CHEAP, 8192), converted: { messages: [userMsg("hi")], system: [] },
		options: {}, profile: getModelProfile(CHEAP), maxOutputTokensOverride: 999999,
	});
	assert.strictEqual(over.input.inferenceConfig.maxTokens, 8192, "override must not exceed the model");
	return "500 honoured; 999999 clamped to 8192";
});

await test("profiles: caching + thinking API detected per model", async () => {
	const h = getModelProfile(CHEAP);
	assert.strictEqual(h.supportsPromptCaching, true);
	assert.strictEqual(h.maxCachePoints, 4);
	assert.strictEqual(h.supportsTemperature, false, "Claude 4.5 must omit temperature");
	assert.strictEqual(h.thinkingApi, "budget");
	const s = getModelProfile(ADAPTIVE);
	assert.strictEqual(s.thinkingApi, "adaptive", "Claude 4.6 must use the adaptive API");
	const old = getModelProfile("anthropic.claude-3-haiku-20240307-v1:0");
	assert.strictEqual(old.supportsPromptCaching, false, "Claude 3 Haiku must not get cachePoints");
	assert.strictEqual(old.supportsTemperature, true, "legacy model keeps temperature");
	return "haiku4.5=budget/cacheable, sonnet4.6=adaptive, claude3=fail-closed";
});

await test("cross-region prefix stripping (global./us.)", async () => {
	assert.strictEqual(getModelProfile("global.anthropic.claude-sonnet-4-6").supportsTemperature, false);
	assert.strictEqual(getModelProfile("us.anthropic.claude-opus-5").supportsPromptCaching, true);
	assert.deepStrictEqual(parseClaudeVersion("global.anthropic.claude-sonnet-4-6"), { major: 4, minor: 6 });
	return "global./us. resolve to the base model";
});

await test("#19 cache points: 4 inserted on a large prefix, 0 when too short", async () => {
	const big = applyCachePoints(
		{ messages: [userMsg(BIG_SYSTEM), { role: "assistant", content: [{ text: "ok" }] }, userMsg("go")],
		  system: [{ text: BIG_SYSTEM }], toolConfig: TOOLS },
		getModelProfile(CHEAP), true);
	assert.strictEqual(big.inserted, 4, `expected 4 checkpoints, got ${big.inserted}`);
	assert.ok(big.toolConfig.tools.some((t) => t.cachePoint), "tool schemas uncached");
	assert.ok(big.system.some((s) => s.cachePoint), "system prompt uncached");
	const marked = big.messages.filter((m) => m.content.some((c) => c.cachePoint));
	assert.strictEqual(marked.length, 2, "expected the trailing PAIR of user messages marked");

	const small = applyCachePoints({ messages: [userMsg("hi")], system: [{ text: "be nice" }] },
		getModelProfile(CHEAP), true);
	assert.strictEqual(small.inserted, 0, "short prompt must not pay for a refused checkpoint");

	const off = applyCachePoints(
		{ messages: [userMsg(BIG_SYSTEM)], system: [{ text: BIG_SYSTEM }], toolConfig: TOOLS },
		getModelProfile(CHEAP), false);
	assert.strictEqual(off.inserted, 0, "toggle off must insert nothing");
	return "4 on long prefix; 0 short; 0 when toggled off";
});

await test("thinking config: adaptive vs budget wire shape", async () => {
	const ad = buildRequestInput({
		model: model(ADAPTIVE, 64000), converted: { messages: [userMsg("hi")], system: [] },
		options: { modelOptions: { temperature: 0.9, top_p: 0.5 } },
		profile: getModelProfile(ADAPTIVE),
		thinking: { enabled: true, effort: "high", budgetTokens: 0 },
	});
	assert.strictEqual(ad.thinkingEnabled, true);
	assert.deepStrictEqual(ad.input.additionalModelRequestFields.thinking, { type: "adaptive" });
	assert.deepStrictEqual(ad.input.additionalModelRequestFields.output_config, { effort: "high" });
	assert.strictEqual(ad.input.inferenceConfig.temperature, undefined, "temperature must be suppressed");
	assert.strictEqual(ad.input.inferenceConfig.topP, undefined, "topP must be suppressed");

	const bud = buildRequestInput({
		model: model(CHEAP, 8192), converted: { messages: [userMsg("hi")], system: [] },
		options: {}, profile: getModelProfile(CHEAP),
		thinking: { enabled: true, effort: "xhigh", budgetTokens: 0 },
	});
	const rc = bud.input.additionalModelRequestFields.reasoning_config;
	assert.strictEqual(rc.type, "enabled");
	assert.ok(rc.budget_tokens < 8192, `budget ${rc.budget_tokens} must leave room for the answer`);
	assert.ok(rc.budget_tokens >= 1024, "must respect Anthropic's floor");

	const none = buildRequestInput({
		model: model("anthropic.claude-3-haiku-20240307-v1:0", 4096),
		converted: { messages: [userMsg("hi")], system: [] }, options: {},
		profile: getModelProfile("anthropic.claude-3-haiku-20240307-v1:0"),
		thinking: { enabled: true, effort: "high", budgetTokens: 0 },
	});
	assert.strictEqual(none.thinkingEnabled, false, "old model must ignore thinking, not fail");
	assert.strictEqual(none.input.additionalModelRequestFields, undefined);
	return `adaptive=high; budget clamped to ${rc.budget_tokens}/8192; claude3 ignores it`;
});

await test("forced tool choice relaxed to auto when thinking is on", async () => {
	const b = buildRequestInput({
		model: model(ADAPTIVE, 64000), converted: { messages: [userMsg("hi")], system: [] },
		options: {}, profile: getModelProfile(ADAPTIVE),
		toolConfig: { ...TOOLS, toolChoice: { tool: { name: "write_file" } } },
		thinking: { enabled: true, effort: "low", budgetTokens: 0 },
	});
	assert.deepStrictEqual(b.input.toolConfig.toolChoice, { auto: {} });
	return "tool choice → auto";
});

await test(`native thinking display — ${INSIDERS ? "API present (Insiders)" : "API absent (stable)"}`, async () => {
	resetThinkingPartCache();
	if (INSIDERS) {
		assert.ok(getThinkingPartCtor(), "probe must find the API when it is present");
		const pi = makeProgress();
		const ri = createThinkingReporter(pi, "native");
		ri.delta("native reasoning"); ri.end();
		assert.ok(pi.parts.some((x) => x instanceof LanguageModelThinkingPart),
			"native must emit a real thinking part on Insiders");
		assert.ok(!pi.text().includes("<details>"), "must use the native UI, not the text fallback");
		return "probe found the API; emitted a LanguageModelThinkingPart";
	}
	// null (not undefined) is the deliberate "probed, absent" verdict; undefined
	// is the not-yet-probed sentinel that drives the cache.
	assert.strictEqual(getThinkingPartCtor(), null, "stable VS Code must report no thinking API");
	const p1 = makeProgress();
	const r1 = createThinkingReporter(p1, "native");
	r1.delta("secret reasoning"); r1.end();
	assert.strictEqual(p1.parts.length, 0, "native must emit nothing without the API");

	const p2 = makeProgress();
	const r2 = createThinkingReporter(p2, "text");
	r2.delta("visible reasoning"); r2.end();
	assert.ok(p2.text().includes("<details>"), "text mode must render a collapsed block");
	assert.ok(p2.text().includes("visible reasoning"));

	const p3 = makeProgress();
	const r3 = createThinkingReporter(p3, "hidden");
	r3.delta("nope"); r3.end();
	assert.strictEqual(p3.parts.length, 0, "hidden must emit nothing");
	return "native→silent, text→<details>, hidden→silent";
});

await test("usage tracker aggregates a session", async () => {
	const t = new UsageTracker();
	t.reset();
	t.record({ modelId: CHEAP, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheWriteInputTokens: 90 }, latencyMs: 500, stopReason: "end_turn", toolCalls: 0, cachePoints: 4, contextWindow: 200000 });
	t.record({ modelId: CHEAP, usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220, cacheReadInputTokens: 90 }, latencyMs: 400, stopReason: "tool_use", toolCalls: 1, cachePoints: 4, contextWindow: 200000 });
	const tot = t.getTotals();
	assert.strictEqual(tot.turns, 2);
	assert.strictEqual(tot.inputTokens, 300);
	assert.strictEqual(tot.outputTokens, 30);
	assert.strictEqual(tot.cacheReadInputTokens, 90);
	assert.strictEqual(tot.cacheWriteInputTokens, 90);
	return `turns=2 in=300 out=30 read=90 write=90`;
});

/* ================================================================ LIVE TESTS */

console.log(`\n--- Live against Bedrock (${REGION}) ---\n`);

await test("#22 LIVE: usage, latency and stopReason captured from metadata", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 8192),
		converted: { messages: [userMsg("Reply with exactly the word: ok")], system: [] },
		options: {}, profile: getModelProfile(CHEAP), maxOutputTokensOverride: 64,
	});
	const { result, progress } = await run(built.input);
	assert.ok(result.usage, "no usage captured — metadata event was ignored");
	assert.ok(result.usage.inputTokens > 0, "inputTokens missing");
	assert.ok(result.usage.outputTokens > 0, "outputTokens missing");
	assert.ok(typeof result.latencyMs === "number" && result.latencyMs > 0, "latencyMs missing");
	assert.strictEqual(result.stopReason, "end_turn");
	assert.ok(progress.text().length > 0, "no text reported to VS Code");
	return `in=${result.usage.inputTokens} out=${result.usage.outputTokens} latency=${result.latencyMs}ms stop=${result.stopReason} text=${JSON.stringify(progress.text().trim().slice(0, 20))}`;
});

await test("#19 LIVE turn 1: cache checkpoints written", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 8192),
		converted: { messages: [userMsg("Say 'ready' and nothing else.")], system: [{ text: BIG_SYSTEM }] },
		options: {}, profile: getModelProfile(CHEAP), toolConfig: TOOLS,
		maxOutputTokensOverride: 64, promptCaching: true,
	});
	// Turn 1 has only ONE user message, so only 3 checkpoints are possible:
	// tool schemas + system prompt + that single user message. The 4th appears
	// from turn 2 onward, once a previous user message exists to mark.
	assert.strictEqual(built.cachePoints, 3, "expected 3 checkpoints on a single-user-message turn");
	assert.ok(built.input.system.some((s) => s.cachePoint), "system prompt not checkpointed");
	const { result } = await run(built.input);
	const w = result.usage.cacheWriteInputTokens ?? 0;
	const r = result.usage.cacheReadInputTokens ?? 0;
	// Either outcome proves the checkpoints were honoured: a write on a cold cache,
	// or a read if a recent run already populated it (entries live ~5 minutes).
	assert.ok(w > 0 || r > 0,
		`Bedrock reported no cache activity at all (read=${r}, write=${w}) — checkpoints were refused`);
	return `cacheWrite=${w}, cacheRead=${r}, cachePoints=${built.cachePoints} (${w > 0 ? "cold cache" : "warm from a prior run"})`;
});

await test("#19 LIVE turn 2: previous checkpoint reads back as a hit", async () => {
	// Same prefix, one more turn appended — exactly what turn N+1 of a session sends.
	const grown = [
		{ role: "user", content: [{ text: "Say 'ready' and nothing else." }] },
		{ role: "assistant", content: [{ text: "ready" }] },
		{ role: "user", content: [{ text: "Now say 'again' and nothing else." }] },
	];
	const built = buildRequestInput({
		model: model(CHEAP, 8192),
		converted: { messages: grown, system: [{ text: BIG_SYSTEM }] },
		options: {}, profile: getModelProfile(CHEAP), toolConfig: TOOLS,
		maxOutputTokensOverride: 64, promptCaching: true,
	});
	// Now both trailing user messages are markable, so the full 4 appear.
	assert.strictEqual(built.cachePoints, 4, "expected 4 checkpoints once a previous user turn exists");
	const { result } = await run(built.input);
	const r = result.usage.cacheReadInputTokens ?? 0;
	const w = result.usage.cacheWriteInputTokens ?? 0;
	assert.ok(r > 0, `no cache read (read=${r}, write=${w}) — caching is not compounding across turns`);
	return `cacheRead=${r} tokens (billed at reduced rate), cacheWrite=${w}, cachePoints=4`;
});

await test("#25 LIVE: large tool call arrives as valid, parsed JSON", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 16384),
		converted: { messages: [userMsg(
			"Use the write_file tool to create 'src/generated/config.ts'. The content must be a " +
			"TypeScript module exporting at least 25 named const values with realistic comments — " +
			"make it genuinely long, several thousand characters. Call the tool once."
		)], system: [] },
		options: {}, profile: getModelProfile(CHEAP), toolConfig: TOOLS,
	});
	// The whole point: no artificial 4096 cap on a big tool call.
	assert.strictEqual(built.input.inferenceConfig.maxTokens, 16384);
	const { result, progress } = await run(built.input);
	assert.deepStrictEqual(result.toolCallFailures, [], `tool call failures: ${JSON.stringify(result.toolCallFailures)}`);
	const calls = progress.toolCalls();
	assert.strictEqual(calls.length, 1, `expected exactly 1 tool call, got ${calls.length}`);
	assert.strictEqual(calls[0].name, "write_file");
	assert.strictEqual(typeof calls[0].input, "object", "input was not parsed into an object");
	assert.ok(typeof calls[0].input.content === "string" && calls[0].input.content.length > 500,
		`content too short to prove the point: ${calls[0].input.content?.length} chars`);
	assert.notStrictEqual(result.stopReason, "max_tokens", "response was truncated by the output cap");
	return `stop=${result.stopReason}, args=${JSON.stringify(calls[0].input).length} chars, content=${calls[0].input.content.length} chars, failures=0`;
});

await test("#25 LIVE: zero-parameter tool emits {} instead of failing", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 4096),
		converted: { messages: [userMsg("What time is it? Use the get_current_time tool.")], system: [] },
		options: {}, profile: getModelProfile(CHEAP), toolConfig: NO_PARAM_TOOL,
	});
	const { result, progress } = await run(built.input);
	assert.deepStrictEqual(result.toolCallFailures, [], "a no-arg tool must not be recorded as a failure");
	const calls = progress.toolCalls();
	assert.strictEqual(calls.length, 1, `expected 1 tool call, got ${calls.length}`);
	assert.deepStrictEqual(calls[0].input, {}, `expected {}, got ${JSON.stringify(calls[0].input)}`);
	return `emitted ${calls[0].name} with {} , failures=0`;
});

await test("thinking LIVE (budget API, Claude 4.5): signed reasoning captured", async () => {
	const built = buildRequestInput({
		model: model(CHEAP, 8192),
		converted: { messages: [userMsg("A rope ladder hangs over a boat's side with 3 rungs above water, rungs 30cm apart. The tide rises 60cm. How many rungs are above water? Think it through.")], system: [] },
		options: {}, profile: getModelProfile(CHEAP),
		thinking: { enabled: true, effort: "low", budgetTokens: 0 },
	});
	assert.ok(built.input.additionalModelRequestFields.reasoning_config, "no reasoning_config sent");
	const { result, progress } = await run(built.input, { thinkingDisplay: "text" });
	assert.ok(result.reasoning.length > 0, "no reasoning blocks captured");
	const withSig = result.reasoning.filter((r) => r.signature);
	assert.ok(withSig.length > 0, "reasoning has no signature — cannot be replayed next turn");
	assert.ok(result.reasoning[0].text.length > 0, "reasoning text empty");
	assert.ok(progress.text().includes("<details>"), "text display did not render the block");
	return `${result.reasoning.length} block(s), ${result.reasoning[0].text.length} chars, signature present (${withSig[0].signature.length} chars)`;
});

await test("thinking LIVE (adaptive API, Claude 4.6): reasoning captured", async () => {
	const built = buildRequestInput({
		model: model(ADAPTIVE, 64000),
		converted: { messages: [userMsg("Is 8191 prime? Reason briefly, then answer.")], system: [] },
		options: {}, profile: getModelProfile(ADAPTIVE), maxOutputTokensOverride: 4096,
		thinking: { enabled: true, effort: "low", budgetTokens: 0 },
	});
	assert.deepStrictEqual(built.input.additionalModelRequestFields.thinking, { type: "adaptive" });
	const { result } = await run(built.input, { thinkingDisplay: "hidden" });
	assert.ok(result.reasoning.length > 0, "no reasoning captured from the adaptive API");
	assert.ok(result.usage.outputTokens > 0);
	return `${result.reasoning.length} block(s), ${result.reasoning[0].text.length} chars, stop=${result.stopReason}`;
});

await test("#22 LIVE: native CountTokens — exact count, or clean fallback if IAM denies it", async () => {
	// Establish what the account actually permits, so a missing IAM action is not
	// mistaken for a defect in the extension.
	const { CountTokensCommand } = require(path.join(EXT, "node_modules/@aws-sdk/client-bedrock-runtime"));
	let apiVerdict = "allowed";
	try {
		await new BedrockRuntimeClient({ region: REGION }).send(new CountTokensCommand({
			modelId: CHEAP, input: { converse: { messages: [userMsg("probe")] } } }));
	} catch (e) { apiVerdict = e.name; }

	const c = new BedrockClient(REGION);
	const n = await c.countTokens(undefined, CHEAP,
		{ messages: [userMsg(BIG_SYSTEM)], system: [{ text: "be precise" }], toolConfig: TOOLS });

	if (apiVerdict === "allowed") {
		assert.ok(typeof n === "number" && n > 0, `CountTokens returned ${n} despite being permitted`);
		const estimate = Math.ceil(BIG_SYSTEM.length / 4);
		return `exact=${n} tokens vs char-estimate=${estimate} (${((n / estimate - 1) * 100).toFixed(1)}% off)`;
	}
	// Not permitted: the contract is graceful degradation, not a thrown error.
	assert.strictEqual(n, undefined, "must return undefined so the caller estimates instead");
	return `IAM denies bedrock:CountTokens (${apiVerdict}) — extension fell back to estimation cleanly`;
});

await test("CountTokens on an unsupported model degrades and memoizes", async () => {
	const c = new BedrockClient(REGION);
	const n = await c.countTokens(undefined, "anthropic.definitely-not-a-model-v9",
		{ messages: [userMsg("hi")] });
	assert.strictEqual(n, undefined, "must return undefined, not throw, so the caller can estimate");
	const t0 = Date.now();
	const again = await c.countTokens(undefined, "anthropic.definitely-not-a-model-v9",
		{ messages: [userMsg("hi")] });
	const ms = Date.now() - t0;
	assert.strictEqual(again, undefined);
	assert.ok(ms < 50, `second call took ${ms}ms — not memoized, paying a round trip every turn`);
	return `fell back to estimation; 2nd call short-circuited in ${ms}ms`;
});

await test("mid-stream fault surfaces as an error instead of a silent stop", async () => {
	const faulty = { [Symbol.asyncIterator]: () => { let i = 0; return { next: async () => {
		i++;
		if (i === 1) { return { value: { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } }, done: false }; }
		if (i === 2) { return { value: { throttlingException: { message: "Too many requests" } }, done: false }; }
		return { value: undefined, done: true };
	} }; } };
	const progress = makeProgress();
	await assert.rejects(
		() => new StreamProcessor().processStream(faulty, progress, noCancel, {}),
		/ThrottlingException|Too many requests/,
		"a throttling event must not end the turn quietly");
	assert.strictEqual(progress.text(), "partial", "text before the fault should still have been reported");
	return "ThrottlingException raised, prior text preserved";
});

/* -------------------------------------------------------------------- report */

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok);
console.log(`\n================ ${pass}/${results.length} passed ================`);
if (fail.length) { console.log("FAILURES:"); fail.forEach((f) => console.log(`  - ${f.name}: ${f.note}`)); }
console.log(`\nBedrock calls: ${spend.calls} | input ${spend.in} tok | output ${spend.out} tok | cacheRead ${spend.cacheRead} | cacheWrite ${spend.cacheWrite}`);
process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });

# Integration hooks — what each agent framework actually exposes

This document records the **real** interception points the SDK's framework adapters
are built against, read from each framework's own source rather than from its
documentation or from an assumed API shape.

Every entry below is pinned to the file revision it was read from (blob SHA), so a
reader can confirm the signatures have not drifted under them. Each section
carries its own **last verified** date, and every superseded pin is recorded —
never silently replaced — in the [revision log](#revision-log) at the end of this
file.

**Last verified: 2026-09-28** for every section (previously read 2026-09-14).

**Summary**

| Framework | Pre-execution blocking hook | Status |
|---|---|---|
| LangChain | `AgentMiddleware.wrap_tool_call` | **Confirmed** |
| ElizaOS | `Action.validate` | **Confirmed** |
| MCP | registered tool handler / client `callTool` | **Confirmed** — see §4 |
| Vercel AI SDK | tool `execute` function | **Confirmed** — see §5 |
| AutoGPT | none exposed to third parties | **Confirmed absent** — see §3 |

The rule this document enforces: a framework gets an adapter only if a genuine
pre-execution *blocking* point exists. Observability-only callbacks are not
sufficient — they can watch a spend, not stop one. Where no hook exists, the gap is
recorded here rather than papered over with an adapter built on a guessed interface.

---

## 1. LangChain — `AgentMiddleware.wrap_tool_call`

**Last verified: 2026-09-28** (previously read 2026-09-14).

**Source:** `langchain-ai/langchain`, `master`, `libs/langchain_v1/langchain/agents/middleware/types.py`
(blob `b7d5b8050ab887acb3f180edae17ee06c11022d2`, unchanged since the previous pin
`b7d5b8050ab8`).

### The hook

```python
class AgentMiddleware(Generic[StateT, ContextT, InputT, OutputT]):
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        """Intercept tool execution for retries, monitoring, or modification.

        Async version is `awrap_tool_call`

        Multiple middleware compose automatically (first defined = outermost).

        Exceptions propagate unless `handle_tool_errors` is configured on `ToolNode`.
        ...
```

The async variant is declared on the same class:

```python
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
```

`ToolCallRequest` is re-exported by that module and defined in `langgraph`:
`langchain-ai/langgraph`, `main`, `libs/prebuilt/langgraph/prebuilt/tool_node.py`
(blob `95e161b9078e3123afa1854247a5dfd132410a53`, unchanged since the previous pin
`95e161b9078e`):

```python
@dataclass
class ToolCallRequest:
    """Tool execution request passed to tool call interceptors.

    Attributes:
        tool_call: Tool call dict with name, args, and id from model output.
        tool: BaseTool instance to be invoked, or None if tool is not
            registered with the `ToolNode`. ...
        state: Agent state (`dict`, `list`, or `BaseModel`).
        runtime: LangGraph runtime context (optional, `None` if outside graph).
    """

    tool_call: ToolCall
    tool: BaseTool | None
```

and the wrapper type:

```python
ToolCallWrapper = Callable[
    [ToolCallRequest, Callable[[ToolCallRequest], ToolMessage | Command]],
    ToolMessage | Command,
]
```

The same module also exposes a decorator form, for a function instead of a class:

```python
@overload
def wrap_tool_call(
    func: None = None,
    *,
    state_schema: type[StateT] | None = None,
    tools: list[BaseTool] | None = None,
    name: str | None = None,
) -> Callable[[_CallableReturningToolResponse], AgentMiddleware[StateT, ContextT]]: ...
```

### Why this is genuinely blockable, not observability-only

The handler *is* the continuation: `WrapToolCall` receives the tool execution as a
callback and decides whether to invoke it. A middleware that returns a
`ToolMessage` **without calling `handler(request)`** means the tool body never runs.
Returning a `Command` can additionally redirect the graph. This is the property the
adapter depends on: the guard's block decision is turned into a returned
`ToolMessage` describing the refusal, and the underlying tool — the one that would
have signed and broadcast a transaction — is never entered.

Composition order matters and is documented in the source: *"first defined =
outermost"*, so the interceptor is registered ahead of any other tool middleware.

### What the adapter must do

Build an `AgentMiddleware` (or a `@wrap_tool_call`-decorated function) that:

1. inspects `request.tool_call["args"]` for the transaction intent;
2. asks the guard's pre-flight interceptor whether the action is permitted;
3. on **block**, returns a `ToolMessage` carrying `GuardBlockedError`'s reason and
   explanation, **without** calling `handler(request)`;
4. on **allow**, calls `handler(request)` and returns its result unchanged.

---

## 2. ElizaOS — `Action.validate`

**Last verified: 2026-09-28** (previously read 2026-09-14).

**Source:** `elizaOS/eliza`, `develop`. `packages/core/src/types/components.ts`
(blob `1a319a3d7b2d5e7418e03c85a2ad33b607e46198`, superseding `5f604e593854`) and
`packages/core/src/runtime.ts`
(blob `c13af759cafde630483450f97bb802b58d1b253a`, superseding `eb3f3fc98cef`).

The `Validator` type and `Action.validate` shown below are **unchanged** between
the two revisions — the files grew (new `ActionMode` hook scopes and disclosure
gating) without touching the validator contract the adapter depends on.

### The hook types

```typescript
export type Validator = (
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	options?: HandlerOptions | Record<string, JsonValue | undefined>,
) => Promise<boolean>;

export type Handler = (
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	options?: HandlerOptions | Record<string, JsonValue | undefined>,
	callback?: HandlerCallback,
	responses?: Memory[],
) => Promise<ActionResult | undefined>;
```

Both hang off the `Action` interface, whose own doc comment calls it
"`Action` (validate + handler)":

```typescript
export interface Action {
	/** Action name */
	name: string;

	/** Detailed description */
	description: string;
	...
	/** Handler function */
	handler: Handler;

	/** Validation function */
	validate: Validator;
```

### Where the gate actually fires

`runtime.ts` calls `validate` and admits the action to the eligible set only when it
returns truthy:

```typescript
				try {
					const ok = await action.validate(this, message, state);
					if (ok) validated.push(action);
				} catch (err) {
					// error-policy:J4 Mode actions are isolated; failed validation is
					// reported while independent actions remain eligible.
```

The same `action.validate(` gate is used from the other execution paths as well —
`plugins/plugin-assistant/src/services/message/action-surface.ts`
(blob `cfa968b054786ab691ceacf0271dff550ad0ca7e`; the previous pin pointed at
`packages/core/src/services/message/action-surface.ts`, which moved there and now
404s at the old path) and `packages/core/src/runtime/execute-planned-tool-call.ts`
(blob `daf3a44b3521a0dac4451661660576099b4ff0c9`) — so a false verdict keeps
the handler from running whether the action was chosen by the planner or by a
planned tool call.

### Why this is genuinely blockable, not observability-only

An action whose `validate` returns `false` is filtered out of the candidate list
*before* any handler is invoked. `validate` is called with the same
`(runtime, message, state)` triple the handler gets, so it has everything needed to
classify the intended action. This composes with the guard rather than replacing
it: `validate` is where the pre-flight check is performed, so the handler that
submits the transaction is never reached.

### What the adapter must do

Compose the guard check into `validate` rather than wrapping `handler`:

```typescript
validate: async (runtime, message, state, options) => {
  if (!(await baseValidate(runtime, message, state, options))) return false;
  const decision = await guard.preflight(intentFrom(message, state, options));
  return decision.allowed; // false ⇒ action never executes
}
```

Note the ordering consequence, stated plainly: because a blocked action is simply
never validated, the refusal surfaces through whatever the runtime does with a
non-matching action set, not as an error thrown from the handler. The adapter
therefore also records the block on the telemetry listener (see
[`docs/event-schema.md`](./event-schema.md), which records the real event topics
verified against the live chain) so a refused action is auditable rather than
silent.

---

## 3. AutoGPT — **no third-party pre-execution blocking hook**

This entry is the resolution of an open question, not an assumption. The finding is
negative and is recorded as such. Re-verified 2026-09-28: the finding is
**unchanged**.

**Last verified: 2026-09-28** (previously read 2026-09-14).

**Source:** `Significant-Gravitas/AutoGPT`, `master`.

- `autogpt_platform/backend/backend/executor/manager.py`
  (blob `00a3b26453a0374cc752bd190c5d10fe3dbd44ef`, superseding `713459246689`)
- `autogpt_platform/backend/backend/blocks/_base.py`
  (blob `f459b3ceac3ecdedc7311ce616ebb694ada2505a`, superseding `78ee11373050`)
- `autogpt_platform/backend/backend/executor/automod/manager.py`
  (blob `bcbbfc79ee09f48a00dd9facb4f1a8ad9a1a4e64`)

### What was checked

**1. Is there a middleware/hook/interceptor registry in the executor?** No. Grepping
the executor's `manager.py` for `hook`, `middleware`, `interceptor`, and
`register.*callback` returns nothing, and block execution is a direct call:

```python
            block_iter = node_block.execute(input_data, **extra_exec_kwargs)
```

There is no registry a guardrail library could join, and no callback list consulted
before execution.

**2. Is there a pre-execution gate inside the block lifecycle?** Yes, but it is not
available to third parties. `Block._execute` consults a review step before `run`:

```python
    async def _execute(
        self,
        input_data: BlockInput,
        *,
        execution_context: "ExecutionContext",
        **kwargs,
    ) -> BlockOutput:
        # Review is only meaningful inside a graph execution. Direct block
        # execution (e.g. from the /blocks/{id}/execute API) has no graph
        # context and skips the review path.
        if execution_context.graph_exec_id is not None:
            should_pause, input_data = await self.is_block_exec_need_review(
                input_data, execution_context=execution_context, **kwargs
```

and the gate itself:

```python
    async def is_block_exec_need_review(
        self,
        input_data: BlockInput,
        *,
        user_id: str,
        node_id: str,
        node_exec_id: str,
        graph_exec_id: str,
        graph_id: str,
        graph_version: int,
        execution_context: "ExecutionContext",
        is_graph_execution: bool = True,
        **kwargs,
    ) -> tuple[bool, BlockInput]:
        """
        Check if this block execution needs human review and handle the review process.

        Returns:
            Tuple of (should_pause, input_data_to_use)
            - should_pause: True if execution should be paused for review
            - input_data_to_use: The input data to use (may be modified by reviewer)
        """
        if not (
            self.is_sensitive_action and execution_context.sensitive_action_safe_mode
        ):
            return False, input_data
```

The early-return condition above is unchanged at the 2026-09-28 revision; the
review it guards now delegates to
`backend.blocks.helpers.review.HITLReviewHelper.handle_review_decision`, which
does not change the conclusion — it is still a platform-owned human-in-the-loop
pause, not a third-party extension point.

This is a real pre-execution pause — but it is **not an extension point**:

- it is a method on the platform's own `Block` base class, so intervening in it
  means patching or forking the platform, not registering with it;
- it only engages when the *block author* has set `is_sensitive_action` and the
  execution context is in safe mode;
- it is a human-in-the-loop review pause, not a policy engine a library can supply
  a verdict to.

**3. Is the AutoMod path an interception point?** No.
`AutoModManager.moderate_graph_execution_inputs` moderates a graph's *inputs* before
a run. It is internal, feature-flagged per user, configuration-driven (it calls an
external moderation API configured through platform settings), and surfaces failures
as the platform's own `ModerationError`. It is not a hook a third-party package can
register a policy into.

### Conclusion and the honest options

**AutoGPT has no pluggable pre-execution blocking hook for third-party guardrails as
of this revision.** No adapter will be built against a guessed shape.

The two viable integrations are, in order of preference:

1. **Author the block that performs the guarded action.** Blocks are AutoGPT's
   supported extension mechanism: a `Block` subclass implements
   `async def run(self, input_data, **kwargs) -> BlockOutput` (an `@abstractmethod`,
   `_base.py`), and a guard-owned block owns that call. This gives enforcement, but
   with a real limitation worth stating: it only protects actions that flow through
   *that* block. It cannot constrain an unrelated block that someone else authored,
   so it is ownership rather than interception.
2. **Upstream a hook at the point that already exists.** `is_block_exec_need_review`
   is called immediately before `run` and already models "pause or proceed with
   possibly-modified input". A pluggable, non-human policy check at that call site
   is the natural upstream change, and it would give third-party guardrails the same
   standing the internal review path already has. This is a contribution to AutoGPT,
   not something this SDK can build against today.

**Consequence for this SDK:** the AutoGPT adapter is not built. It is listed as an
open gap, and it should be revisited either when AutoGPT exposes a pre-execution
hook or when the project deliberately chooses option 1 as its AutoGPT integration
story.

### Re-verification

If AutoGPT's executor gains a middleware mechanism, this section should be
re-checked by repeating the three searches above against the then-current
`executor/manager.py` and `blocks/_base.py`, and the blob SHAs here superseded
rather than silently replaced.

Re-run 2026-09-28 against the pins above:

```bash
# 1. Any middleware/hook registry in the executor?
rg -i 'hook|middleware|interceptor|register.*callback' \
  autogpt_platform/backend/backend/executor/manager.py

# 2. Any pre-execution gate inside the block lifecycle?
rg -n 'is_block_exec_need_review|is_sensitive_action|def _execute|def run' \
  autogpt_platform/backend/backend/blocks/_base.py

# 3. Is the AutoMod path an extension point?
rg -n 'def moderate_graph_execution_inputs|class AutoModManager|ModerationError' \
  autogpt_platform/backend/backend/executor/automod/manager.py
```

Result: search 1 still returns no registry (its only hit is an unrelated
"webhook" mention in a comment); search 2 still finds `is_block_exec_need_review`
called immediately before `run`; search 3 still finds the internal, per-user
moderation path. The negative finding stands.

---

## 4. MCP (Model Context Protocol) — registered tool handler / client `callTool`

**Last verified: 2026-09-30.**

MCP is mid-migration between two published generations of the TypeScript SDK, so
both were reviewed before writing the adapter:

| Generation | Package | Pin |
| --- | --- | --- |
| v2 (current line, spec `2026-07-28`) | `@modelcontextprotocol/server`, `@modelcontextprotocol/client` | `modelcontextprotocol/typescript-sdk` `main`, `README.md` blob `6d5e2328efd2fc4493731b4e4cfd2e117ad1e28d` |
| v1 (legacy; bug/security fixes) | `@modelcontextprotocol/sdk` (latest 1.30.1) | `modelcontextprotocol/typescript-sdk` `v1.x`, `README.md` blob `2d2f19ae376bee6081437c4d6f8e251bf3fd3ce5` |

### The hook

An MCP server exposes a tool by registering a handler. v2:

```ts
server.registerTool(
  "transfer_tokens",
  { description, inputSchema },
  async (args, extra) => ({ content: [{ type: "text", text: "sent" }] }),
);
```

v1 exposes the same handler shape through `server.tool(name, schema, handler)`, and
the low-level form, `server.setRequestHandler(CallToolRequestSchema, handler)`,
receives `request.params = { name, arguments }`. The handler is invoked only after
a client sends `tools/call`, and the server's response *is* the tool result.

On the client side, the high-level `Client` exposes
`callTool({ name, arguments })` — the last point before the request leaves the
process.

### Why this is genuinely blockable, not observability-only

A handler that is never called means the tool body — the code that signs and
broadcasts the guarded transaction — never runs. That is the same continuation
property the LangChain adapter depends on: the guard's verdict decides whether the
registered handler is entered, and a refusal is returned to the client as an
`isError: true` result instead of a transaction. Wrapping `callTool` on the client
is the same boundary read from the egress side.

There is no post-hoc-only problem to document here; unlike AutoGPT (§3), MCP
exposes a real pre-execution point to third-party code in both generations.

### What the adapter does

1. `guardMcpToolHandler(toolName, handler, options)` wraps a registered handler
   and asks the guard before invoking it.
2. `guardMcpCallTool(callTool, options)` wraps a client's `callTool` and refuses
   before the request is sent.
3. On block, both return `{ content: [{ type: "text", text: refusal }], isError:
   true }` without invoking the wrapped handler/call, and fire the shared
   `onBlocked` operator hook (`src/adapters/shared.ts`).

### Dependency stance

Both generations require Zod (v1) or a Standard Schema library (v2) at the host,
and the packages are large. The adapter is therefore written **structurally**
against the handler / `callTool` shape, so neither package becomes a dependency of
this SDK and no lazy peer dep is required — the same zero-dependency stance the
LangChain and ElizaOS adapters take. No speculative code: both wrappers are
covered by `tests/unit/adapters.test.ts`.

---

## 5. Vercel AI SDK — tool `execute`

**Last verified: 2026-10-19.**

**Pinned shape:** `ai` 5.x, the structural `Tool` interface. The adapter is
written against `Tool.execute(input, options)`, not against the language-model
middleware (`wrapLanguageModel`), whose stream already contains tool-call
arguments the model emitted.

```ts
type Tool<INPUT, RESULT> = {
  execute?: (input: INPUT, options: ToolCallOptions) => Promise<RESULT>;
  // …description / inputSchema omitted
};
```

### Why this is genuinely blockable, not observability-only

The tool body *is* `execute`. Wrapping that function and refusing before
calling the original means the code that signs and broadcasts a transaction is
never entered; the AI SDK renders the thrown refusal into the model's error
stream rather than as a tool result. `wrapLanguageModel` is **not** used:
intercepting a model stream is post-decision, not pre-execution.

### What the adapter does

`createVercelAIGuard(...)(toolName, tool)` returns a copy whose `execute` asks
the guard first. `admissible` runs the original `execute` and returns its
result unchanged; `blocked` throws `GuardBlockedError`; `undetermined` throws
`PreFlightUndeterminedError` — both before `execute` is entered. A tool with no
`execute` is returned untouched.

## Compatibility smoke fixtures

The compatibility evidence is executable, not just a type check:
`tests/unit/adapter-compat.test.ts` drives each framework's actual continuation
with a tool body that counts entries, then asserts a blocked verdict leaves
that counter at **zero**. A shape that only *looks* pre-execution would fail
that assertion.

| Framework | Shape exercised | Pin | Why the hook is pre-execution |
| --- | --- | --- | --- |
| LangChain | `AgentMiddleware.wrapToolCall(request, handler)` | `b7d5b8050ab887acb3f180edae17ee06c11022d2` | The handler is the continuation; a block returns without calling it. |
| ElizaOS | `Action.validate` | `c13af759cafde630483450f97bb802b58d1b253a` | The runtime filters the eligible action set before invoking any handler. |
| MCP v1 | client `callTool({ name, arguments })` | `2d2f19ae376bee6081437c4d6f8e251bf3fd3ce5` | A refusal is returned locally; the request never leaves the process. |
| MCP v2 | `server.registerTool(name, config, handler)` | `6d5e2328efd2fc4493731b4e4cfd2e117ad1e28d` | The registered handler is the tool body; not calling it means it never runs. |
| Vercel AI SDK | `Tool.execute(input, options)` | ai 5.x `Tool.execute` | The wrapped function is the tool body and is not entered on a refusal. |

**Refresh procedure:** when a framework publishes a new hook revision, update
the pin here **and** in `COMPATIBILITY_PINS` in `tests/unit/adapter-compat.test.ts`
(the sync test fails if they diverge), re-run the fixture suite, and append the
superseded pin to the revision log. No framework package is installed and no
network access is needed: the fixtures are structural, by design.

## Revision log

Append-only record of every superseded pin, newest last. A pin is never replaced
silently: the old value stays here with the date it was retired and what changed.

### 2026-09-28 — re-verification sweep

| File | Old pin | New pin | What changed |
| --- | --- | --- | --- |
| `langchain-ai/langchain` `libs/langchain_v1/langchain/agents/middleware/types.py` | `b7d5b8050ab8` | `b7d5b8050ab887acb3f180edae17ee06c11022d2` | none (pin unchanged; re-confirmed) |
| `langchain-ai/langgraph` `libs/prebuilt/langgraph/prebuilt/tool_node.py` | `95e161b9078e` | `95e161b9078e3123afa1854247a5dfd132410a53` | none (pin unchanged; re-confirmed) |
| `elizaOS/eliza` `packages/core/src/types/components.ts` | `5f604e593854` | `1a319a3d7b2d5e7418e03c85a2ad33b607e46198` | file grew new `ActionMode` hook scopes and disclosure gating; `Validator` and `Action.validate` unchanged |
| `elizaOS/eliza` `packages/core/src/runtime.ts` | `eb3f3fc98cef` | `c13af759cafde630483450f97bb802b58d1b253a` | grew mode/disclosure logic around the same `action.validate(this, message, state)` gate |
| `elizaOS/eliza` `packages/core/src/services/message/action-surface.ts` | (path pin) | `plugins/plugin-assistant/src/services/message/action-surface.ts` @ `cfa968b054786ab691ceacf0271dff550ad0ca7e` | file moved out of `packages/core/`; the old path now 404s |
| `elizaOS/eliza` `packages/core/src/runtime/execute-planned-tool-call.ts` | (path pin) | `daf3a44b3521a0dac4451661660576099b4ff0c9` | `action.validate` gate still present |
| `Significant-Gravitas/AutoGPT` `autogpt_platform/backend/backend/executor/manager.py` | `713459246689` | `00a3b26453a0374cc752bd190c5d10fe3dbd44ef` | no middleware/hook registry still |
| `Significant-Gravitas/AutoGPT` `autogpt_platform/backend/backend/blocks/_base.py` | `78ee11373050` | `f459b3ceac3ecdedc7311ce616ebb694ada2505a` | `is_block_exec_need_review` unchanged; review now delegates to `HITLReviewHelper` |
| `Significant-Gravitas/AutoGPT` `autogpt_platform/backend/backend/executor/automod/manager.py` | (path pin) | `bcbbfc79ee09f48a00dd9facb4f1a8ad9a1a4e64` | internal moderation path unchanged |

Superseded file-content pins are kept above rather than deleted, so the previous
revision remains addressable. No framework gained a genuine third-party
pre-execution blocking hook in this sweep, so no new adapter is unblocked and no
follow-up adapter issue is filed.

### 2026-09-30 — MCP spike (issue #45)

| File | Pin | What was checked |
| --- | --- | --- |
| `modelcontextprotocol/typescript-sdk` `main` `README.md` | blob `6d5e2328efd2fc4493731b4e4cfd2e117ad1e28d` | v2 (`@modelcontextprotocol/server`) tool registration and the `Client.callTool` egress |
| `modelcontextprotocol/typescript-sdk` `v1.x` `README.md` | blob `2d2f19ae376bee6081437c4d6f8e251bf3fd3ce5` | v1 (`@modelcontextprotocol/sdk` 1.30.1) handler registration and `Client.callTool` |

Outcome: MCP has a genuine pre-execution blocking point in both generations, so
the adapter was built rather than deferred — see §4. No superseded pin: this is
the first MCP entry.

### 2026-10-19 — compatibility smoke fixtures (issue #319)

| Framework | Pin exercised | What the fixture proves |
| --- | --- | --- |
| LangChain | `b7d5b8050ab887acb3f180edae17ee06c11022d2` (unchanged) | a block skips `handler(request)` |
| ElizaOS | `c13af759cafde630483450f97bb802b58d1b253a` (unchanged) | a false `validate` keeps the handler out of the eligible set |
| MCP v1 / v2 | `2d2f19ae…` / `6d5e2328…` (unchanged) | neither the handler nor the client request is entered on a block |
| Vercel AI SDK | ai 5.x `Tool.execute` (first pin) | a thrown refusal precedes the wrapped `execute` |

No superseded pin: the fixture suite pins the same revisions already recorded
above and adds the Vercel AI shape as a new entry.

# Kiln API notes

Fetched 2026-09-29 from the official docs. These notes are the contract for `KilnClient`. Example snippets in the docs still name `gpt-oss-120b`; the track model for this build is **Qwen3-32B**.

Sources:

- [Documentation](https://kiln.bricksum.com/docs/en)
- [Models](https://kiln.bricksum.com/docs/en/models)
- [API reference](https://kiln.bricksum.com/docs/en/api-reference)
- [Chat completions](https://kiln.bricksum.com/docs/en/api-reference/chat-completions)
- [Authentication](https://kiln.bricksum.com/docs/en/authentication)
- [Usage & billing](https://kiln.bricksum.com/docs/en/usage-billing)
- [Errors](https://kiln.bricksum.com/docs/en/errors)
- [OpenAI SDK](https://kiln.bricksum.com/docs/en/sdks/openai)
- [Migrating from OpenAI](https://kiln.bricksum.com/docs/en/migrating-from-openai)
- [Model catalog](https://kiln.bricksum.com/models)
- Fallback only: [Furiosa tool calling](https://developer.furiosa.ai/latest/en/furiosa_llm/toolcalling.html)

## Base URL

```
https://api.bricksum.com/v1
```

Paths below are relative to that base. The OpenAI SDK appends the path, so `baseURL` is the value above and the code must not also append `/chat/completions`.

Env mapping we will use:

| Env | Value |
| --- | --- |
| `KILN_BASE_URL` | `https://api.bricksum.com/v1` |
| `KILN_API_KEY` | key from the Kiln console, prefix `sk-bk-` |
| `KILN_MODEL` | `qwen3-32b` |

## Auth

```http
Authorization: Bearer sk-bk-...
Content-Type: application/json
```

- Keys start with `sk-bk-` and are scoped to an organization and a project.
- `x-api-key` is read only when `Authorization` is absent. A non-Bearer `Authorization` value is 401 with no fallback.
- A request with no usable key is 401 before it reaches the endpoint.
- Never send the key from the browser.

## Model id

Send `model: "qwen3-32b"`.

From the [Models](https://kiln.bricksum.com/docs/en/models) page (table reads live from the catalog):

| Field | Value |
| --- | --- |
| Id | `qwen3-32b` |
| Display name | Qwen3 32B |
| Status on that page | available |
| Context | 32,768 tokens (prompt + completion together) |
| Input | $0.08 / 1M tokens |
| Output | $0.28 / 1M tokens |
| Streaming | yes |
| Tool calling (`auto`) | yes |
| Forced / named `tool_choice` | no |
| Parallel tool calls | no |
| Structured outputs | no |
| Vision | no |
| Thinking mode | yes |

`GET /v1/models` is the runtime source of truth for which ids are served. It returns `{ object: "list", data: [{ id, object, created, owned_by }] }` and nothing else (no price, no context, no capability flags). `created` is stamped when the gateway builds the response, not when the model was added. `GET /v1/models/{id}` is not served (plain-text 404). An unknown id on chat completions is:

```json
{
  "error": {
    "code": "model_not_found",
    "message": "The model `…` does not exist or you do not have access to it.",
    "param": "model",
    "type": "invalid_request_error"
  }
}
```

### Availability conflict (do not paper over)

Three sources disagree about what is serving today:

1. Models docs table: `qwen3-32b` is **available**; `gpt-oss-120b` is **coming soon**.
2. Public catalog page (`https://kiln.bricksum.com/models`), fetched the same day: the only card whose status line reads **Serving** is `deepseek-v4.1-flash`. The Qwen3 32B card copy includes the words "Coming soon", and it still publishes 32.8K context and the same $0.08 / $0.28 prices.
3. The Models page reproduces a staging `GET /models` body from 2026-09-20 whose only id is `gpt-oss-120b`.

Organizers replaced `gpt-oss-120b` with Qwen3-32B because tool calling failed their tests. This repo will set `KILN_MODEL=qwen3-32b`. The first real call must `GET /v1/models` and refuse to proceed if that id is absent, rather than silently falling back to another model. Mock mode does not count as that check.

## Endpoint

Use non-streaming chat completions for the expense parser. Generations are short JSON, so the ~100s edge timeout on a silent non-streaming response is not the risk. Streaming is available if a call starts running long.

```
POST https://api.bricksum.com/v1/chat/completions
```

### Request

```json
{
  "model": "qwen3-32b",
  "messages": [
    { "role": "system", "content": "Reply with one JSON object and no other text." },
    { "role": "user", "content": "<expense text + document text>" }
  ],
  "max_tokens": 2048,
  "temperature": 0
}
```

Documented request rules that matter here:

| Field | Status | What we will do |
| --- | --- | --- |
| `model`, `messages` | supported, required | Always send both. Empty `messages` is 400 `empty_array` and is not billed. |
| `max_tokens` | supported | Set generously. Reasoning tokens count toward the cap. `finish_reason: "length"` can come back with empty `content`. Docs say leave 500 or more; we will use 2048 so a thinking trace cannot eat the JSON. |
| `temperature` | passed through, not verified by Kiln | Send `0` for extraction. |
| `response_format` | **not supported** | Do not send it. `json_object` and `json_schema` are accepted with 200 and return **empty content**. Ask for JSON in the prompt, then validate in our code. |
| `tools` + `tool_choice: "auto"` | supported on this model | Optional. Every function needs a `description` or the server returns 400. The model may answer with no tool call; never index `tool_calls[0]` without a check. |
| `tool_choice: "required"` or a named function | **not applied** on `qwen3-32b` | Do not use. The request can 200 and the model can answer in prose. |
| `parallel_tool_calls` | not applied | Do not rely on more than one tool call. |
| `stop` | ignored | Do not use stop sequences to cut JSON. |
| `reasoning_effort` | documented for `gpt-oss-120b` (`low` / `medium` / `high`) | Not documented for `qwen3-32b`. Do not send it until a real response shows it is accepted. |
| `stream` | supported, default false | Leave false for the parser. |

`temperature` is passed through and not verified. If a real call rejects it, drop the field and record that in this file.

### Response

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "qwen3-32b",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "{ ...json... }",
        "tool_calls": [
          {
            "id": "call_...",
            "type": "function",
            "function": { "name": "...", "arguments": "{...json string...}" }
          }
        ]
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0,
    "prompt_tokens_details": { "cached_tokens": 0 },
    "completion_tokens_details": { "reasoning_tokens": 0 },
    "cost": 0
  }
}
```

`tool_calls` is present only when the model called a tool. `content` is null on a pure tool-call reply. `finish_reason` is `stop`, `length`, or `tool_calls`.

Response header on every metered call:

```
X-Neocloud-Generation-Id: <usage event id>
```

Store it on the `LlmCall` row. `GET /models` and `POST /messages/count_tokens` do not send it.

`usage.cost` is added by the Kiln gateway and is **not** in the OpenAI TypeScript schema. Read it off the raw JSON (or a widened type). It is USD charged to credits.

## Usage fields we meter

| Field | Meaning | Show in the metrics panel? |
| --- | --- | --- |
| `usage.prompt_tokens` | Input tokens | Yes, per flow (`parse`, and `classify` if that call exists) |
| `usage.completion_tokens` | Output tokens, **including** reasoning tokens | Yes. This is the completion count. |
| `usage.total_tokens` | prompt + completion | Yes |
| `usage.completion_tokens_details.reasoning_tokens` | Reasoning / thinking tokens. Subset of `completion_tokens`. Billed as output. Omitted when the model does not report them. | Count them (they are already inside `completion_tokens`). **Do not display them.** |
| `usage.prompt_tokens_details.cached_tokens` | Prompt tokens served from the prefix cache. Subset of `prompt_tokens`. Present only when reported. | Store if present. No separate panel line required for the demo. |
| `usage.cost` | USD deducted for this request | Store on `LlmCall`. Not a token count. |

Cost formula from the docs (cached tokens are a subset of prompt tokens):

```
cost = (prompt_tokens - cached_tokens) × input price
     + cached_tokens                    × cached-input price
     + completion_tokens                × output price
```

Published prices for `qwen3-32b`: input $0.08 / 1M, output $0.28 / 1M. A cached-input price is not in the Models table. Prefer `usage.cost` from the response over recomputing.

Token budgets in the spec are placeholders. The panel must show these measured fields, not assumed budgets.

## Limits

| Limit | Value | Source |
| --- | --- | --- |
| `qwen3-32b` context | 32,768 tokens, prompt + completion | Models page |
| Gateway context cap | 131,072 tokens | API reference "Limits" |
| Request body | first 8 MiB | API reference |
| Gateway timeout | 60 minutes | API reference |
| Silent non-streaming connection | can be cut after ~100 seconds | API reference |
| Default RPM | 60 requests/min per organization | API reference |
| Concurrency | 8 in flight | API reference |
| Rate-limit header | `x-ratelimit-reset` (seconds) on RPM/TPM 429; absent on the concurrency 429 | Errors page |

The binding context for this model is 32,768. The 131,072 figure is the gateway-wide cap and matches the larger models, not Qwen3-32B.

## Errors

Branch on HTTP status and `error.code`, never on `message`.

| Status | Typical `error.code` | Billable? | Client behavior |
| --- | --- | --- | --- |
| 400 | `empty_array`, `unsupported_parameter`, or none | no | Fix the payload. Do not retry as sent. Schema re-ask is our own second prompt, not a retry of a 400. |
| 401 | none (`error.type: "authorization"`) | no | Bad or missing key. |
| 402 | none | no | Credits, org budget, or key spend limit exhausted. |
| 403 | none | no | Key suspended or revoked. |
| 404 | `model_not_found` | no | Id not served. Re-read `GET /models`. |
| 429 | `rate_limit_exceeded` | no | Wait `x-ratelimit-reset` when present; otherwise exponential backoff. |
| 502 | plain text, not JSON | no | Backoff and retry. |
| 503 | plain text, or JSON `type: "maintenance"` with `Retry-After` | no | Honor `Retry-After` during maintenance. |

Gateway rejections (401, 402, 403, RPM/TPM 429):

```json
{ "error": { "message": "…", "type": "authorization" } }
```

Validation errors add `param` and `code`, with `type: "invalid_request_error"`.

502 and a no-backend 503 are `text/plain`. Do not `JSON.parse` those bodies.

An AI call that fails, times out, or returns unusable output is a **HOLD** in our policy flow (spec rule: never APPROVE on AI failure). That decision is ours; Kiln does not know about it.

## How we will get the JSON

Documented limitations decide this. Structured outputs are off for `qwen3-32b`, and `response_format` returns empty content. Forced tool choice is not applied.

1. Primary path: system prompt says "one JSON object, no other text". Parse `choices[0].message.content`.
2. Validate against the expense schema. On failure, one re-ask with the validation error appended. On a second failure, HOLD.
3. Do not send `response_format`.
4. Do not send `tool_choice: "required"`.

Furiosa's page says the Qwen3 series uses the `hermes` tool-call parser **on their server**, which then emits OpenAI `tool_calls`. Kiln already documents OpenAI `tool_calls` on the response. Parse `message.tool_calls[].function.arguments` only if we later opt into `tool_choice: "auto"`. Do not scrape Hermes tags out of `content` unless a real Kiln response has no `tool_calls` and the content is clearly a tool call. The Furiosa page does not document the raw tag grammar; do not invent it.

## Thinking tokens

`qwen3-32b` has thinking mode. Kiln reports that as `usage.completion_tokens_details.reasoning_tokens`, which is already included in `completion_tokens` and in `usage.cost`.

Client rule: persist `reasoning_tokens` when the field is present, and keep it out of the metrics panel.

Whether `message.content` also contains a visible thinking block (for example a `<think>` wrapper) is **not stated** in the Kiln docs. Check the first real response. If a wrapper is present, strip it before JSON parse and do not show it.

## Assumptions

Labeled so they are not mistaken for documented facts:

1. **`KILN_BASE_URL` includes `/v1`.** The docs' `base_url` is `https://api.bricksum.com/v1`. The Anthropic SDK is the exception (it wants the host without `/v1`); we are not using that SDK.
2. **Model id string is `qwen3-32b`.** Taken from the Models page id column. Confirm with `GET /v1/models` on the first keyed run. If the served id differs, change `KILN_MODEL` to the served id and update this file. Do not guess another id.
3. **`temperature: 0` is accepted.** Status in the docs is "passed through, not verified".
4. **Non-streaming is safe for this prompt size.** Revisit if a real call is cut around 100 seconds.
5. **No `reasoning_effort` on Qwen3-32B** until a real response proves the field is accepted. The docs only name values for `gpt-oss-120b`.
6. **Cached-input price for this model is unpublished** on the Models table. Trust `usage.cost`.
7. **MockKilnClient is not Kiln evidence.** It replays recorded JSON of the shape above so the app can run before the key arrives. Metrics from mock calls must be labeled mock and must not be pasted into the README evidence table.

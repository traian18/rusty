# Agent protocol semantics

`AgentEnvelope` (`envelope.ts`) carries six identifier/ordering fields.
They look similar and are easy to confuse, so this document is the one
place that defines what each identifies and how they relate. Every
sender constructs, and every receiver consumes, all six -- there is no
partial/legacy form of the envelope (see the "Legacy" note at the
bottom).

## The fields

### `conversationId`

Identifies a conversation thread in the UI -- typically a tab (an agent
chat tab, a canvas tab, a task tab). Stable for the lifetime of that
tab. Multiple runs (see `runId` below) can share a `conversationId`
when a tab is used more than once (e.g. re-running a node, or sending a
follow-up message in the same chat).

Not unique per message: every envelope in every run belonging to that
tab carries the same `conversationId`.

### `runId`

Identifies one execution: one agent run, one node execution, one
chat turn that produces a stream of events. This is the id
`AgentHarnessClient` keys its per-run listener subscriptions
(`subscribe(runId, listener)`), its sequence-tracking maps
(`incomingSequences`/`outgoingSequences`), and `replayRun()` on.

A `runId` is created fresh each time work starts (`startRun()`), even
if the `conversationId` (tab) is reused. It never changes for the
duration of that run, including across a reconnect -- `replayRun(runId)`
re-subscribes to the *same* run after the socket comes back, it does
not start a new one.

### `messageId`

Identifies one envelope: one wire message. Globally unique
(`crypto.randomUUID()`), used for de-duplication and logging/tracing a
single event, never reused even for a retransmit of logically the same
event -- a resend gets a new `messageId` but keeps the same `sequence`
(see below), which is what lets a receiver tell "this is the same
logical event arriving twice" (`sequence` unchanged) apart from "this
is genuinely the next event" (`sequence` incremented).

### `correlationId` (optional)

Pairs a request with its response for the reverse-RPC surface (a
`read_file` request and its `read_file_response`, a
`command_permission_request` and its `..._response`, and similarly for
`write_file`/`write_plan`/`agent_question`). Set by whichever side
initiates the request; echoed back unchanged by whichever side answers
it. Distinct from `runId`: a single run can have many outstanding
request/response pairs in flight, each with its own `correlationId`,
all sharing the same `runId`.

Not used for normal one-directional stream events (tokens, tool-use
events, lifecycle events) -- only for the request/response subset.

### `agentId` / `parentAgentId` (optional)

`agentId` identifies which agent (in the sidecar's sense -- the LLM
session driving one run) produced this envelope. `parentAgentId` is
set only for a sub-agent spawned by delegation, naming the `agentId`
of the agent that spawned it -- this is what lets the UI attribute a
sub-agent's events back to the delegating run without conflating the
two agents' event streams. Absent for a top-level agent with no
parent.

### `sequence`

A run-scoped, monotonically increasing integer, starting at the first
event's `sequence` and incrementing by exactly 1 per envelope within
that `runId`. This is what makes ordering, duplicate-detection, and
gap-detection possible without relying on wall-clock time or transport
delivery order:

- **Ordering**: a receiver processes envelopes for a given `runId` in
  `sequence` order; `AgentHarnessClient.handleIncoming()` drops (does
  not just reorder) anything at or below the highest `sequence` it has
  already accepted for that `runId`.
- **Duplicate detection**: a resend of the same logical event (same
  `sequence`, new `messageId` -- see above) is recognized as a duplicate
  by comparing against `incomingSequences.get(runId)`, and dropped.
- **Idempotency**: because a duplicate is dropped rather than
  reprocessed, listeners never observe the same `sequence` twice for a
  given `runId` -- a retransmit after a reconnect is safe to replay
  blindly.
- **Gap detection**: if an incoming `sequence` jumps by more than 1
  past the last one accepted, `client.sequence_gap` is emitted as a
  diagnostic (events may have been lost, e.g. a reconnect window that
  wasn't fully replayed) -- the message is still accepted, but the gap
  is surfaced rather than silently ignored.

`sequence` is unrelated to `timestamp` -- `timestamp` is wall-clock,
informational only, and never used for ordering or dedup decisions.

## Legacy note

`parseAgentMessage` used to have a `"legacy"` result kind for messages
without a `protocolVersion` field, from before this envelope existed.
Every message-construction site in this codebase (client and sidecar)
has always set `protocolVersion` for as long as this envelope has
existed, so nothing here can produce that shape anymore -- it is now
rejected as a `PROTOCOL_INVALID_MESSAGE` protocol error rather than
parsed into a distinct branch call sites had to handle.

import { chat } from "@trigger.dev/sdk/ai";
import { streamText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

/**
 * A multi-turn, streamed chat agent.
 *
 * `chat.agent` pre-types the payload and auto-pipes the stream, so `run` just
 * returns the `StreamTextResult`. Spreading `chat.toStreamTextOptions()` is not
 * optional: it is what wires the agent's managed stream, usage tracking and
 * message handling into `streamText`. Omitting it does not throw, it just fails
 * silently, so leave the spread in.
 *
 * Two things that differ from the plain `task()` in ./server-health.ts:
 *
 * 1. `run` here takes the destructured payload (`{ messages, signal }`) because
 *    `chat.agent` pre-types it as `ChatTaskRunPayload`. A plain `task()`'s run
 *    instead takes two arguments, `(payload, { ctx, signal })`.
 * 2. `ChatAgentOptions` omits `retry`, so retries are not configurable on a chat
 *    agent — the multi-turn loop and the idle/stop handling replace them.
 *
 * `messages` arrives already converted for the model and `signal` aborts the
 * turn when the client stops generation, so both are passed straight through.
 *
 * Requires an ANTHROPIC_API_KEY available to the task. In local dev the CLI
 * loads the project's `.env` by default, so adding it there is enough to run
 * this; the deployed environment needs it set in the Trigger.dev dashboard too.
 */
export const myChat = chat.agent({
  id: "my-chat",
  run: async ({ messages, signal }) => {
    return streamText({
      ...chat.toStreamTextOptions(),
      model: anthropic("claude-sonnet-4-5"),
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(15),
    });
  },
});

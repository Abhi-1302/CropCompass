import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { ApiError, streamApi } from "../src/api/client.ts";
import { completedHistory } from "../src/features/sprout/history.ts";

beforeEach(() => Object.defineProperty(globalThis, "document", { value: { cookie: "" }, configurable: true }));
afterEach(() => Reflect.deleteProperty(globalThis, "document"));

test("streams split UTF-8 events with same-origin credentials and CSRF", async context => {
  globalThis.document.cookie = "af_csrf=test-csrf";
  const text = "event: delta\ndata: " + JSON.stringify({ text: "నేల मिट्टी" }) + "\n\n" +
    "event: done\ndata: {}\n\n";
  const bytes = new TextEncoder().encode(text);
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.headers["X-CSRF-Token"], "test-csrf");
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const received = [];
  await streamApi("/chat/test", {}, new AbortController().signal, (kind, data) => received.push({ kind, data }));
  assert.deepEqual(received, [{ kind: "delta", data: { text: "నేల मिट्टी" } }, { kind: "done", data: {} }]);
});

test("rejects incomplete streams instead of treating partial text as saved", async context => {
  context.mock.method(globalThis, "fetch", async () => new Response('event: delta\ndata: {"text":"partial"}\n\n', {
    headers: { "content-type": "text/event-stream" },
  }));
  await assert.rejects(() => streamApi("/chat/test", {}, new AbortController().signal, () => {}),
    error => error instanceof ApiError && error.message === "interrupted");
});

test("preserves authentication errors and rejects HTML proxy responses", async context => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response('{"detail":"Not signed in"}', {
    status: 401, headers: { "content-type": "application/json" },
  }));
  await assert.rejects(() => streamApi("/chat/test", {}, new AbortController().signal, () => {}),
    error => error instanceof ApiError && error.status === 401);
  fetchMock.mock.mockImplementation(async () => new Response("<html>not an API</html>", {
    headers: { "content-type": "text/html" },
  }));
  await assert.rejects(() => streamApi("/chat/test", {}, new AbortController().signal, () => {}),
    error => error instanceof ApiError && error.status === 502);
});

test("completed stream fills history before a slow database refresh", () => {
  const thread = { id: "thread", farm_id: "farm", title: "Sprout", language: "en" as const,
    scenario: {}, version: 0, updated_at: "2026-10-27T00:00:00Z" };
  const run = { id: "run", request_id: "request", user_message_id: "question", state: "running" as const,
    error_code: null, cancel_requested: false };
  const answer = { id: "answer", sequence: 2, role: "assistant" as const, content: "Grounded answer",
    evidence: { scenario: { irrigation: "protective" as const } }, created_at: "2026-10-27T00:00:01Z" };
  const first = completedHistory(undefined, thread, run, "My farm?", answer);
  assert.deepEqual(first.messages.map(message => message.role), ["user", "assistant"]);
  assert.equal(first.run.state, "complete");
  assert.equal(first.thread.version, 1);
  assert.equal(first.thread.scenario.irrigation, "protective");
  const duplicate = completedHistory({ ...first, before: 1 }, thread, run, "My farm?", answer);
  assert.equal(duplicate.messages.length, 2);
  assert.equal(duplicate.before, 1);
  assert.equal(duplicate.thread.version, 1);
});
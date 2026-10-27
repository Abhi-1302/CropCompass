import type { SproutHistory, SproutMessage, SproutRun, SproutThread } from "./types";

export function completedHistory(
  current: SproutHistory | undefined,
  thread: SproutThread,
  run: SproutRun,
  question: string,
  answer: SproutMessage,
): SproutHistory {
  const messages = [...(current?.messages ?? [])];
  if (!messages.some(message => message.id === run.user_message_id)) {
    messages.push({
      id: run.user_message_id, sequence: answer.sequence - 1, role: "user", content: question,
      evidence: {}, created_at: answer.created_at,
    });
  }
  if (!messages.some(message => message.id === answer.id)) messages.push(answer);
  return {
    thread: {
      ...(current?.thread ?? thread),
      title: thread.version === 0 ? question.slice(0, 80) : thread.title,
      version: Math.max(current?.thread.version ?? 0, thread.version + 1),
      scenario: answer.evidence.scenario ?? thread.scenario,
      updated_at: answer.created_at,
    },
    messages: messages.sort((left, right) => left.sequence - right.sequence),
    before: current?.before ?? null,
    run: { ...run, state: "complete", error_code: null, cancel_requested: false },
  };
}
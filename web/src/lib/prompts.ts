// prompts.ts — prompt builders for the 02 auto-RAG agent scenario.
// Mirrors reference/02_auto_rag_agent/prompts.py: the incident + operating
// procedure that INDUCES progressive disclosure (the folder's teaching point),
// plus the per-step decision prompt and the decision schema hint.
import type { StepView } from '@/types';

export const INCIDENT_QUESTION =
  'A service is pegging CPU and its storage shards are restarting with error ' +
  'E1342. What is the likely root cause and the safe remediation?';

// Cheap search/summaries first, expensive full bodies only when justified.
export const OPERATING_PROCEDURE = [
  'OPERATING PROCEDURE — follow it exactly to control token cost:',
  'ANTI-LOOP RULES (read first):',
  '- Do NOT repeat a tool call you have already made — each step must make NEW progress (open a specific doc id, or finish).',
  '- search_corpus takes ONLY {query, k}. To read a specific document use get_doc_summary/get_doc with its doc_id — never pass a doc_id to search_corpus.',
  '1. search_corpus(query, k) FIRST — you get ids+titles+summaries only (cheap, no bodies).',
  '2. For the most promising hits, call get_doc_summary (still cheap). Do NOT summarize everything.',
  '3. Call get_doc (the FULL body, the expensive read) for ONLY the 1-2 docs whose summary proves',
  '   they are worth opening. Say in one line why each earned a full read.',
  '4. Decide the remediation. propose_action with the single best WHITELISTED kind + a target.',
  '   If an action is refused as off-whitelist, pick an allowed kind instead.',
  '5. apply_action_dry_run on your proposal to preview it safely (never real execution).',
  '6. mark_done with {root_cause, remediation} to finish.',
  'As soon as you can state {root_cause, remediation}, call mark_done — do not keep searching. Aim for under 6 tool calls total.',
].join('\n');

const TOOL_MENU =
  'Tools: search_corpus(query,k,method), get_doc_summary(doc_id), get_doc(doc_id), ' +
  'propose_action(kind,target,params), apply_action_dry_run(action_id), mark_done(result).';

/** The system prompt that frames the agent + enables Gemma thinking downstream. */
export function systemPrompt(): string {
  return (
    'You are an autonomous SRE incident agent. You solve the incident by deciding, ' +
    'for yourself, which tool to call next, over a fixed menu of six tools. Do not ' +
    'use shell, git, or web tools — only the six listed.\n\n' +
    `INCIDENT: ${INCIDENT_QUESTION}\n\n${OPERATING_PROCEDURE}\n\n${TOOL_MENU}`
  );
}

/**
 * A LIGHT system framing for the THINKING step. Unlike systemPrompt(), it deliberately
 * OMITS the numbered OPERATING_PROCEDURE: handing a small model a numbered plan every
 * turn makes it echo that plan back as a long "Thinking Process: 1… 2… 3…" instead of
 * reasoning about only the next action. The full procedure + tool constraints still
 * govern the DECISION step (which keeps systemPrompt()); thinking just needs the role
 * + incident + the most-recent state, then a short forward nudge.
 */
export function thinkingSystemPrompt(): string {
  return (
    'You are an autonomous SRE incident agent working one step at a time. You are mid-investigation; ' +
    'do NOT restate or re-plan the whole task. Reason ONLY about your single next action from the most ' +
    'recent observation.\n\n' +
    `INCIDENT: ${INCIDENT_QUESTION}`
  );
}

/**
 * Build the per-step context (the agent's working memory): the incident + a
 * transcript of prior (tool -> observation) pairs. Handing this back each turn is
 * what lets a stateless model act multi-step (mirrors decide_prompt in prompts.py).
 */
export function buildContext(question: string, history: StepView[]): string {
  const lines: string[] = [];
  for (const step of history) {
    // Each prior step contributes its decision + observation panels as memory.
    const decision = step.panels.find((p) => p.key === 'decision');
    const observation = step.panels.find((p) => p.key === 'observation');
    if (decision) lines.push(`- ${decision.body}`);
    if (observation) lines.push(`  → ${observation.body}`);
  }
  const transcript = lines.length > 0 ? lines.join('\n') : '(no tools called yet)';
  return `INCIDENT: ${question}\n\nLoop so far:\n${transcript}`;
}

/** The instruction for the native "thinking" step — keeps reasoning short + forward. */
export function thinkingInstruction(): string {
  return (
    'In 2-4 short sentences, reason about ONLY your single next action, based on the MOST RECENT ' +
    'observation above. Do NOT restate the incident, do NOT re-plan from scratch, and do NOT output a ' +
    'numbered plan or "Thinking Process" list. Decide the one next tool call that makes new progress ' +
    '(open a specific doc, propose an action, or finish).'
  );
}

/** The instruction appended before a decision; pairs with the schema hint. */
export function decideInstruction(stepIndex: number, maxSteps: number): string {
  return (
    `Pick the single NEXT tool call that makes NEW progress (step ${stepIndex + 1}/${maxSteps}). ` +
    'Do not repeat a call you already made: triage on summaries, then open only the ' +
    '1-2 best doc ids in full. As soon as you know {root_cause, remediation}, call ' +
    'mark_done instead of searching more.'
  );
}

/** Schema hint for llm.decide(): the shape of a single tool-call JSON. */
export function decisionSchemaHint(): string {
  return [
    '{',
    '  "tool": one of "search_corpus" | "get_doc_summary" | "get_doc" | "propose_action" | "apply_action_dry_run" | "mark_done",',
    '  "args": an object with the arguments for that tool, e.g.',
    '    search_corpus -> {"query": string, "k": number},',
    '    get_doc_summary / get_doc -> {"doc_id": string},',
    '    propose_action -> {"kind": string, "target": string},',
    '    apply_action_dry_run -> {"action_id": string},',
    '    mark_done -> {"result": {"root_cause": string, "remediation": string}}',
    '}',
  ].join('\n');
}

/**
 * The CONCLUSION prompt: after the agent loop ends (mark_done, the step budget, or a
 * completed propose→dry-run), the model writes the FINAL answer to the incident from
 * everything it gathered. WHY this exists: a tool loop that stops on the budget left a
 * dangling tool call and NO answer ("应该给个 root cause 不是么?"). A research/incident
 * agent must end on a stated conclusion, not a tool call. Grounded ONLY in the
 * transcript — no new tools, no invention. Mirrors 04_search's final synthesis so all
 * the agent scenarios end the same way: a conclusion, not a dangling action.
 */
export function conclusionSystemPrompt(): string {
  return (
    'You are an SRE incident agent writing your FINAL conclusion. Using ONLY the ' +
    'investigation transcript below (the tools you called and what they returned), ' +
    'state the answer to the incident. Be concise and concrete. Format EXACTLY:\n' +
    'ROOT CAUSE: <one or two sentences>\n' +
    'REMEDIATION: <the specific safe fix, naming the action/command from the runbook>\n' +
    'Do not call any tools. Do not invent facts not supported by the transcript.'
  );
}

/** Build the conclusion user message from the incident + the full loop transcript. */
export function conclusionUserPrompt(question: string, transcript: string): string {
  return (
    `INCIDENT: ${question}\n\n` +
    `Investigation transcript (your tool calls + their results):\n${transcript}\n\n` +
    'Write the final ROOT CAUSE and REMEDIATION now:'
  );
}

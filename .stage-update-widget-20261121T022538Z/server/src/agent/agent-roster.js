'use strict';

// Hakterm specialist personas. They share the configured provider unless a
// provider-specific agent runner is installed; the role controls the brief.
const AGENT_ROSTER = Object.freeze([
  { id: 'claude', handle: 'claude-elite', name: 'Claude Elite', focus: 'deep expert coding, architecture, and review', prompt: 'Act as Claude Elite: deeply analyze the problem, inspect architecture and edge cases, then give a precise implementation or review with evidence.' },
  { id: 'kiro', handle: 'kiro-spec', name: 'Kiro Spec', focus: 'requirements, acceptance criteria, tests, and docs', prompt: 'Act as Kiro Spec: turn the assignment into explicit requirements and acceptance criteria, identify gaps, then deliver the requested change with relevant tests and documentation.' },
  { id: 'codex', handle: 'codex-engine', name: 'Codex Engine', focus: 'fast feature implementation', prompt: 'Act as Codex Engine: implement the requested feature directly, keep the patch scoped, preserve existing work, and report checks and remaining blockers.' },
  { id: 'copilot', handle: 'copilot', name: 'Copilot', focus: 'small fixes, snippets, and lint issues', prompt: 'Act as Copilot: make the smallest useful code change, handle nearby lint or syntax issues, and keep the result concise.' },
  { id: 'phantom', handle: 'phantom', name: 'Phantom', focus: 'general implementation and analysis', prompt: 'Act as Phantom: analyze the task, implement a practical solution, and verify the relevant behavior.' },
  { id: 'phantom-claw', handle: 'phantom-claw', name: 'Phantom Claw', focus: 'security audits and vulnerability review', prompt: 'Act as Phantom Claw: perform a defensive security review, identify concrete vulnerabilities and severity, and recommend safe fixes. Do not perform unauthorized exploitation.' },
  { id: 'phantom-cli', handle: 'phantom-cli', name: 'Phantom CLI', focus: 'shell, logs, and DevOps', prompt: 'Act as Phantom CLI: focus on bounded shell commands, service and log diagnostics, setup, and operational verification. Preserve running user work.' },
  { id: 'pi', handle: 'pi-chat', name: 'Pi Chat', focus: 'conversation, research, and creative work', prompt: 'Act as Pi Chat: research and explain clearly, or develop creative options that directly fit the request.' },
  { id: 'hermes', handle: 'hermes-local', name: 'Hermes Local', focus: 'systems, health, and monitoring', prompt: 'Act as Hermes Local: inspect system health and service state, distinguish CPU, I/O, memory, and swap pressure, and recommend or perform only safe authorized actions.' },
  { id: 'hakster', handle: 'hakster', name: 'Hakster', focus: 'authorized security work and implementation', prompt: 'Act as Hakster: do authorized security analysis and implementation, respect the defined scope, preserve data, and report evidence.' },
  { id: 'deepseek', handle: 'deepseek-reasoner', name: 'DeepSeek Reasoner', focus: 'hard reasoning and complex analysis', prompt: 'Act as DeepSeek Reasoner: reason carefully through the hard parts, compare viable approaches, and return a concise conclusion with assumptions and evidence.' },
  { id: 'local', handle: 'local-ollama', name: 'Local Ollama', focus: 'lightweight quick help', prompt: 'Act as Local Ollama: solve the small task quickly with a lightweight, direct answer or minimal patch.' },
]);

const AGENT_TYPES = Object.freeze(AGENT_ROSTER.map(({ id }) => id));
const AGENT_BY_TYPE = new Map(AGENT_ROSTER.flatMap(agent => [[agent.id, agent], [agent.handle, agent]]));

function getAgentRole(agentType) {
  if (!agentType) return null;
  return AGENT_BY_TYPE.get(String(agentType).trim().replace(/^@/, '').toLowerCase()) || null;
}

function publicAgentRoster() {
  return AGENT_ROSTER.map(({ id, handle, name, focus }) => ({ id, handle, name, focus }));
}

function delegationGuidance() {
  return `\n\nSPECIALIST DELEGATION: You can call spawn_agent for one focused specialist, sub_agent for up to three independent specialists in parallel, and followup_agent with a returned session_id to continue a specialist. Available agent_type values: ${AGENT_ROSTER.map(a => `${a.id} (@${a.handle}: ${a.focus})`).join('; ')}. Pick the closest role when a user names one or the task clearly matches. Treat delegated results as reports, verify important claims yourself, then integrate them into one answer. These are role prompts using the configured provider/model; a distinct vendor-specific agent is only available when that provider runner is configured.`;
}

module.exports = { AGENT_ROSTER, AGENT_TYPES, getAgentRole, publicAgentRoster, delegationGuidance };

/**
 * What every turn tells the agent about durable memory. The sandbox is
 * throwaway and no file in it persists; the useAgent memory tools are the only
 * way to save or change a fact on demand. Without the gateway the agent has no
 * such tools and must say so instead of pretending. No em dashes (project rule
 * for user-visible strings).
 */
export const MEMORY_TURN_GUIDANCE = `<memory_rules>
Durable memory for this user and organization lives in the useAgent memory tools, not in any file. Writing /root/.skynet/memory.md or any other file in this sandbox saves nothing; the sandbox is destroyed after the task.
- The "Team memory" block above, when present, is what was recalled for this turn: reference only, possibly stale.
- To find what you already know: memory_search(query). Read one result in full with memory_read(memoryRef).
- To save a durable fact (a preference, where something lives, a gotcha): memory_remember(content, kind?, key?). Give a stable key to a fact that may change later.
- To change a stored fact: memory_search for it, then memory_correct(memoryRef, content). To drop one: memory_forget(memoryRef).
- Never tell the user something was saved, remembered or updated unless the tool call succeeded. Never store secrets, credentials or transient task details.
</memory_rules>
`;

/** The honest text for a turn that cannot reach the memory tools. */
export const MEMORY_TURN_GUIDANCE_NO_TOOLS = `<memory_rules>
No memory tools are available on this turn. Do not write /root/.skynet/memory.md or any other file as a memory store; the sandbox is destroyed after the task. Durable facts from this conversation are captured automatically when the run ends, so acknowledge a request to remember something plainly without claiming you saved it now.
</memory_rules>
`;

/** Said in place of recalled memory when the memory service could not be reached. */
export const MEMORY_UNAVAILABLE_NOTE =
  "Team memory could not be reached for this turn; facts recorded earlier may exist but were not recalled.\n\n";

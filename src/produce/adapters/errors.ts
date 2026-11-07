/** Worth another try later: the tool wasn't reachable, ran out of memory, or timed out. */
export class Retryable extends Error {}

/** Trying again won't help: bad parameters, a template or composition error. The message goes back to the agent. */
export class Fatal extends Error {}

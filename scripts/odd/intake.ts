// Outcome driven development: Slack intake (docs/odd/README.md §4, §5.2). Pure functions;
// the control-plane plugin polls `#factory-intake` with slack_read and spawns Intake per message.
// Slack's Events API needs a challenge response an Amp webhook handler cannot send, so intake
// polls instead of receiving pushes.

export const intakeChannel = '#factory-intake';
/** Reaction the control plane adds once Intake has been spawned for a message. */
export const intakeEmoji = 'inbox_tray';

/** Subset of a `slack_read read_messages` message the intake needs. */
export type SlackMessage = {
  ts: string;
  text: string;
  threadTs?: string;
  userID?: string;
  userName?: string;
  /** Amp thread that posted the message; set only for Amp's own posts. */
  originThreadID?: string;
  reactions?: readonly { name: string; count?: number }[];
};

/**
 * Top-level human messages not yet handed to Intake: thread replies, Amp's own posts, join
 * notices and messages already carrying the intake reaction are skipped. Oldest first, so
 * spawn order follows arrival order.
 */
export function pendingIntake(messages: readonly SlackMessage[]): SlackMessage[] {
  return messages
    .filter(message => !(message.threadTs && message.threadTs !== message.ts))
    .filter(message => !message.originThreadID)
    .filter(message => !/\bhas joined the channel\b/.test(message.text))
    .filter(message => !(message.reactions ?? []).some(reaction => reaction.name === intakeEmoji))
    .filter(message => message.text.trim() !== '')
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** Amp thread label (alphanumeric and hyphens, at most 32 characters) naming the message. */
export const slackSourceLabel = (ts: string) => `odd-slack-${ts.replace(/[^0-9]/g, '-')}`.slice(0, 32);

/** The first user message of an Intake thread started from Slack. */
export function intakePrompt(message: SlackMessage, marker: string): string {
  const author = message.userName ?? message.userID ?? 'unknown';
  return [
    `${marker} Intake from Slack ${intakeChannel} (message ts ${message.ts}, from ${author}). Load the \`odd-intake\` skill and start.`,
    'Record the source in Context as the channel and message ts. Message:',
    '',
    message.text.replace(/^\(Reply from [^)]*\)\s*/, ''),
  ].join('\n');
}

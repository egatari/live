// SPDX-License-Identifier: AGPL-3.0-only
// Egatari Live: abuse limits and room defaults. All limits are constants on purpose:
// changing one is a protocol-visible change (learners see them in `welcome.limits`).

export const PROTOCOL_VERSION = 1;

// Sizes (bytes of the raw WebSocket frame, UTF-8)
export const MAX_LEARNER_MESSAGE_BYTES = 2048;
export const MAX_TEACHER_MESSAGE_BYTES = 32768;
export const MAX_CREATE_BODY_BYTES = 32768;

// Text caps (characters, after trimming)
export const MAX_QUESTION_CHARS = 500;
export const MAX_NAME_CHARS = 40;
export const MAX_PROMPT_CHARS = 300;
export const MAX_CHOICE_CHARS = 100;

// Rate limit per learner connection: token bucket
export const RATE_BURST = 5;              // messages that may arrive at once
export const RATE_REFILL_MS = 2000;       // one token back every 2 s
export const RATE_MAX_DROPS = 10;         // dropped messages before the connection is closed (4429)

// Per participant / per room
export const MAX_QUESTIONS_PER_PARTICIPANT = 20;
export const MAX_LEARNER_CONNECTIONS = 300;   // concurrent learner sockets in one room (room size)
export const MAX_PARTICIPANTS = 1000;         // distinct participant ids ever seen in one room
export const MAX_WAITING = 300;
export const MAX_ITEMS = 1000;                // Q&A items per room
export const MAX_SHOWN = 50;                  // items projected at once
export const MAX_TEACHER_CONNECTIONS = 4;
export const MAX_ACTIVITIES = 64;
export const MAX_CHOICES = 12;
export const TEACHER_AUTH_TIMEOUT_MS = 10000;

// Window and lifetime
export const CLOCK_SKEW_MS = 2 * 60 * 1000;            // leeway for learners' clocks at window edges
export const MAX_WINDOW_MS = 7 * 24 * 3600 * 1000;     // one room covers at most 7 days
export const MAX_START_AHEAD_MS = 180 * 24 * 3600 * 1000;
export const DEFAULT_GRACE_HOURS = 24;
export const MAX_GRACE_HOURS = 168;                     // 7 days

export function publicLimits() {
  return {
    messageBytes: MAX_LEARNER_MESSAGE_BYTES,
    questionChars: MAX_QUESTION_CHARS,
    nameChars: MAX_NAME_CHARS,
    questionsPerParticipant: MAX_QUESTIONS_PER_PARTICIPANT,
    burst: RATE_BURST,
    refillMs: RATE_REFILL_MS,
  };
}

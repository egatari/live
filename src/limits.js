// SPDX-License-Identifier: AGPL-3.0-only
// Egatari Live: abuse limits and room defaults. All limits are constants on purpose:
// changing one is a protocol-visible change (learners see them in `welcome.limits`).

export const PROTOCOL_VERSION = 1;

// Sizes (bytes of the raw WebSocket frame, UTF-8)
export const MAX_LEARNER_MESSAGE_BYTES = 2048;
export const MAX_ASK_MESSAGE_BYTES = 40960;    // an `ask` may carry a circled region: 2000 points of "[1279.9,719.9]," plus the text
export const MAX_TEACHER_MESSAGE_BYTES = 32768;
export const MAX_CREATE_BODY_BYTES = 32768;

// Text caps (characters, after trimming)
export const MAX_QUESTION_CHARS = 500;
export const MAX_NAME_CHARS = 40;
export const MAX_PROMPT_CHARS = 300;
export const MAX_CHOICE_CHARS = 100;
export const MAX_LABEL_CHARS = 80;          // an activity's display label ("Slide 4 'XML', step 1"); text only, never a key
export const MAX_REPLY_CHARS = 200;         // the host's short reply to a question (or a group of questions)

// A circled region on a question: strokes in stage coordinates (1280 x 720), the shape of Studio's review notes
// (contract §12): at most 20 strokes, 500 points each, 2000 points in all; each point [x, y] rounded to 0.1.
export const STAGE_W = 1280;
export const STAGE_H = 720;
export const MAX_REGION_STROKES = 20;
export const MAX_REGION_STROKE_POINTS = 500;
export const MAX_REGION_POINTS = 2000;
export const MAX_REGION_POINTS_PER_ROOM = 40000;   // keeps the host's state message small (about 600 KB at most)

// Rate limit per learner connection: token bucket
export const RATE_BURST = 5;              // messages that may arrive at once
export const RATE_REFILL_MS = 2000;       // one token back every 2 s
export const RATE_MAX_DROPS = 10;         // dropped messages before the connection is closed (4429)

// Per participant / per room. v1 rooms are sized for one class: text Q&A and polls,
// about 40 people, for up to 2 hours. Each cap leaves headroom over that target.
export const MAX_QUESTIONS_PER_PARTICIPANT = 20;
export const MAX_LEARNER_CONNECTIONS = 60;    // concurrent learner sockets: 40 + 50 % (late joiners, a second device)
export const MAX_PARTICIPANTS = 200;          // distinct pids ever: 5x the class, since a new browser or a
                                              // private window makes a new pid; still small enough to bound abuse
export const MAX_WAITING = 60;                // the whole room may be waiting at once
export const MAX_ITEMS = 400;                 // questions per room: 10 per expected learner
export const MAX_SHOWN = 30;                  // projected at once; more does not fit a screen
export const MAX_ROOM_SIZE = MAX_LEARNER_CONNECTIONS;  // the largest `size` a create request may ask for
export const MAX_TEACHER_CONNECTIONS = 4;
export const MAX_ACTIVITIES = 64;
export const MAX_GROUP_ITEMS = 50;            // questions the host groups in one message
// "I don't follow" (kind confused): one mark per participant per step, which the participant can take back.
export const MAX_CONFUSED_STEPS_PER_PARTICIPANT = 100;   // distinct steps one participant may mark
export const MAX_CONFUSED_STEPS = 500;                   // distinct steps counted in one room
export const MAX_CHOICES = 12;
export const TEACHER_AUTH_TIMEOUT_MS = 10000;

// Window and lifetime
export const CLOCK_SKEW_MS = 2 * 60 * 1000;            // leeway for learners' clocks at window edges
export const MAX_WINDOW_MS = 3 * 3600 * 1000;          // 3 h: a 2-hour lesson plus an hour of slack
export const MAX_START_AHEAD_MS = 180 * 24 * 3600 * 1000;
export const DEFAULT_GRACE_HOURS = 24;
export const MAX_GRACE_HOURS = 168;                     // 7 days

// Room creation (per sender, by CF-Connecting-IP). The numbers live in wrangler.toml
// ([[ratelimits]] CREATE_LIMITER: 5 rooms per 60 s); a Cloudflare rate-limiting rule is an extra layer.
export const MAX_TURNSTILE_TOKEN_CHARS = 2048;

export function publicLimits() {
  return {
    messageBytes: MAX_LEARNER_MESSAGE_BYTES,
    questionChars: MAX_QUESTION_CHARS,
    nameChars: MAX_NAME_CHARS,
    questionsPerParticipant: MAX_QUESTIONS_PER_PARTICIPANT,
    burst: RATE_BURST,
    refillMs: RATE_REFILL_MS,
    askBytes: MAX_ASK_MESSAGE_BYTES,
    regionStrokes: MAX_REGION_STROKES,
    regionStrokePoints: MAX_REGION_STROKE_POINTS,
    regionPoints: MAX_REGION_POINTS,
  };
}

// The planted script for the speech-2min fixture.
//
// Each line is synthesised on its own (Windows System.Speech), trimmed to its audible
// extent and placed on the timeline with `gapAfter` seconds of digital silence after it,
// so every line's start and end are known exactly.
//
// kind:
//   normal       an ordinary line, kept in a clean edit
//   retake       one take of a line said two or three times; `group` links the takes,
//                the LAST take of a group is the one to keep
//   false_start  an abandoned beginning of the next line; not kept
//   aside        talk that is not part of the content ("wait, let me redo that"); not kept
//
// Numbers are written as words so the expected words match what the voice says.

export const VOICE_PREFERENCE = ['Microsoft David Desktop', 'Microsoft Zira Desktop'];
export const SPEECH_RATE = 0; // System.Speech rate, -10..10
export const LEAD_IN_SEC = 0.8;
export const TAIL_SEC = 1.5;

export const FILLERS = ['um', 'uh', 'you know', 'like', 'so', 'okay'];

export const SCRIPT = [
  { kind: 'normal', text: 'Okay, so this is the weekly update for the design team.', gapAfter: 0.7 },
  { kind: 'normal', text: 'Um, three things today. The onboarding flow, the billing page, and, uh, the hiring plan.', gapAfter: 0.9 },
  { kind: 'false_start', text: 'So the onboarding', gapAfter: 0.45 },
  { kind: 'normal', text: 'So the onboarding flow is basically done. We shipped the new welcome screen on Tuesday.', gapAfter: 0.6 },
  { kind: 'retake', group: 'A', text: 'Early numbers show completion going up from sixty one to, uh, sixty eight percent.', gapAfter: 0.8 },
  { kind: 'retake', group: 'A', text: 'Early numbers show completion going from sixty one percent to sixty eight percent.', gapAfter: 0.6 },
  { kind: 'normal', text: 'Which is a pretty good jump for one week, you know.', gapAfter: 2.5 },
  { kind: 'normal', text: 'Next, the billing page.', gapAfter: 0.7 },
  { kind: 'retake', group: 'B', text: 'The redesign is blocked on the, um, the tax calculation thing.', gapAfter: 0.5 },
  { kind: 'aside', text: 'Wait, let me redo that.', gapAfter: 0.9 },
  { kind: 'retake', group: 'B', text: 'The redesign is blocked on the tax service, which the platform team owns.', gapAfter: 0.6 },
  { kind: 'normal', text: 'They said it should be fixed by the end of next week, so, like, we are waiting on that.', gapAfter: 0.7 },
  { kind: 'false_start', text: 'And in the mean', gapAfter: 0.4 },
  { kind: 'normal', text: 'And in the meantime Priya is building the empty states and the error messages.', gapAfter: 3.0 },
  { kind: 'normal', text: 'Okay, hiring.', gapAfter: 0.6 },
  { kind: 'retake', group: 'C', text: 'We have two open roles, a senior product designer and a, um, a design researcher.', gapAfter: 0.7 },
  { kind: 'retake', group: 'C', text: 'We have two open roles, a senior product designer and a researcher.', gapAfter: 0.8 },
  { kind: 'retake', group: 'C', text: 'We have two open roles. One senior product designer and one design researcher.', gapAfter: 0.6 },
  { kind: 'normal', text: 'Interviews start on the twentieth, and I would really like everyone to sign up for at least one panel.', gapAfter: 6.0 },
  { kind: 'aside', text: 'Sorry, hang on, I lost my notes. Okay.', gapAfter: 0.8 },
  { kind: 'normal', text: 'Last thing, the offsite.', gapAfter: 0.6 },
  { kind: 'false_start', text: 'The offsite is on', gapAfter: 0.5 },
  { kind: 'retake', group: 'D', text: 'The offsite is on the fourth of December, and we are, uh, booking the room now.', gapAfter: 0.7 },
  { kind: 'retake', group: 'D', text: 'The offsite is on the fourth of December, and the room is booked.', gapAfter: 0.6 },
  { kind: 'normal', text: 'Please send me any topics you want to cover by Friday.', gapAfter: 2.2 },
  { kind: 'normal', text: 'Um, I think that is everything. Thanks, everyone, talk soon.', gapAfter: 0 },
];

/** Split a line into word tokens: {text (as written, with punctuation), norm (lower case, letters only)}. */
export function tokenize(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ({ text: w, norm: normWord(w) }))
    .filter((w) => w.norm.length > 0);
}

export function normWord(w) {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '');
}

/** Filler words / phrases present in a line (by normalized token match). */
export function fillersIn(text) {
  const norms = tokenize(text).map((t) => t.norm);
  const found = [];
  for (const f of FILLERS) {
    const parts = f.split(' ');
    for (let i = 0; i + parts.length <= norms.length; i++) {
      if (parts.every((p, k) => norms[i + k] === p)) found.push({ filler: f, wordIndex: i });
    }
  }
  return found.sort((a, b) => a.wordIndex - b.wordIndex);
}

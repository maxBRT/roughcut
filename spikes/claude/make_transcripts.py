"""Generate the synthetic test transcripts for the Claude spike.

Writes, under data/:
  transcript-150.json   ~150 utterances (~15 min) in the spec 3.4 Transcript shape
  ground-truth-150.json the planted retakes, false starts and asides (kept apart)
  transcript-600.json   ~600 utterances (~1 h): four "weeks" of the same show with
                        numbers and names changed, for size and time measurement
  ground-truth-600.json

The script is a weekly update by a solo developer of a habit-tracking app.
Planted problems:
  R(...)  retake: same line said several times; earlier attempts are cut, last kept
  F(a, b) false start inside one utterance: "a" abandoned, then "b"; "a" is cut
  A(bad, aside, good) aside that refers to a bad take: bad take + aside cut, good kept
  X(aside) aside on its own (talking to yourself / off-script): cut
Decoys that must NOT be suggested: deliberate repetition for emphasis ("Never."),
long silences (dead air is found locally, not by Claude), filler words.

Deterministic: fixed random seed.
"""
import json
import random
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"


def S(text, pause=None):
    return ("S", text, pause)


def R(*attempts):
    return ("R", list(attempts))


def F(abandoned, restart):
    return ("F", abandoned, restart)


def A(bad, aside, good):
    return ("A", bad, aside, good)


def X(aside):
    return ("X", aside)


SCRIPT = [
    S("Hey everyone, welcome back to the weekly {app} update."),
    S("If you're new here, {app} is the little habit tracker I've been building on my own for about a year and a half now."),
    S("This week was a big one, so I'm going to go through what shipped, what broke, and what's coming next."),
    R("So the headline this week is that sync is finally out of beta.",
      "So the headline this week is that sync is, um, finally",
      "So the headline this week is that sync is finally out of beta and it's on for everyone."),
    S("That's been about four months of work, and honestly most of it was stuff nobody will ever see."),
    S("Conflict handling, retries, what happens when your phone is offline for three days and then comes back."),
    F("And the reason that took so long is that the",
      "the reason it took so long is that every edge case turned out to have another edge case inside it."),
    S("Like, you'd fix one thing and two more would pop up."),
    S("But it's done, it's stable, and the crash rate on sync is now basically zero."),
    S("I've had it running on six of my own devices for a month and it hasn't lost a single check-in."),
    S("Okay, let's look at the numbers."),
    S("Last week we had about {users_prev} active users."),
    S("This week it's just over {users}, so that's a nice bump.", 2.0),
    A("And paid subscribers went from {paid_prev} to, uh, nine hundred and, no, wait.",
      "Hang on, let me check that number, I think I have it wrong. Okay. Let me redo that.",
      "Paid subscribers went from {paid_prev} to {paid}."),
    S("Which is the biggest jump we've had since launch."),
    S("And I think a lot of that is sync, because sync was the number one request in every survey we've run."),
    S("People want their streaks on their phone and their tablet, and that's fair."),
    S("Retention is also up a little."),
    R("Thirty day retention is at forty one percent, which.",
      "Thirty-day retention went from thirty-eight to forty-one percent, which for a habit app is actually really good."),
    S("Most habit apps lose almost everyone in the first two weeks."),
    S("That's kind of the dirty secret of this category."),
    S("Everyone downloads one in January and then forgets about it by Valentine's day.", 6.5),
    S("Alright, next thing."),
    S("What broke."),
    S("So on Tuesday we pushed version {version}, and about an hour later the support inbox just lit up."),
    F("The widget, the home screen widget was",
      "the home screen widget was showing yesterday's streak instead of today's."),
    S("It turned out to be a time zone bug, which, of course it was."),
    S("It's always time zones."),
    S("If you were east of UTC, the widget thought it was still the previous day for a few hours after midnight."),
    S("We had a fix out the same evening, so if you still see it, just update the app."),
    S("And I'm sorry about that, I know a broken streak counter is about the most annoying thing a habit app can do."),
    X("Is the light still okay? It looks like the sun's moving. Yeah, it's fine, keep going."),
    S("So, lessons learned."),
    S("We now have tests that run the widget in about twenty different time zones before every release."),
    S("Which we should have had from the start, but here we are."),
    S("Okay, let's talk about the redesign."),
    S("A lot of you have seen the screenshots I posted on {day}."),
    R("The new home screen puts your habits for today right at the top, and then",
      "The new home screen puts today's habits right at the top.",
      "The new home screen puts today's habits right at the top, and everything else moves into a separate tab."),
    S("The idea is that when you open the app, the first thing you see is what you still need to do."),
    S("Not a chart, not a calendar, just today."),
    S("The feedback has been mostly positive."),
    S("A few people really miss the calendar view, so that's not going away, it's just one tap further."),
    F("And I want to be, I want to be",
      "I want to be clear that nothing is being removed, it's just being moved."),
    S("I know how people get when an app they use every day suddenly changes."),
    S("I'm the same way."),
    S("So the redesign will ship behind a setting first, and you can switch back for at least a couple of months."),
    S("Then we'll look at the numbers and decide."),
    A("Speaking of numbers, the beta has about four hundred people in it and the, the",
      "Ugh, sorry. Okay, starting over from the beta part.",
      "Speaking of numbers, the redesign beta has about {beta} people in it right now."),
    S("And if you want in, there's a link in the description."),
    S("Just know that it's a beta, so things will be a bit rough."),
    S("Some screens still have placeholder text, and dark mode is, let's say, a work in progress."),
    S("Alright."),
    S("Next up is the thing I've been most nervous about, which is pricing."),
    S("Right now {app} is three dollars a month or twenty-four dollars a year."),
    S("That price hasn't changed since launch."),
    R("And starting next month, the yearly price is going up to thirty dollars for new subscribers.",
      "Starting next month, the yearly price goes up to thirty dollars, but only for new subscribers."),
    S("If you're already subscribed, your price stays exactly where it is, for as long as you stay subscribed."),
    S("I really want to be clear about that."),
    S("The monthly price stays at three dollars for everyone."),
    F("The reason we're doing it is, um, it's mostly",
      "the reason is mostly server costs, which have more than doubled since sync launched."),
    S("Sync means every change you make is stored and sent to all your devices."),
    S("That's a lot more traffic than the old app, which just kept everything on your phone."),
    S("And I'd rather charge a little more than put ads in the app, which I am never going to do."),
    S("Never."),
    S("Not even a little banner.", 5.2),
    X("What's next on my list? Oh, the Android stuff. Okay."),
    S("Android."),
    S("A lot of you have asked when the Android version gets sync."),
    R("The answer is, it should be about three weeks behind iOS.",
      "The honest answer is, it's about three weeks behind iOS, maybe four."),
    S("The sync engine itself is shared, so that part's done."),
    S("What's left is mostly the background work, because Android is a lot stricter about what apps can do when they're closed."),
    S("And I want to get that right, because a sync that only works when the app is open isn't really sync."),
    S("Then there's the Wear OS app."),
    S("That one I'm less sure about."),
    S("It's maybe two percent of users, but they're very, very loud."),
    S("In a good way."),
    S("I love you, watch people."),
    S("It'll happen, I just can't promise a date."),
    S("Okay, community stuff."),
    S("The thirty day challenge we started in {month} finished last week."),
    S("Almost {challengers} people signed up, which completely blew me away."),
    F("And of those, um, of the people who",
      "of the people who finished, more than half said they're keeping the habit going."),
    S("Which is the whole point."),
    S("The most popular habits were reading, walking, and drinking more water."),
    S("And somebody tracked not checking their phone before nine in the morning, which I think I need to try."),
    S("I'll probably fail, but I'll try."),
    R("We're going to run another one in January, and this time there will be, uh, teams.",
      "We're running another one in January, and this time you can join as a team."),
    S("So you can do it with friends or coworkers and see each other's streaks."),
    S("Only if everyone opts in, obviously."),
    S("Privacy-wise, nothing is shared unless you choose to share it."),
    A("Now, a quick word about the support side, because the inbox has been, it's been",
      "No, that sounds too negative. Let me say that again.",
      "Now, a quick word about support, because the inbox has been really busy since sync launched."),
    S("I read every email myself."),
    S("That's still true, but replies are taking a day or two longer than usual."),
    S("So if you wrote in and haven't heard back yet, you will."),
    S("I'm also adding a help page that answers the ten most common questions."),
    S("About half the emails are the same three questions, so that should help a lot."),
    S("Okay, let's do a couple of questions from the comments."),
    S("First one is from {q1}."),
    S("She asks whether {app} will ever have a web version."),
    F("Short answer, I don't, I'm not",
      "short answer, not this year."),
    S("The longer answer is that with sync done, a web version is a lot more realistic than it used to be."),
    S("It's on the list, it's just not near the top."),
    S("Second question is from {q2}."),
    R("He asks if there's a way to export his data.",
      "He asks if there's a way to export all his data, like to a spreadsheet."),
    S("And yes, there is."),
    S("It's in settings, under your account, and it gives you a CSV file with every check-in you've ever made."),
    S("It's your data, you should be able to take it with you."),
    X("Sorry, my neighbor's doing construction, give me a second. Okay, it stopped."),
    S("Last question is from someone called night owl twenty-two."),
    S("They ask whether I ever take a break from working on the app."),
    S("And, honestly, not as much as I should."),
    S("But I took last weekend completely off, no laptop, and it was great."),
    S("I'm going to try to do that more."),
    R("So, wrapping up.",
      "Okay, so, to wrap up."),
    S("Sync is out for everyone on iOS, Android follows in about three weeks."),
    S("The redesign is in beta, with a link below."),
    S("Prices go up a little for new yearly subscribers next month, existing subscribers aren't affected."),
    S("And the next community challenge starts in January, with teams."),
    S("Thank you all for being here."),
    S("Seriously, {users} people using something I built in my spare room is still kind of unbelievable to me."),
    R("See you next week, bye.",
      "I'll see you next week. Bye!"),
]

# Extra clean lines inserted to bring the 15-minute fixture to ~150 utterances.
EXTRA_AFTER = {
    "Like, you'd fix one thing and two more would pop up.": [
        "At one point I had a whiteboard with forty sticky notes on it, each one a different way two phones could disagree.",
        "My partner started calling it the conspiracy wall.",
    ],
    "Most habit apps lose almost everyone in the first two weeks.": [
        "I don't have exact numbers for the whole industry, but the studies I've read put it well under twenty percent.",
    ],
    "It's always time zones.": [
        "Every developer watching this is nodding right now.",
    ],
    "Not a chart, not a calendar, just today.": [
        "Charts are great, but they're for Sunday evening, not for Tuesday morning.",
    ],
    "That price hasn't changed since launch.": [
        "And in that time pretty much everything I pay for to run it has gone up.",
    ],
    "In a good way.": [
        "Their emails are the most detailed bug reports I get, honestly.",
    ],
    "Which is the whole point.": [
        "The app is only a tool, the habit is the thing that matters.",
    ],
    "I read every email myself.": [
        "There's no support team, it's just me and a very large mug of coffee.",
    ],
    "It's on the list, it's just not near the top.": [
        "If you really want it, tell me, because the list is basically ordered by how many of you ask.",
    ],
    "But I took last weekend completely off, no laptop, and it was great.": [
        "I went hiking, I read a whole book, and I didn't open the analytics dashboard once.",
        "Okay, I opened it once. On Sunday night.",
    ],
    "The redesign is in beta, with a link below.": [
        "Please do send feedback, even if it's just that you hate it.",
    ],
}

WEEKS = [
    dict(app="Tally", users_prev="eleven thousand four hundred", users="twelve thousand",
         paid_prev="eight hundred and ten", paid="eight hundred and ninety-four",
         version="three point two", day="Thursday", beta="four hundred", month="October",
         challengers="three thousand", q1="Priya", q2="Marco"),
    dict(app="Tally", users_prev="twelve thousand", users="twelve thousand six hundred",
         paid_prev="eight hundred and ninety-four", paid="nine hundred and forty",
         version="three point three", day="Monday", beta="five hundred", month="November",
         challengers="three thousand two hundred", q1="Hannah", q2="Tomasz"),
    dict(app="Tally", users_prev="twelve thousand six hundred", users="thirteen thousand",
         paid_prev="nine hundred and forty", paid="nine hundred and ninety",
         version="three point four", day="Wednesday", beta="six hundred", month="the spring",
         challengers="three thousand five hundred", q1="Aiko", q2="Dev"),
    dict(app="Tally", users_prev="thirteen thousand", users="thirteen thousand eight hundred",
         paid_prev="nine hundred and ninety", paid="one thousand and fifty",
         version="three point five", day="Friday", beta="seven hundred", month="the summer",
         challengers="four thousand", q1="Lucia", q2="Sam"),
]

WORDS_PER_SECOND = 2.7
MICRO = 1_000_000


def words_of(text):
    return text.split()


def expand(script):
    """Flatten the script into (text, kind_label, pause_override, group) records."""
    out = []
    for item in script:
        kind = item[0]
        if kind == "S":
            out.append(dict(text=item[1], role="clean", pause=item[2]))
            for extra in EXTRA_AFTER.get(item[1], []):
                out.append(dict(text=extra, role="clean", pause=None))
        elif kind == "R":
            attempts = item[1]
            for i, a in enumerate(attempts):
                last = i == len(attempts) - 1
                out.append(dict(text=a, role="retake_keep" if last else "retake_cut",
                                pause=None if last else random.uniform(1.3, 2.6)))
        elif kind == "F":
            out.append(dict(text=item[1] + " " + item[2], role="false_start",
                            abandoned=item[1], pause=None))
        elif kind == "A":
            out.append(dict(text=item[1], role="aside_bad_take", pause=random.uniform(1.0, 2.0)))
            out.append(dict(text=item[2], role="aside", pause=random.uniform(1.5, 3.0)))
            out.append(dict(text=item[3], role="aside_keep", pause=None))
        elif kind == "X":
            out.append(dict(text=item[1], role="aside_alone", pause=random.uniform(1.5, 3.0)))
    return out


def build(weeks, seed):
    random.seed(seed)
    utterances = []
    truth = []
    t = 2.4  # recording starts with a little silence
    index = 0
    for w, values in enumerate(weeks):
        records = expand(SCRIPT)
        records = [dict(r, text=r["text"].format(**values),
                        abandoned=r.get("abandoned", "").format(**values)) for r in records]
        first_index_of_week = index + 1
        for r in records:
            index += 1
            words = words_of(r["text"])
            dur = len(words) / WORDS_PER_SECOND * random.uniform(0.9, 1.1) + 0.15
            start, end = t, t + dur
            pause = r["pause"] if r["pause"] is not None else random.uniform(0.35, 1.3)
            # word tokens with even spacing inside the utterance (enough for this spike)
            tokens = []
            step = dur / len(words)
            for k, word in enumerate(words):
                ws = start + k * step
                tokens.append(dict(kind="word", text=word,
                                   start=round(ws * MICRO), end=round((ws + step * 0.85) * MICRO),
                                   cutBefore=round(ws * MICRO)))
            utterances.append(dict(index=index, start=round(start * MICRO), end=round(end * MICRO),
                                   tokens=tokens, _role=r["role"], _abandoned=r.get("abandoned", "")))
            t = end + pause
        # ground truth from roles
        week_utts = [u for u in utterances if u["index"] >= first_index_of_week]
        i = 0
        while i < len(week_utts):
            u = week_utts[i]
            role = u["_role"]
            text = " ".join(tok["text"] for tok in u["tokens"])
            if role == "retake_cut":
                j = i
                while week_utts[j]["_role"] == "retake_cut":
                    j += 1
                cut = week_utts[i:j]
                truth.append(dict(kind="retake", first_utterance=cut[0]["index"],
                                  last_utterance=cut[-1]["index"],
                                  quote=" ".join(" ".join(tk["text"] for tk in c["tokens"]) for c in cut),
                                  keep_utterance=week_utts[j]["index"]))
                i = j
                continue
            if role == "false_start":
                truth.append(dict(kind="false_start", first_utterance=u["index"],
                                  last_utterance=u["index"], quote=u["_abandoned"]))
            if role == "aside_bad_take":
                aside = week_utts[i + 1]
                keep = week_utts[i + 2]
                truth.append(dict(kind="aside", first_utterance=u["index"],
                                  last_utterance=aside["index"],
                                  quote=text + " " + " ".join(tk["text"] for tk in aside["tokens"]),
                                  keep_utterance=keep["index"]))
                i += 2
                continue
            if role == "aside_alone":
                truth.append(dict(kind="aside", first_utterance=u["index"],
                                  last_utterance=u["index"], quote=text))
            i += 1
    for u in utterances:
        u.pop("_role")
        u.pop("_abandoned")
    transcript = dict(schemaVersion=1, sourceId="spike-synthetic", model="synthetic (hand-written script)",
                      complete=True, utterances=utterances)
    return transcript, truth


def main():
    DATA.mkdir(exist_ok=True)
    for name, weeks, seed in (("150", WEEKS[:1], 150), ("600", WEEKS, 600)):
        transcript, truth = build(weeks, seed)
        (DATA / f"transcript-{name}.json").write_text(json.dumps(transcript, indent=1), encoding="utf-8")
        (DATA / f"ground-truth-{name}.json").write_text(json.dumps(truth, indent=1), encoding="utf-8")
        last = transcript["utterances"][-1]
        kinds = {}
        for g in truth:
            kinds[g["kind"]] = kinds.get(g["kind"], 0) + 1
        print(f"{name}: {len(transcript['utterances'])} utterances, "
              f"{last['end'] / MICRO / 60:.1f} min, planted {kinds}")


if __name__ == "__main__":
    main()
